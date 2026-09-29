import type { InitializeParams, Diagnostic as LspDiagnostic } from 'vscode-languageserver'

import type { CliIo, CliWritable } from '../../types'
import type { FolderSession } from './folder'

import { Writable } from 'node:stream'

import { errorMessageFrom } from '@moeru/std'
import { DidChangeWatchedFilesNotification } from 'vscode-languageserver'

import { CLEAR_CACHE_COMMAND, RUN_FILE_COMMAND, RUN_WORKSPACE_COMMAND } from './command-ids'
import { createFolderSession } from './folder'
import { createPublisher } from './publisher'

/** Long enough to collect a workspace pass into few messages, short enough to keep a save prompt. */
const PUBLISH_FLUSH_MS = 200

export async function startLspServer(io: CliIo): Promise<number> {
  const { stdin } = io

  if (!stdin) {
    io.stderr.write('alint lsp needs a readable stdin to speak JSON-RPC over.\n')
    return 2
  }

  // NOTICE: the import is dynamic for two reasons. It keeps the protocol stack out of the start-up
  // of every other command. And `vscode-languageserver/node` is CommonJS that re-exports its
  // protocol package with `__exportStar`
  // (`packages/cli/node_modules/vscode-languageserver/lib/node/main.js`). A namespace import reads
  // those names at run time; a static named import needs cjs-module-lexer to resolve the star.
  const { createConnection, TextDocumentSyncKind } = await import('vscode-languageserver/node')
  const connection = createConnection(stdin, toWritableStream(io.stdout))
  const folders = new Map<string, FolderSession>()
  // The folders the client has open. A session loads asynchronously, so this set, not `folders`,
  // says whether a session that finished loading is still wanted.
  const openFolderUris = new Set<string>()
  let receivesFolderChanges = false
  let watchesFiles = false

  /** A document belongs to one folder at most, so the first folder that holds it is the owner. */
  const diagnosticsFor = (uri: string): LspDiagnostic[] => {
    for (const folder of folders.values()) {
      const diagnostics = folder.diagnostics.get(uri)

      if (diagnostics) {
        return diagnostics
      }
    }

    // An empty list is not a failure. It clears what the editor still shows for the document.
    return []
  }

  const publisher = createPublisher({
    flushMs: PUBLISH_FLUSH_MS,
    publish: uri => connection.sendDiagnostics({ diagnostics: diagnosticsFor(uri), uri }),
  })

  const openFolder = async (folderUri: string): Promise<void> => {
    try {
      const folder = await createFolderSession({
        folderUri,
        io,
        onChanged: uris => uris.forEach(publisher.queue),
      })

      // The client can remove the folder, or remove and add it again, while the session loads.
      if (!openFolderUris.has(folderUri) || folders.has(folderUri)) {
        await folder.dispose()
        return
      }

      folders.set(folderUri, folder)

      await folder.refreshFromCache()

      for (const uri of folder.diagnostics.keys()) {
        publisher.queue(uri)
      }
    }
    catch (error) {
      // A handler that throws ends the session. One folder with a bad config must not stop the
      // other folders.
      connection.console.error(
        `${folderUri}: ${errorMessageFrom(error) ?? 'could not read cached diagnostics'}`,
      )
    }
  }

  const closeFolder = async (folderUri: string): Promise<void> => {
    openFolderUris.delete(folderUri)

    const folder = folders.get(folderUri)

    if (!folder) {
      return
    }

    folders.delete(folderUri)

    // Publish the folder's documents again. They get the diagnostics of another folder that holds
    // them, or an empty list.
    for (const uri of folder.diagnostics.keys()) {
      publisher.queue(uri)
    }

    try {
      // Disposal stops the ACP gateway. Without it, the port and its child processes stay open.
      await folder.dispose()
    }
    catch (error) {
      connection.console.error(`${folderUri}: ${errorMessageFrom(error) ?? 'could not close the folder'}`)
    }
  }

  connection.onInitialize((params) => {
    for (const folderUri of resolveFolderUris(params)) {
      openFolderUris.add(folderUri)
    }

    receivesFolderChanges = params.capabilities.workspace?.workspaceFolders === true
    watchesFiles = params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration === true

    return {
      capabilities: {
        executeCommandProvider: {
          commands: [CLEAR_CACHE_COMMAND, RUN_FILE_COMMAND, RUN_WORKSPACE_COMMAND],
          workDoneProgress: true,
        },
        // `change: None` is intended. A diagnostic is keyed by the target content, so diagnostics
        // for an edited region stay stale until the user saves the file.
        textDocumentSync: {
          change: TextDocumentSyncKind.None,
          openClose: true,
          save: true,
        },
        workspace: {
          workspaceFolders: { changeNotifications: true, supported: true },
        },
      },
    }
  })

  // The client accepts no notification before `initialized`.
  connection.onInitialized(() => {
    if (watchesFiles) {
      // A static server capability cannot carry a glob, so the watcher is registered here. A
      // client without dynamic registration reports no changes.
      //
      // The glob covers every file. A config `files` entry can nest pattern lists, negate them,
      // and set a `basePath`, and a watcher glob can express none of that. Each folder filters the
      // events with the matcher that discovery uses instead.
      void connection.client.register(DidChangeWatchedFilesNotification.type, {
        watchers: [{ globPattern: '**/*' }],
      })
    }

    if (receivesFolderChanges) {
      // NOTICE: this getter throws for a client that did not declare `workspace.workspaceFolders`.
      // `packages/cli/node_modules/vscode-languageserver/lib/common/workspaceFolder.js:36-43`
      connection.workspace.onDidChangeWorkspaceFolders(({ added, removed }) => {
        for (const { uri } of removed) {
          void closeFolder(uri)
        }

        for (const { uri } of added) {
          if (isFileUri(uri) && !openFolderUris.has(uri)) {
            openFolderUris.add(uri)
            void openFolder(uri)
          }
        }
      })
    }

    for (const folderUri of openFolderUris) {
      void openFolder(folderUri)
    }
  })

  // A saved file is on disk, so the pass reads it and the client sends no text.
  connection.onDidSaveTextDocument(({ textDocument }) => {
    void Promise.all([...folders.values()].map(async (folder) => {
      try {
        for (const uri of await folder.refreshFile(textDocument.uri)) {
          publisher.queue(uri)
        }
      }
      catch (error) {
        connection.console.error(
          `${textDocument.uri}: ${errorMessageFrom(error) ?? 'could not refresh the saved file'}`,
        )
      }
    }))
  })

  // Opening a file starts no run. The last pass already put its diagnostics in the map.
  connection.onDidOpenTextDocument(({ textDocument }) => {
    publisher.setOpen(textDocument.uri, true)
    publisher.queue(textDocument.uri)
  })

  // A closed document keeps its diagnostics. Only its order in a flush changes.
  connection.onDidCloseTextDocument(({ textDocument }) => {
    publisher.setOpen(textDocument.uri, false)
  })

  connection.onExecuteCommand(async ({ arguments: args, command }) => {
    if (command === CLEAR_CACHE_COMMAND) {
      await Promise.all([...folders.values()].map(async (folder) => {
        try {
          for (const uri of await folder.clearCache()) {
            publisher.queue(uri)
          }
        }
        catch (error) {
          connection.console.error(
            `${folder.folderUri}: ${errorMessageFrom(error) ?? 'could not clear the cache'}`,
          )
        }
      }))

      return
    }

    // The client sends the active document URI as the command argument.
    const inputs = command === RUN_FILE_COMMAND
      ? args?.filter((value): value is string => typeof value === 'string')
      : undefined

    if (command === RUN_FILE_COMMAND && (inputs === undefined || inputs.length === 0)) {
      connection.console.error(`${RUN_FILE_COMMAND} needs a document URI.`)
      return
    }

    // `createWorkDoneProgress` sends a request and waits for the client to answer. The run does
    // not start before that answer arrives.
    //
    // A client that does not advertise `window.workDoneProgress` gets a reporter that sends
    // nothing. No capability check is needed, and that client cannot cancel.
    const reporter = await connection.window.createWorkDoneProgress()
    const controller = new AbortController()

    reporter.begin(
      inputs === undefined ? 'Running alint on the workspace' : 'Running alint on the current file',
      0,
      undefined,
      true,
    )
    reporter.token.onCancellationRequested(() => controller.abort())

    try {
      await Promise.all([...folders.values()].map(async (folder) => {
        try {
          await folder.runExplicit({
            inputs,
            onProgress: (progress, inputPath) => {
              // `jobsTotal` is 0 until planning finishes, and the run reports jobs before then.
              const percentage = progress.jobsTotal === 0
                ? 0
                : Math.round((progress.jobsCompleted / progress.jobsTotal) * 100)

              reporter.report(percentage, inputPath)
            },
            signal: controller.signal,
          })
        }
        catch (error) {
          connection.console.error(
            `${folder.folderUri}: ${errorMessageFrom(error) ?? 'the run failed'}`,
          )
        }
      }))
    }
    finally {
      // A run that throws must still end the notification, or the client shows it forever.
      reporter.done()
    }
  })

  connection.onDidChangeWatchedFiles(({ changes }) => {
    let configChanged = false

    for (const folder of folders.values()) {
      const uris = changes.map(change => change.uri).filter(uri => folder.contains(uri))

      if (uris.length === 0) {
        continue
      }

      if (!uris.some(isConfigFile)) {
        folder.scheduleFilesPass(uris)
        continue
      }

      // The workspace pass after the reload reads every file, including the others in this batch.
      configChanged = true
      void (async () => {
        try {
          await folder.reloadConfig()
          folder.scheduleWorkspacePass()
        }
        catch (error) {
          connection.console.error(
            `${folder.folderUri}: ${errorMessageFrom(error) ?? 'could not reload the config'}`,
          )
        }
      })()
    }

    if (configChanged) {
      // A new config changes `configHash` for every affected target, so the pass that follows
      // finds nothing and the editor empties. The result is correct but it looks like a failure.
      // TODO: send an `alint/status` notification with the skipped count instead of this log line.
      connection.console.info('Configuration changed. Cached diagnostics were cleared. Run alint again to recreate them.')
    }
  })

  connection.onShutdown(async () => {
    publisher.dispose()
    // Disposal stops the ACP gateway. Without it, the port and its child processes stay open.
    await Promise.all([...folders.values()].map(folder => folder.dispose()))
    folders.clear()
  })

  connection.listen()

  // NOTICE: this promise rarely resolves. `vscode-languageserver` answers the `exit` notification
  // with `process.exit`
  // (`packages/cli/node_modules/vscode-languageserver/lib/node/main.js:136-139`).
  //
  // It must stay pending. If it resolves, `executeCli` returns and restores console output to
  // stdout, and a rule that logs then corrupts the JSON-RPC stream.
  return new Promise<number>((resolve) => {
    connection.onExit(() => resolve(0))
  })
}

/** The root config and nested configs use the same `alint.config.*` file names. */
function isConfigFile(uri: string): boolean {
  return /\/alint\.config\.[^/]+$/.test(uri)
}

/** Only a `file:` URI has a directory. A remote or untitled root has no cwd and no cache. */
function isFileUri(uri: string): boolean {
  return uri.startsWith('file://')
}

/** A client can send `workspaceFolders`, the older `rootUri`, or both. The caller dedupes. */
function resolveFolderUris(params: InitializeParams): string[] {
  const uris = params.workspaceFolders?.map(folder => folder.uri)
    ?? (params.rootUri === null ? [] : [params.rootUri])

  return uris.filter(isFileUri)
}

/**
 * Adapts the CLI string output to the byte stream that `createConnection` requires.
 *
 * `String(chunk)` cannot split a UTF-8 sequence here. The message writer sends one ASCII header,
 * then one complete body, so every chunk is whole.
 */
function toWritableStream(sink: CliWritable): Writable {
  return new Writable({
    write(chunk: unknown, _encoding, callback) {
      sink.write(String(chunk))
      callback()
    },
  })
}

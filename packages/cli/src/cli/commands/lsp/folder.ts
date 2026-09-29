import type { ProgressSnapshot, RunResult } from '@alint-js/core'
import type { Diagnostic as LspDiagnostic } from 'vscode-languageserver'

import type { RunSession } from '../../runtime/session'
import type { CliIo } from '../../types'

import { realpath, rm } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { AlintRunCancelledError, AlintRunError, matchesDiscoveryFile } from '@alint-js/core'
import { errorMessageFrom } from '@moeru/std'

import { createRunSession } from '../../runtime/session'
import { statPath } from '../lint/discovery'
import { toLspDiagnostic } from './diagnostics'

/** A config write or a checkout arrives as many filesystem events. Wait for them before a pass. */
const PASS_DEBOUNCE_MS = 500

export interface CreateFolderSessionOptions {
  folderUri: string
  io: CliIo
  /** Receives document URIs, ready to publish. */
  onChanged?: (uris: string[]) => void
}

export interface FolderSession {
  /**
   * Deletes the cache file and drops every diagnostic. Returns the document URIs to publish.
   *
   * This throws away diagnostics the user paid for. Only an explicit run can produce them again.
   */
  clearCache: () => Promise<string[]>
  /** Whether the URI names a path inside this folder. The folder itself is not inside. */
  contains: (uri: string) => boolean
  cwd: string
  /** Document URI to its diagnostics. A workspace pass replaces the whole map. */
  readonly diagnostics: ReadonlyMap<string, LspDiagnostic[]>
  dispose: () => Promise<void>
  folderUri: string
  /**
   * Re-reads one file and returns the document URIs to publish.
   *
   * A returned URI can have no diagnostics left, and then the map holds no entry for it. This is
   * the usual result after an edit: the changed target misses the cache and its job is skipped.
   * The caller must publish the empty list, or the editor keeps showing the old diagnostics.
   */
  refreshFile: (uri: string) => Promise<string[]>
  refreshFromCache: () => Promise<void>
  /** Builds a new run session, which is how the config on disk is re-read. */
  reloadConfig: () => Promise<void>
  /**
   * Runs the rules and calls models. This is the only path that spends tokens.
   *
   * Pass no inputs to run the whole folder. Pass document URIs to run only those files, without
   * project rules.
   *
   * One folder runs one set of rules at a time. The cache file is rewritten whole, so two runs at
   * once discard each other's results.
   */
  runExplicit: (options: RunExplicitOptions) => Promise<void>
  /**
   * Requests a pass over files that changed on disk. Requests that arrive together produce one
   * pass, which reports its document URIs through `onChanged`.
   *
   * A path that no longer exists loses its diagnostics, and so does every path under it.
   */
  scheduleFilesPass: (uris: string[]) => void
  /** Requests a whole-workspace pass. Requests that arrive together produce one pass. */
  scheduleWorkspacePass: () => void
}

export interface RunExplicitOptions {
  inputs?: string[]
  /** Called as each job starts, with the run totals and the file that job reads. */
  onProgress?: (progress: ProgressSnapshot, inputPath: string) => void
  signal?: AbortSignal
}

/**
 * One workspace folder. It keeps two paths, and they are not interchangeable.
 *
 * Runs use `cwd`, the resolved path, because `process.cwd()` is always canonical and the lint
 * command therefore always runs under a resolved path. Under any other path each target gets a
 * different identity: the cache file is found, no entry matches, and no error is reported.
 *
 * Published diagnostics use `folderPath`, the path the client sent. See `toDocumentUri`.
 */
export async function createFolderSession(
  options: CreateFolderSessionOptions,
): Promise<FolderSession> {
  const folderPath = fileURLToPath(options.folderUri)
  const cwd = await realpath(folderPath)
  const runIo = { ...options.io, cwd }
  const paths = { cwd, folderPath }
  let session = await createRunSession(runIo)
  let diagnostics: Map<string, LspDiagnostic[]> = new Map()
  let scheduled: ReturnType<typeof setTimeout> | undefined
  let explicitRun: Promise<void> = Promise.resolve()
  let explicitRunning = false
  // Run paths reported since the last files pass.
  const changedPaths = new Set<string>()
  let filesScheduled: ReturnType<typeof setTimeout> | undefined
  // Files passes run one at a time. Two at once can finish out of order, and the older read wins.
  let filesPass: Promise<void> = Promise.resolve()

  const replaceMap = (next: Map<string, LspDiagnostic[]>): string[] => {
    // A document that lost its last diagnostic must still be published, as an empty list.
    const changed = new Set([...next.keys(), ...diagnostics.keys()])
    diagnostics = next

    return [...changed]
  }

  /**
   * Reads files from the cache and replaces their entries. Returns the document URIs to publish.
   *
   * A file whose diagnostics all disappear loses its entry, and its URI is still returned.
   */
  const readFiles = async (filePaths: string[]): Promise<string[]> => {
    const found = groupByUri(await runFromCache(session, { inputs: filePaths }), paths)
    const changed = new Set([...found.keys()])

    // The pass covers these files, so only their entries may be dropped.
    for (const filePath of filePaths) {
      const documentUri = toDocumentUri(filePath, paths)

      if (!found.has(documentUri) && diagnostics.delete(documentUri)) {
        changed.add(documentUri)
      }
    }

    for (const [key, value] of found) {
      diagnostics.set(key, value)
    }

    return [...changed]
  }

  /** Drops the entry for a deleted path, and every entry under it if it was a directory. */
  const dropDeleted = (filePath: string): string[] => {
    const documentUri = toDocumentUri(filePath, paths)
    const dropped = [...diagnostics.keys()]
      .filter(uri => uri === documentUri || uri.startsWith(`${documentUri}/`))

    for (const uri of dropped) {
      diagnostics.delete(uri)
    }

    return dropped
  }

  const runFilesPass = async (): Promise<void> => {
    // A cache read during an explicit run publishes older values over the ones the run streams.
    // The pass waits instead of being dropped, because the run does not re-read changed files.
    // A run queued during the wait replaces `explicitRun`, so wait again until none was queued.
    let queued: Promise<void>

    do {
      queued = explicitRun
      await queued.catch(() => {})
    } while (queued !== explicitRun)

    const filePaths = [...changedPaths]
    const changed = new Set<string>()
    const readable: string[] = []

    changedPaths.clear()

    for (const filePath of filePaths) {
      // The disk decides, not the event type. A burst can report a file as deleted and then as
      // created again.
      const stats = await statPath(filePath)

      if (stats === undefined) {
        for (const uri of dropDeleted(filePath)) {
          changed.add(uri)
        }

        continue
      }

      // A directory has no diagnostics of its own. Its files are read when an event names them,
      // or by the next workspace pass.
      if (!stats.isFile()) {
        continue
      }

      // The client reports every file in the folder. Read the files the workspace pass lints, and
      // files that have diagnostics, because a project rule can report a file that discovery skips.
      const discovered = matchesDiscoveryFile(
        relative(cwd, filePath).replaceAll('\\', '/'),
        session.config,
        { cwd },
      )

      if (discovered || diagnostics.has(toDocumentUri(filePath, paths))) {
        readable.push(filePath)
      }
    }

    if (readable.length > 0) {
      for (const uri of await readFiles(readable)) {
        changed.add(uri)
      }
    }

    if (changed.size > 0) {
      options.onChanged?.([...changed])
    }
  }

  const runOnce = async (runOptions: RunExplicitOptions): Promise<void> => {
    const runPaths = runOptions.inputs
      ?.map(uri => toRunPath(uri, paths))
      .filter(path => path !== undefined)
    const changed = new Set<string>()

    const merge = (result: RunResult): void => {
      for (const [uri, list] of groupByUri(result, paths)) {
        diagnostics.set(uri, list)
        changed.add(uri)
      }
    }

    explicitRunning = true

    try {
      merge(await session.run({
        inputs: runPaths,
        progress: {
          // `onDiagnostic` fires while the run continues. A workspace run takes minutes, so the
          // server publishes each diagnostic when it arrives.
          onDiagnostic: ({ diagnostic }) => {
            const uri = toDocumentUri(diagnostic.filePath, paths)

            diagnostics.set(uri, [...diagnostics.get(uri) ?? [], toLspDiagnostic(diagnostic)])
            changed.add(uri)
          },
          onJobStart: ({ job, progress }) => runOptions.onProgress?.(progress, job.inputPath),
        },
        // The user asked for these files. A project rule would plan the whole project.
        projectTargets: runPaths === undefined ? undefined : false,
        runner: session.runner,
        signal: runOptions.signal,
      }))
    }
    catch (error) {
      if (!(error instanceof AlintRunError) && !(error instanceof AlintRunCancelledError)) {
        throw error
      }

      // A cancelled or failed run keeps what it produced. Those diagnostics were paid for.
      merge(error.result)
    }
    finally {
      explicitRunning = false

      if (changed.size > 0) {
        options.onChanged?.([...changed])
      }
    }
  }

  return {
    clearCache: async () => {
      // `rm` with `force` so a project that never ran, or has caching turned off, is not an error.
      await rm(session.cache.location, { force: true })

      return replaceMap(new Map())
    },
    contains: uri => toRunPath(uri, paths) !== undefined,
    cwd,
    get diagnostics() {
      return diagnostics
    },
    dispose: async () => {
      // A pass that starts after disposal runs against a closed session.
      if (scheduled !== undefined) {
        clearTimeout(scheduled)
        scheduled = undefined
      }

      if (filesScheduled !== undefined) {
        clearTimeout(filesScheduled)
        filesScheduled = undefined
      }

      await session.shutdown()
    },
    folderUri: options.folderUri,
    refreshFile: async (uri) => {
      const filePath = toRunPath(uri, paths)

      if (filePath === undefined || explicitRunning) {
        return []
      }

      return readFiles([filePath])
    },
    refreshFromCache: async () => {
      if (explicitRunning) {
        return
      }

      replaceMap(groupByUri(await runFromCache(session), paths))
    },
    reloadConfig: async () => {
      const replaced = session

      session = await createRunSession(runIo)

      // Close the old session last. If the new config fails to load, the folder keeps a usable one.
      await replaced.shutdown()
    },
    runExplicit: (runOptions) => {
      // Wait for the run in flight. A failed run must not stop the runs behind it.
      explicitRun = explicitRun
        .catch(() => {})
        .then(() => runOnce(runOptions))

      return explicitRun
    },
    scheduleFilesPass: (uris) => {
      for (const uri of uris) {
        const filePath = toRunPath(uri, paths)

        if (filePath !== undefined) {
          changedPaths.add(filePath)
        }
      }

      if (changedPaths.size === 0 || filesScheduled !== undefined) {
        return
      }

      filesScheduled = setTimeout(() => {
        filesScheduled = undefined
        filesPass = filesPass
          .then(runFilesPass)
          .catch((error) => {
            options.io.stderr.write(`alint lsp: files pass failed: ${errorMessageFrom(error) ?? 'unknown error'}\n`)
          })
      }, PASS_DEBOUNCE_MS)
    },
    scheduleWorkspacePass: () => {
      if (scheduled !== undefined) {
        return
      }

      scheduled = setTimeout(() => {
        scheduled = undefined

        void (async () => {
          try {
            if (explicitRunning) {
              return
            }

            options.onChanged?.(replaceMap(groupByUri(await runFromCache(session), paths)))
          }
          catch (error) {
            options.io.stderr.write(`alint lsp: workspace pass failed: ${errorMessageFrom(error) ?? 'unknown error'}\n`)
          }
        })()
      }, PASS_DEBOUNCE_MS)
    },
  }
}

/** A project rule reports diagnostics for files it did not target, so group by the named file. */
function groupByUri(
  result: RunResult,
  paths: { cwd: string, folderPath: string },
): Map<string, LspDiagnostic[]> {
  const grouped = new Map<string, LspDiagnostic[]>()

  for (const diagnostic of result.diagnostics) {
    const uri = toDocumentUri(diagnostic.filePath, paths)
    const existing = grouped.get(uri)

    if (existing) {
      existing.push(toLspDiagnostic(diagnostic))
      continue
    }

    grouped.set(uri, [toLspDiagnostic(diagnostic)])
  }

  return grouped
}

async function runFromCache(
  session: RunSession,
  options: { inputs?: string[] } = {},
): Promise<RunResult> {
  try {
    return await session.run({
      cacheOnly: true,
      inputs: options.inputs,
      // An edit changes the project target's identity, so its jobs miss the cache at any scope.
      projectTargets: options.inputs === undefined ? undefined : false,
      // This pass runs on every load and save and calls no model. Do not record it as a run.
      runner: { ...session.runner, stats: false },
    })
  }
  catch (error) {
    // A failed run still returns the diagnostics it produced. Without them, one unreadable file
    // clears every diagnostic in the workspace.
    if (error instanceof AlintRunError || error instanceof AlintRunCancelledError) {
      return error.result
    }

    throw error
  }
}

/**
 * Converts a run path back to the path the client sent.
 *
 * An editor matches diagnostics by exact URI. A resolved URI attaches them to a document the editor
 * did not open.
 */
function toDocumentUri(filePath: string, paths: { cwd: string, folderPath: string }): string {
  if (paths.cwd === paths.folderPath || !filePath.startsWith(`${paths.cwd}${sep}`)) {
    return pathToFileURL(filePath).toString()
  }

  return pathToFileURL(join(paths.folderPath, relative(paths.cwd, filePath))).toString()
}

/**
 * Converts a document URI into the path a run uses. The inverse of `toDocumentUri`.
 *
 * Returns undefined for a URI outside this folder. A server with several folders uses that to find
 * the folder that owns the file.
 */
function toRunPath(uri: string, paths: { cwd: string, folderPath: string }): string | undefined {
  const filePath = fileURLToPath(uri)

  if (!filePath.startsWith(`${paths.folderPath}${sep}`)) {
    return undefined
  }

  return join(paths.cwd, relative(paths.folderPath, filePath))
}

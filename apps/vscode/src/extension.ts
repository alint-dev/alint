import type { ExtensionContext } from 'vscode'
import type { ExecuteCommandSignature } from 'vscode-languageclient'

import process from 'node:process'

import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

import { CLEAR_CACHE_COMMAND, RUN_FILE_COMMAND } from '@alint-js/cli/lsp-commands'
import { window, workspace } from 'vscode'
import { LanguageClient, TransportKind } from 'vscode-languageclient/node'

const PATH_SETTING = 'alint.path'
const WORKSPACE_BIN = join('node_modules', '.bin', 'alint')

let client: LanguageClient | undefined

export async function activate(_context: ExtensionContext): Promise<void> {
  const command = await resolveAlintBinary()

  if (command === undefined) {
    // A silent failure looks the same as "alint found nothing". Name every location checked.
    await window.showErrorMessage(
      `Could not find the alint executable. Checked the ${PATH_SETTING} setting, ${WORKSPACE_BIN} in the workspace folder, and alint on PATH.`,
    )
    return
  }

  client = new LanguageClient(
    'alint',
    'alint',
    // The server is the alint the workspace installs, run on the user's own Node. Its cache keys
    // and cwd then match a terminal run. No native binding loads inside the extension host.
    {
      args: ['lsp'],
      command,
      transport: TransportKind.stdio,
    },
    {
      // Broad on purpose. Plugins register languages, so only the alint config knows what alint
      // lints. The sync does not limit a run. It starts the refresh on save, and it records which
      // documents are open.
      documentSelector: [
        { scheme: 'file' },
      ],
      middleware: { executeCommand: interceptCommand },
    },
  )

  await client.start()
}

export async function deactivate(): Promise<void> {
  await client?.stop()
  client = undefined
}

async function findOnPath(name: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') {
      continue
    }

    for (const candidate of withExecutableSuffixes(name)) {
      const path = join(directory, candidate)

      if (await isExecutable(path)) {
        return path
      }
    }
  }

  return undefined
}

/**
 * Adds what a palette entry cannot carry, before the command reaches the server.
 *
 * The client registers every command the server declares, so the extension registers none of its
 * own. A palette entry sends no arguments, and `alint.runFile` needs the active document.
 */
async function interceptCommand(
  command: string,
  args: unknown[],
  next: ExecuteCommandSignature,
): Promise<unknown> {
  if (command === RUN_FILE_COMMAND && args.length === 0) {
    const uri = window.activeTextEditor?.document.uri.toString()

    if (uri === undefined) {
      await window.showErrorMessage('Open a file before running alint on it.')
      return undefined
    }

    return next(command, [uri])
  }

  if (command === CLEAR_CACHE_COMMAND) {
    // The cache holds diagnostics that cost tokens. Only another run can produce them again.
    // A modal blocks until the user answers, so a stray keypress cannot clear the cache.
    const confirmed = await window.showWarningMessage(
      'Clear the alint cache?',
      {
        detail: 'This deletes every cached diagnostic. The next run calls models again to recreate them.',
        modal: true,
      },
      'Clear Cache',
    )

    if (confirmed !== 'Clear Cache') {
      return undefined
    }
  }

  return next(command, args)
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  }
  catch {
    return false
  }
}

/**
 * Finds alint: the configured path, then the workspace install, then PATH.
 *
 * The workspace installation takes precedence over a global one. The server then has the same
 * version, cache format, and `modelHash` inputs as a terminal run.
 */
async function resolveAlintBinary(): Promise<string | undefined> {
  const configured = workspace.getConfiguration().get<string>(PATH_SETTING)?.trim()

  if (configured !== undefined && configured !== '') {
    return configured
  }

  for (const folder of workspace.workspaceFolders ?? []) {
    for (const candidate of withExecutableSuffixes(join(folder.uri.fsPath, WORKSPACE_BIN))) {
      if (await isExecutable(candidate)) {
        return candidate
      }
    }
  }

  return findOnPath('alint')
}

/**
 * Candidates for one command, from a bare name or a full path.
 *
 * Windows resolves executables through PATHEXT, and npm writes `alint.cmd` into `node_modules/.bin`.
 */
function withExecutableSuffixes(command: string): string[] {
  return process.platform === 'win32'
    ? [
        `${command}.cmd`,
        `${command}.exe`,
        `${command}.bat`,
        command,
      ]
    : [command]
}

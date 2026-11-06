import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { CLEAR_CACHE_COMMAND, RUN_FILE_COMMAND, RUN_WORKSPACE_COMMAND } from '@alint-js/cli/lsp-commands'
import { defineConfig } from 'tsdown'

import manifest from './package.json' with { type: 'json' }

const OUT_DIR = 'dist'

/**
 * Writes the manifest the extension host reads.
 *
 * VS Code builds the extension identifier from `publisher` and `name` in one file, and the
 * marketplace rejects a scoped npm name. This package keeps its workspace name, so the identity
 * is declared under `vscode` here, and the build writes it into the emitted manifest.
 *
 * The manifest declares no dependencies. Everything except `vscode` is bundled, so the packaged
 * extension needs no `node_modules`.
 */
async function writeExtensionManifest(): Promise<void> {
  const { vscode, ...rest } = manifest

  // A palette entry whose id the server does not declare is a command with no handler. The
  // manifest is JSON, so nothing else checks it.
  const declared = new Set<string>([CLEAR_CACHE_COMMAND, RUN_FILE_COMMAND, RUN_WORKSPACE_COMMAND])
  const unknown = rest.contributes.commands
    .map(entry => entry.command)
    .filter(command => !declared.has(command))

  if (unknown.length > 0) {
    throw new Error(`package.json contributes commands the server does not declare: ${unknown.join(', ')}`)
  }

  await writeFile(join(OUT_DIR, 'package.json'), `${JSON.stringify({
    activationEvents: rest.activationEvents,
    categories: rest.categories,
    contributes: rest.contributes,
    description: rest.description,
    displayName: rest.displayName,
    engines: rest.engines,
    // The emitted manifest is in the same directory as the bundle.
    main: './index.cjs',
    name: vscode.name,
    publisher: vscode.publisher,
    version: rest.version,
  }, undefined, 2)}\n`)
}

export default defineConfig({
  clean: true,
  // `vscode` has no package on disk. The extension host supplies it at run time.
  deps: {
    neverBundle: ['vscode'],
  },
  dts: false,
  entry: { index: 'src/extension.ts' },
  // Required, not a preference. The host loads extensions as CommonJS, and it injects the `vscode`
  // module into CommonJS modules only.
  format: 'cjs',
  hooks: { 'build:done': writeExtensionManifest },
  outDir: OUT_DIR,
  platform: 'node',
})

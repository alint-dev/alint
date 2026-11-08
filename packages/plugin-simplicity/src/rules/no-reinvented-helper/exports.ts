import type { RuleContext } from '@alint-js/plugin'

import { access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { errorMessageFrom } from '@moeru/std/error'

/*
 * The export names come from the library itself, not from the model, so a finding can be checked
 * against them. The library is resolved from the linted workspace, so the names match the version
 * that the workspace depends on.
 *
 * Importing a library runs its top-level code. Utility libraries have none worth noting, and the
 * rule only imports the libraries that its options name.
 */
const resolved = new WeakMap<RuleContext['src'], Map<string, Promise<string[] | undefined>>>()

/** The runtime export names of `library`, or undefined when the workspace cannot load it. */
export function libraryExports(ctx: RuleContext<readonly unknown[]>, library: string): Promise<string[] | undefined> {
  let byName = resolved.get(ctx.src)
  if (byName === undefined) {
    byName = new Map()
    resolved.set(ctx.src, byName)
  }

  let loading = byName.get(library)
  if (loading === undefined) {
    loading = loadExports(ctx, library)
    byName.set(library, loading)
  }

  return loading
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  }
  catch {
    return false
  }
}

async function loadExports(ctx: RuleContext<readonly unknown[]>, library: string): Promise<string[] | undefined> {
  try {
    const module: Record<string, unknown> = await import(pathToFileURL(await resolveEntry(ctx.cwd, library)).href)

    return Object.keys(module).filter(name => name !== 'default' && name !== '__esModule').sort()
  }
  catch (error) {
    ctx.logger.debug(`no-reinvented-helper: could not load ${library}: ${errorMessageFrom(error) ?? 'unknown error'}`)

    return undefined
  }
}

/*
 * `require.resolve` finds most packages, but it rejects a package whose `exports` map has only an
 * `import` condition. Such a package is ESM only, so its manifest gives the entry instead. The
 * manifest is found by walking the same `node_modules` directories that Node searches, because
 * `exports` can also hide `./package.json` from `require.resolve`.
 */
async function resolveEntry(cwd: string, library: string): Promise<string> {
  const require = createRequire(join(cwd, 'package.json'))

  try {
    return require.resolve(library)
  }
  catch {
    for (const directory of require.resolve.paths(library) ?? []) {
      const manifestPath = join(directory, library, 'package.json')
      if (!await exists(manifestPath))
        continue

      const manifest: { exports?: unknown, main?: string, module?: string } = JSON.parse(await readFile(manifestPath, 'utf8'))
      const entry = rootExport(manifest.exports) ?? manifest.module ?? manifest.main
      if (entry === undefined)
        throw new Error(`${library} declares no root entry`)

      return join(dirname(manifestPath), entry)
    }

    throw new Error(`${library} is not installed in the workspace`)
  }
}

function rootExport(exports: unknown): string | undefined {
  if (typeof exports === 'string')
    return exports
  if (typeof exports !== 'object' || exports === null)
    return undefined

  const map = exports as Record<string, unknown>
  const root = '.' in map
    ? map['.']
    : map
  if (typeof root === 'string')
    return root
  if (typeof root !== 'object' || root === null)
    return undefined

  for (const condition of ['import', 'default', 'node']) {
    const target = condition in root
      ? (root as Record<string, unknown>)[condition]
      : undefined
    if (typeof target === 'string')
      return target
    // A nested condition, for example `import: { types, default }`.
    const nested = rootExport(target)
    if (nested !== undefined)
      return nested
  }

  return undefined
}

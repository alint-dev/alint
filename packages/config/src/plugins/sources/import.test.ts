import type { ModulePluginImportTarget } from './types'

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, expect, it } from 'vitest'

import { importPlugin } from './import'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map(root => rm(root, { force: true, recursive: true })))
  tempRoots.length = 0
})

async function createSource(cache: ModulePluginImportTarget['cache']): Promise<ModulePluginImportTarget> {
  const packageDir = await mkdtemp(join(tmpdir(), 'alint-plugin-import-'))
  const entry = join(packageDir, 'index.mjs')
  tempRoots.push(packageDir)
  await writeFile(entry, 'export default { version: 1 }\n', 'utf8')

  return {
    alias: 'local',
    cache,
    entry,
    kind: 'module',
  }
}

it('refreshes live plugin content imported from the same root path', async () => {
  const source = await createSource('content')

  const first = await importPlugin(source)
  await writeFile(source.entry, 'export default { version: 2 }\n', 'utf8')
  const second = await importPlugin(source)

  expect(first).toEqual({ version: 1 })
  expect(second).toEqual({ version: 2 })
})

it('keeps static plugin imports cached for the same root path', async () => {
  const source = await createSource('default')

  const first = await importPlugin(source)
  const originalContent = await readFile(source.entry, 'utf8')
  await writeFile(source.entry, 'export default { version: 2 }\n', 'utf8')
  const second = await importPlugin(source)

  expect(originalContent).toContain('version: 1')
  expect(first).toEqual({ version: 1 })
  expect(second).toEqual({ version: 1 })
})

it('allows transitive imports outside the plugin entry directory', async () => {
  const source = await createSource('content')
  const shared = join(tempRoots[0]!, 'shared.mjs')
  await writeFile(shared, 'export const rule = {}\n', 'utf8')
  await writeFile(source.entry, `import { rule } from ${JSON.stringify(pathToFileURL(shared).href)}\nexport default { rules: { shared: rule } }\n`, 'utf8')

  await expect(importPlugin(source)).resolves.toEqual({
    rules: { shared: {} },
  })
})

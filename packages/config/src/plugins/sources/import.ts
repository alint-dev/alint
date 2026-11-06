import type { PluginDefinition } from '@alint-js/core'

import type { PluginImportTarget } from './types'

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import { isPlainObject } from 'es-toolkit/compat'

import { createDeclarativePlugin, loadDeclarativeRules } from '../declarative'

export async function importPlugin(target: PluginImportTarget): Promise<PluginDefinition> {
  if (target.kind === 'declarative') {
    const rules = await loadDeclarativeRules({ alias: target.alias, root: target.entry })
    return createDeclarativePlugin({ rules })
  }

  const url = pathToFileURL(target.entry)

  if (target.cache === 'content') {
    url.searchParams.set('content', createHash('sha256').update(await readFile(target.entry)).digest('hex'))
  }

  const importedModule: unknown = await import(url.href)
  return getDefaultExport<PluginDefinition>(importedModule)
}

function getDefaultExport<T = unknown>(value: unknown): T {
  if (!isPlainObject(value)) {
    return value as T
  }

  const objectValue = value as object
  return Object.hasOwn(objectValue, 'default')
    ? Reflect.get(objectValue, 'default') as T
    : value as T
}

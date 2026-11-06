import type { PluginImportTarget } from './sources/types'
import type { ParsedPluginLockEntry } from './types'

import { resolve as resolveLocalSource } from './sources/local'
import { resolve as resolvePackageSource } from './sources/package'

export function resolvePluginImportTarget(entry: ParsedPluginLockEntry): Promise<PluginImportTarget> {
  return entry.type === 'directory'
    ? resolveLocalSource(entry)
    : resolvePackageSource(entry)
}

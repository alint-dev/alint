import type { PackageJson } from '@package-json/types'

import { exports as resolvePackageExports } from 'resolve.exports'

export function resolveRelativeRootEntry(packageJson: PackageJson): string {
  // Select the Node ESM import condition; browser and CommonJS entries are not executable in this runtime.
  const [entry] = resolvePackageExports(packageJson, '.', { browser: false, require: false }) ?? []

  if (entry === undefined) {
    const name = typeof packageJson.name === 'string'
      ? packageJson.name
      : '<unknown>'
    throw new Error(`Package "${name}" does not define a resolvable "." export.`)
  }

  return entry.startsWith('./')
    ? entry.slice(2)
    : entry
}

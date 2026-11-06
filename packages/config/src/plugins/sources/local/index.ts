import type { PackageJson } from '@package-json/types'

import type { DirectoryPluginSpecifier } from '../../spec'
import type { DirectoryPluginLockEntry, ParsedDirectoryPluginLockEntry } from '../../types'
import type { PluginImportTarget } from '../types'

import { access, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve as resolvePath, win32 } from 'node:path'

import { isENOENTError, isPathInside } from '../../../utils/fs'
import { hasDeclarativeRuleFiles, loadDeclarativeRules } from '../../declarative'
import { resolveRelativeRootEntry } from '../manifest'

export interface InstalledLocalSource {
  path: string
  type: 'directory'
}

export interface InstallOptions {
  alias: string
  specifier: DirectoryPluginSpecifier
}

export interface LockEntryOptions extends InstallOptions {
  cwd: string
}

export async function createLockEntry(
  installed: InstalledLocalSource,
  options: LockEntryOptions,
): Promise<DirectoryPluginLockEntry> {
  const relativePath = relative(await realpath(options.cwd), installed.path)
  const path = isAbsolute(relativePath) || win32.isAbsolute(relativePath)
    ? installed.path
    : relativePath === ''
      ? '.'
      : relativePath

  return {
    alias: options.alias,
    path,
    specifier: options.specifier.raw,
    type: 'directory',
  }
}

export async function install(options: InstallOptions): Promise<InstalledLocalSource> {
  const packageDir = await canonicalRoot(options.alias, options.specifier.directory)
  await validateInstallRoot(options.alias, packageDir)

  return {
    path: packageDir,
    type: 'directory',
  }
}

export async function resolve(entry: ParsedDirectoryPluginLockEntry): Promise<PluginImportTarget> {
  const lockedPath = isAbsolute(entry.lockEntry.path) || win32.isAbsolute(entry.lockEntry.path)
    ? entry.lockEntry.path
    : resolvePath(entry.cwd, entry.lockEntry.path)
  const [packageDir, lockedPackageDir] = await Promise.all([
    lockedRoot(entry.alias, entry.specifier.directory, 'configured'),
    lockedRoot(entry.alias, lockedPath, 'locked'),
  ])

  if (packageDir !== lockedPackageDir) {
    throw new Error(`Directory plugin "${entry.alias}" has moved or its symlink target changed. Run: alint plugin install`)
  }

  return validateResolvedRoot(entry.alias, packageDir)
}

async function canonicalRoot(alias: string, directory: string): Promise<string> {
  let packageDir

  try {
    packageDir = await realpath(directory)
  }
  catch (error) {
    if (isENOENTError(error)) {
      throw new Error(`Directory plugin "${alias}" does not exist at "${directory}".`, { cause: error })
    }

    throw new Error(`Could not resolve directory plugin "${alias}" at "${directory}".`, { cause: error })
  }

  let directoryStat

  try {
    directoryStat = await stat(packageDir)
  }
  catch (error) {
    throw new Error(`Could not inspect directory plugin "${alias}" at "${directory}".`, { cause: error })
  }

  if (!directoryStat.isDirectory()) {
    throw new Error(`Directory plugin "${alias}" path "${directory}" is not a directory.`)
  }

  return packageDir
}

async function hasPackageJson(packageDir: string): Promise<boolean> {
  try {
    await access(join(packageDir, 'package.json'))
    return true
  }
  catch (error) {
    if (isENOENTError(error)) {
      return false
    }

    throw error
  }
}

async function lockedRoot(
  alias: string,
  directory: string,
  source: 'configured' | 'locked',
): Promise<string> {
  try {
    return await realpath(directory)
  }
  catch (error) {
    if (isENOENTError(error)) {
      throw new Error(`Directory plugin "${alias}" has moved or its symlink target changed. Run: alint plugin install`, { cause: error })
    }

    throw new Error(`Could not resolve ${source} directory plugin "${alias}" at "${directory}".`, { cause: error })
  }
}

async function validateInstallRoot(alias: string, packageDir: string): Promise<PluginImportTarget> {
  if (await hasPackageJson(packageDir)) {
    return {
      alias,
      cache: 'content',
      entry: await validatePackageRoot(alias, packageDir),
      kind: 'module',
    }
  }

  await loadDeclarativeRules({ alias, root: packageDir })

  return {
    alias,
    cache: 'content',
    entry: packageDir,
    kind: 'declarative',
  }
}

async function validatePackageRoot(alias: string, packageDir: string): Promise<string> {
  const manifestPath = join(packageDir, 'package.json')
  let packageJson: PackageJson

  try {
    packageJson = JSON.parse(await readFile(manifestPath, 'utf8')) as PackageJson
  }
  catch (error) {
    throw new Error(`Directory plugin "${alias}" has an unreadable or invalid package.json at "${manifestPath}".`, { cause: error })
  }

  const relativeEntry = resolveRelativeRootEntry(packageJson)
  const entry = resolvePath(packageDir, relativeEntry)

  if (!isPathInside(entry, packageDir)) {
    throw new Error(`Directory plugin "${alias}" root export escapes the package directory.`)
  }

  let physicalEntry

  try {
    physicalEntry = await realpath(entry)
  }
  catch (error) {
    if (isENOENTError(error)) {
      throw new Error(`Directory plugin "${alias}" entry "${relativeEntry}" does not exist. Build the package and try again.`, { cause: error })
    }

    throw new Error(`Could not resolve directory plugin "${alias}" entry "${relativeEntry}".`, { cause: error })
  }

  if (!isPathInside(physicalEntry, packageDir)) {
    throw new Error(`Directory plugin "${alias}" entry physically escapes the package directory.`)
  }

  let entryStat

  try {
    entryStat = await stat(physicalEntry)
  }
  catch (error) {
    if (isENOENTError(error)) {
      throw new Error(`Directory plugin "${alias}" entry "${relativeEntry}" does not exist. Build the package and try again.`, { cause: error })
    }

    throw new Error(`Could not inspect directory plugin "${alias}" entry "${relativeEntry}".`, { cause: error })
  }

  if (!entryStat.isFile()) {
    throw new Error(`Directory plugin "${alias}" entry "${relativeEntry}" is not a regular file.`)
  }

  return physicalEntry
}

async function validateResolvedRoot(alias: string, packageDir: string): Promise<PluginImportTarget> {
  if (await hasPackageJson(packageDir)) {
    return {
      alias,
      cache: 'content',
      entry: await validatePackageRoot(alias, packageDir),
      kind: 'module',
    }
  }

  if (!(await hasDeclarativeRuleFiles(packageDir))) {
    throw new Error(`Directory plugin "${alias}" must contain package.json or rule.alint.* files.`)
  }

  return {
    alias,
    cache: 'content',
    entry: packageDir,
    kind: 'declarative',
  }
}

import type { PackageJson } from '@package-json/types'
import type { ExtractEvents, Header } from 'tar-stream'

import type { RegistryPluginSpecifier } from '../../spec'
import type { ParsedRegistryPluginLockEntry, RegistryPluginLockEntry } from '../../types'
import type { PluginImportTarget } from '../types'

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve as resolvePath } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

import tar from 'tar-stream'

import { ofetch } from 'ofetch'

import { getProjectPluginStorePath } from '../../../paths'
import { exists, isENOENTError, isPathInside } from '../../../utils/fs'
import { checkIntegrity } from '../../integrity'
import { resolveRelativeRootEntry } from '../manifest'

export type InstalledPackageSource = Omit<RegistryPluginLockEntry, 'alias' | 'specifier'>

export interface InstallOptions {
  cwd: string
  npmRegistry: string
  specifier: RegistryPluginSpecifier
}

export interface LockEntryOptions {
  alias: string
  specifier: RegistryPluginSpecifier
}

interface NpmMetadata {
  versions?: Record<string, {
    dist?: {
      integrity?: string
      tarball?: string
    }
  }>
}

// `tar-stream` ships its own types since 3.2 but does not export the entry stream type, so it is read
// off the `entry` event. It is a `streamx` Readable, not a Node one.
type TarEntry = ExtractEvents['entry'][1]

export function createLockEntry(
  installed: InstalledPackageSource,
  options: LockEntryOptions,
): RegistryPluginLockEntry {
  return {
    alias: options.alias,
    entry: installed.entry,
    integrity: installed.integrity,
    name: installed.name,
    registry: installed.registry,
    specifier: options.specifier.raw,
    tarball: installed.tarball,
    type: 'registry',
    version: installed.version,
  }
}

export async function install(options: InstallOptions): Promise<InstalledPackageSource> {
  const { name, segments, version } = options.specifier
  const npmRegistry = options.npmRegistry.endsWith('/')
    ? options.npmRegistry
    : `${options.npmRegistry}/`
  const metadataUrl = `${npmRegistry.replace(/\/$/u, '')}/${options.specifier.registryPath}`
  const metadata = await ofetch<NpmMetadata>(metadataUrl)
  const dist = metadata.versions?.[version]?.dist

  if (dist?.tarball === undefined) {
    throw new Error(`Npm metadata for "${name}" does not include a tarball for version ${version}.`)
  }

  if (dist.integrity === undefined || dist.integrity.trim() === '') {
    throw new Error(`Npm metadata for "${name}" does not include integrity for version ${version}.`)
  }

  const storePath = getProjectPluginStorePath(options.cwd)
  const packageDir = join(storePath, ...segments, version, 'package')

  if (!isPathInside(resolvePath(packageDir), resolvePath(storePath))) {
    throw new Error(`Static plugin package "${name}" resolves outside the project plugin store.`)
  }

  const packageParentDir = dirname(packageDir)
  const stagingPackageDir = join(packageParentDir, `package-staging-${randomUUID()}`)
  let relativeEntry: string

  try {
    const tarball = Buffer.from(await ofetch<ArrayBuffer, 'arrayBuffer'>(dist.tarball, { responseType: 'arrayBuffer' }))
    checkIntegrity(tarball, dist.integrity, `${name}@${version}`)
    await mkdir(stagingPackageDir, { recursive: true })
    await extractTarball(tarball, stagingPackageDir)
    const packageJson = JSON.parse(await readFile(join(stagingPackageDir, 'package.json'), 'utf8')) as PackageJson
    relativeEntry = resolveRelativeRootEntry(packageJson)
    await replaceDirectory(packageDir, stagingPackageDir)
  }
  catch (error) {
    await rm(stagingPackageDir, { force: true, recursive: true })
    throw error
  }

  return {
    entry: posix.join('.alint/plugins/store', ...segments, version, 'package', relativeEntry.split(/[\\/]/u).join('/')),
    integrity: dist.integrity,
    name,
    registry: npmRegistry,
    tarball: dist.tarball,
    type: 'registry',
    version,
  }
}

export async function resolve(entry: ParsedRegistryPluginLockEntry): Promise<PluginImportTarget> {
  const projectRoot = resolvePath(entry.cwd)
  const pluginRoot = join(projectRoot, '.alint', 'plugins', 'store')
  const rawEntryPath = entry.lockEntry.entry
  const resolvedEntry = isAbsolute(rawEntryPath)
    ? resolvePath(rawEntryPath)
    : resolvePath(projectRoot, rawEntryPath)

  if (!isPathInside(resolvedEntry, projectRoot)) {
    throw new Error(`Plugin lock entry "${entry.alias}" resolves outside the project root.`)
  }

  const [physicalEntry, physicalPluginRoot] = await Promise.all([
    resolvePhysicalPath(resolvedEntry),
    realpath(pluginRoot),
  ])

  if (!isPathInside(physicalEntry, physicalPluginRoot)) {
    throw new Error(`Plugin lock entry "${entry.alias}" resolves outside the plugin store.`)
  }

  const packageDir = getLockedPackageDir(projectRoot, pluginRoot, entry)
  const physicalPackageDir = await realpath(packageDir)
  const expectedPhysicalPackageDir = join(physicalPluginRoot, ...getPackagePathSegments(entry.lockEntry.name), entry.lockEntry.version, 'package')

  if (physicalPackageDir !== expectedPhysicalPackageDir) {
    throw new Error(`Plugin lock entry "${entry.alias}" resolves outside the locked package directory.`)
  }

  if (!isPathInside(resolvedEntry, packageDir)) {
    throw new Error(`Plugin lock entry "${entry.alias}" resolves outside the locked package directory.`)
  }

  JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
  return {
    alias: entry.alias,
    cache: 'default',
    entry: resolvedEntry,
    kind: 'module',
  }
}

async function extractEntry(packageDir: string, header: Header, stream: TarEntry): Promise<void> {
  const entryName = header.name

  if (!entryName.startsWith('package/')) {
    stream.resume()
    return
  }

  const relativeEntry = entryName.slice('package/'.length)
  const normalized = posix.normalize(relativeEntry)

  if (relativeEntry === '' || normalized === '.') {
    stream.resume()
    return
  }

  if (normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized)) {
    stream.resume()
    throw new Error(`Plugin tarball entry "${entryName}" escapes the package directory.`)
  }

  const outputPath = resolvePath(packageDir, normalized)

  if (!isPathInside(outputPath, packageDir)) {
    stream.resume()
    throw new Error(`Plugin tarball entry "${entryName}" escapes the package directory.`)
  }

  if (header.type === 'directory') {
    stream.resume()
    await mkdir(outputPath, { recursive: true })
    return
  }

  if (header.type !== 'file') {
    stream.resume()
    return
  }

  await mkdir(dirname(outputPath), { recursive: true })
  await pipeline(stream, createWriteStream(outputPath))
}

async function extractTarball(tarball: Buffer, packageDir: string): Promise<void> {
  const extract = tar.extract()
  extract.on('entry', (header, stream, next) => {
    void extractEntry(packageDir, header, stream).then(() => next()).catch(error => extract.destroy(error))
  })
  await pipeline(Readable.from(tarball), createGunzip(), extract)
}

function getLockedPackageDir(projectRoot: string, pluginRoot: string, entry: ParsedRegistryPluginLockEntry): string {
  const name = entry.lockEntry.name
  const version = entry.lockEntry.version

  if (entry.specifier.name !== name) {
    throw new Error(`Plugin lock entry "${entry.alias}" package name does not match its specifier.`)
  }

  if (entry.specifier.version !== version) {
    throw new Error(`Plugin lock entry "${entry.alias}" package version does not match its specifier.`)
  }

  const packageDir = join(pluginRoot, ...getPackagePathSegments(name), version, 'package')

  if (!isPathInside(packageDir, projectRoot) || !isPathInside(packageDir, pluginRoot)) {
    throw new Error(`Plugin lock entry "${entry.alias}" package metadata resolves outside the plugin store.`)
  }

  return packageDir
}

function getPackagePathSegments(name: string): string[] {
  const segments = name.split('/')
  const segmentPattern = /^[\w.-]+$/u

  if (segments.length === 2) {
    const [scope, packageName] = segments

    if (scope === undefined || packageName === undefined || !scope.startsWith('@') || !segmentPattern.test(scope.slice(1)) || !segmentPattern.test(packageName)) {
      throw new Error(`Invalid static plugin package name "${name}".`)
    }

    return segments
  }

  if (segments.length !== 1 || !segmentPattern.test(segments[0]!)) {
    throw new Error(`Invalid static plugin package name "${name}".`)
  }

  return segments
}

async function nearestExistingParent(path: string): Promise<string> {
  let current = path

  while (current !== dirname(current)) {
    if (await exists(current)) {
      return current
    }

    current = dirname(current)
  }

  return current
}

async function replaceDirectory(packageDir: string, stagingPackageDir: string): Promise<void> {
  const backupPackageDir = join(dirname(packageDir), `package-backup-${randomUUID()}`)
  let hasBackup = false
  let replaced = false

  try {
    await rename(packageDir, backupPackageDir)
    hasBackup = true
  }
  catch (error) {
    if (!isENOENTError(error))
      throw error
  }

  try {
    await rename(stagingPackageDir, packageDir)
    replaced = true
  }
  catch (error) {
    if (hasBackup) {
      // Directory replacement cannot be made crash-proof portably; this preserves the previous install before replacement.
      await rename(backupPackageDir, packageDir)
      hasBackup = false
    }
    throw error
  }
  finally {
    if (replaced || !hasBackup)
      await rm(backupPackageDir, { force: true, recursive: true })
  }
}

async function resolvePhysicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  }
  catch (error) {
    if (!isENOENTError(error)) {
      throw error
    }
  }

  const parent = await nearestExistingParent(dirname(path))
  return join(await realpath(parent), relative(parent, path))
}

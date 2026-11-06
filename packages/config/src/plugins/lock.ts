import type { ParsedStaticConfig, StaticPluginReference } from '../config/static'
import type {
  ParsedPluginLockEntry,
  ParsedPluginLockFile,
  PluginLockFile,
} from './types'

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path'

import {
  literal,
  parse,
  record,
  strictObject,
  string,
  variant,
} from 'valibot'

import { getProjectPluginLockPath } from '../paths'
import { isENOENTError } from '../utils/fs'
import { parseIntegrity } from './integrity'
import { resolvePluginImportTarget } from './resolve'
import { getPluginSpecifierKey, isDirectoryPluginSpecifier, parsePluginSpecifier } from './spec'

const PluginLockEntrySchema = variant('type', [
  strictObject({
    alias: string(),
    path: string(),
    specifier: string(),
    type: literal('directory'),
  }),
  strictObject({
    alias: string(),
    entry: string(),
    integrity: string(),
    name: string(),
    registry: string(),
    specifier: string(),
    tarball: string(),
    type: literal('registry'),
    version: string(),
  }),
])

const PluginLockFileSchema = strictObject({
  plugins: record(string(), PluginLockEntrySchema),
  version: literal(2),
})

export function createEmptyPluginLockFile(): PluginLockFile {
  return { plugins: {}, version: 2 }
}

export function listMissing(
  config: ParsedStaticConfig,
  lock: ParsedPluginLockFile,
): StaticPluginReference[] {
  const missing: StaticPluginReference[] = []

  for (const group of config.groups) {
    for (const reference of group.plugins) {
      const entry = lock.find(reference)

      if (entry === undefined) {
        missing.push(reference)
      }
    }
  }

  return missing
}

export async function listUnresolved(
  config: ParsedStaticConfig,
  lock: ParsedPluginLockFile,
): Promise<ParsedPluginLockEntry[]> {
  const unresolved: ParsedPluginLockEntry[] = []
  const checkedAliases = new Set<string>()

  for (const group of config.groups) {
    for (const reference of group.plugins) {
      const entry = lock.find(reference)

      if (entry === undefined || checkedAliases.has(entry.alias)) {
        continue
      }

      checkedAliases.add(entry.alias)

      try {
        await resolvePluginImportTarget(entry)
      }
      catch (error) {
        unresolved.push({ ...entry, resolutionError: error })
      }
    }
  }

  return unresolved
}

export async function loadPluginLockFile(cwd: string): Promise<PluginLockFile> {
  try {
    return parsePluginLockFileValue(await readFile(getProjectPluginLockPath(cwd), 'utf8'))
  }
  catch (error) {
    if (isENOENTError(error)) {
      return createEmptyPluginLockFile()
    }

    throw error
  }
}

export function parsePluginLockFile(
  value: unknown,
  options: { cwd: string },
): ParsedPluginLockFile {
  const file = parsePluginLockFileValue(value)
  const entries = Object.values(file.plugins).map((entry): ParsedPluginLockEntry => {
    if (entry.type === 'registry') {
      const specifier = parsePluginSpecifier(entry.specifier)

      if (specifier.type !== 'registry') {
        throw new Error(`Registry plugin lock entry "${entry.alias}" must use a registry specifier.`)
      }

      return {
        alias: entry.alias,
        cwd: options.cwd,
        lockEntry: entry,
        specifier,
        type: 'registry',
      }
    }

    const lockPath = resolveDirectoryLockIdentity(entry.path, options.cwd)
    const specifier = parsePluginSpecifier(lockPath)

    if (specifier.type !== 'directory') {
      throw new Error(`Directory plugin lock entry "${entry.alias}" must use a directory path.`)
    }

    return {
      alias: entry.alias,
      cwd: options.cwd,
      lockEntry: entry,
      specifier: { ...specifier, raw: entry.specifier },
      type: 'directory',
    }
  })
  const byAlias = new Map(entries.map(entry => [entry.alias, entry]))

  return {
    cwd: options.cwd,
    entries,
    file,
    find(reference: StaticPluginReference) {
      const entry = byAlias.get(reference.alias)
      return entry !== undefined && matchesReference(entry, reference)
        ? associateCurrentSpecifier(entry, reference)
        : undefined
    },
    get(reference: StaticPluginReference) {
      const entry = byAlias.get(reference.alias)
      const expected = reference.specifier.raw

      if (entry === undefined) {
        throw new Error(`Plugin "${reference.alias}" requires ${expected}, but no matching lock entry exists.\nRun: alint plugin install`)
      }

      if (!matchesReference(entry, reference)) {
        throw new Error(`Plugin "${reference.alias}" is locked to ${entry.lockEntry.specifier}, but config requires ${expected}.\nRun: alint plugin install`)
      }

      return associateCurrentSpecifier(entry, reference)
    },
  }
}

export async function writePluginLockFile(cwd: string, lockFile: PluginLockFile): Promise<void> {
  const content = `${JSON.stringify(parsePluginLockFileValue(lockFile), null, 2)}\n`
  const lockPath = getProjectPluginLockPath(cwd)
  const lockDir = dirname(lockPath)
  const tempPath = join(lockDir, `lock.${randomUUID()}.tmp`)

  await mkdir(lockDir, { recursive: true })

  try {
    await writeFile(tempPath, content, 'utf8')
    await rename(tempPath, lockPath)
  }
  catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
}

function associateCurrentSpecifier(
  entry: ParsedPluginLockEntry,
  reference: StaticPluginReference,
): ParsedPluginLockEntry {
  if (entry.type === 'directory' && reference.specifier.type === 'directory') {
    return { ...entry, specifier: reference.specifier }
  }

  return entry
}

function matchesReference(entry: ParsedPluginLockEntry, reference: StaticPluginReference): boolean {
  if (entry.type !== reference.specifier.type) {
    return false
  }

  if (entry.type === 'directory') {
    return entry.lockEntry.specifier === reference.specifier.raw
      || getPluginSpecifierKey(entry.specifier) === getPluginSpecifierKey(reference.specifier)
  }

  return getPluginSpecifierKey(entry.specifier) === getPluginSpecifierKey(reference.specifier)
}

function parsePluginLockFileValue(value: unknown): PluginLockFile {
  const parsedValue = typeof value === 'string'
    ? JSON.parse(value) as unknown
    : value

  if (
    typeof parsedValue === 'object'
    && parsedValue !== null
    && 'version' in parsedValue
    && parsedValue.version === 1
  ) {
    throw new Error('Unsupported plugin lock version 1. Run: alint plugin install')
  }

  const file = parse(PluginLockFileSchema, parsedValue)

  for (const [alias, entry] of Object.entries(file.plugins)) {
    if (entry.alias !== alias) {
      throw new Error(`Plugin lock entry key "${alias}" must match alias "${entry.alias}".`)
    }

    if (entry.type === 'registry') {
      parseIntegrity(entry.integrity, entry.specifier)

      if (isDirectoryPluginSpecifier(entry.specifier)) {
        throw new Error(`Registry plugin lock entry "${alias}" must use a registry specifier.`)
      }

      const specifier = parsePluginSpecifier(entry.specifier)

      if (
        specifier.type !== 'registry'
        || specifier.name !== entry.name
        || specifier.version !== entry.version
      ) {
        throw new Error(`Registry plugin lock entry "${alias}" identity does not match specifier "${entry.specifier}".`)
      }
    }
    else if (!isDirectoryPluginSpecifier(entry.specifier)) {
      throw new Error(`Directory plugin lock entry "${alias}" must use a directory specifier.`)
    }
  }

  return file
}

function resolveDirectoryLockIdentity(path: string, cwd: string): string {
  // Foreign absolute paths remain lexical identities here. Package resolution separately decides
  // whether a directory is accessible through the current host filesystem.
  return isAbsolute(path) || win32.isAbsolute(path)
    ? path
    : resolve(cwd, path)
}

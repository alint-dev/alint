import type { Stats } from 'node:fs'

import type { AlintConfig, AlintConfigItem } from '@alint-js/core'

import type { ChangedLineRange } from '../../git'

import { opendir, stat } from 'node:fs/promises'

import Gitignore from 'gitignore-fs'

import { hasDiscoveryFilePatterns, matchesDiscoveryFile, normalizeConfig, resolveConfigForFile } from '@alint-js/core'
import { isNodeErrorCode } from '@alint-js/utils/node'
import { minimatch, Minimatch } from 'minimatch'
import { isAbsolute, relative, resolve } from 'pathe'

import { findDirtyChanges } from '../../git'

export interface DirtyLintTargets extends LintTargets {
  changedLines: ReadonlyMap<string, readonly ChangedLineRange[]>
}

export interface FindFilesOptions {
  config: AlintConfig
  cwd: string
  errorOnUnmatchedPattern?: boolean
  globInputPaths?: boolean
  inputs: string[]
}

export interface LintTargets {
  directories: string[]
  files: string[]
}

interface ResolveInputFilesOptions {
  config: AlintConfig
  cwd: string
  errorOnUnmatchedPattern: boolean
  gitignore?: Gitignore
  globInputPaths: boolean
  inputs: string[]
}

interface SearchGlobOptions {
  config: AlintConfig
  cwd: string
  gitignore?: Gitignore
  hasFilePatterns: boolean
  ignoredPatterns: readonly string[]
  pattern: string
}

interface WalkFilesOptions {
  cwd: string
  gitignore?: Gitignore
  ignoredPatterns: readonly string[]
}

const minimatchOptions = { dot: true }
// NOTICE: A larger directory buffer amortizes filesystem reads while keeping memory bounded per open directory.
const directoryBufferSize = 256

export class NoFilesFoundError extends Error {
  readonly globInputPaths: boolean
  readonly pattern: string

  constructor(pattern: string, options: { globInputPaths: boolean }) {
    super(`No files matching "${pattern}" were found${options.globInputPaths ? '' : ' (glob input is disabled)'}.`)
    this.name = 'NoFilesFoundError'
    this.globInputPaths = options.globInputPaths
    this.pattern = pattern
  }
}

export async function findDirtyLintTargets(config: AlintConfig, cwd: string): Promise<DirtyLintTargets> {
  const changes = await findDirtyChanges(cwd)

  if (changes.files.length === 0) {
    return { changedLines: changes.changedLines, directories: [], files: [] }
  }

  const targets = await findLintTargets({
    config,
    cwd,
    errorOnUnmatchedPattern: false,
    globInputPaths: false,
    inputs: changes.files,
  })

  return { ...targets, changedLines: changes.changedLines }
}

export async function findFiles(options: FindFilesOptions): Promise<string[]> {
  return (await findLintTargets(options)).files
}

export async function findLintTargets(options: FindFilesOptions): Promise<LintTargets> {
  const {
    config,
    cwd,
    errorOnUnmatchedPattern = true,
    globInputPaths = true,
    inputs,
  } = options
  const gitignore = shouldFilterGitignoredFiles(config) ? new Gitignore() : undefined
  const targets = await resolveInputFiles({
    config,
    cwd,
    errorOnUnmatchedPattern,
    gitignore,
    globInputPaths,
    inputs: inputs.length > 0 ? inputs : ['.'],
  })

  if (!gitignore || targets.files.length === 0) {
    return targets
  }

  const lintFiles: string[] = []

  for (const file of targets.files) {
    if (await gitignore.ignores(resolve(cwd, file))) {
      continue
    }

    lintFiles.push(file)
  }

  return {
    directories: targets.directories,
    files: lintFiles,
  }
}

/** Returns undefined when nothing is at the path. `ENOTDIR` means a parent in the path is a file. */
export async function statPath(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path)
  }
  catch (error) {
    if (isNodeErrorCode(error, 'ENOENT') || isNodeErrorCode(error, 'ENOTDIR')) {
      return undefined
    }

    throw error
  }
}

function collectGlobalIgnorePatterns(config: AlintConfig): string[] {
  return normalizeConfig(config).flatMap(item =>
    isGlobalIgnoreItem(item) ? [...item.ignores] : [],
  )
}

function getGlobParent(input: string): string {
  const normalized = input.replaceAll('\\', '/')
  const segments = normalized.split('/')
  const parentSegments: string[] = []

  for (const segment of segments) {
    if (isGlobPattern(segment)) {
      break
    }

    parentSegments.push(segment)
  }

  const parent = parentSegments.join('/')
  return parent === '' ? '.' : parent
}

function isGlobalIgnoreItem(item: AlintConfigItem): item is AlintConfigItem & { ignores: readonly string[] } {
  const keys = Object.keys(item).filter(key => item[key as keyof AlintConfigItem] !== undefined)

  return item.ignores !== undefined && keys.every(key => key === 'ignores' || key === 'name')
}

function isGlobPattern(input: string): boolean {
  return new Minimatch(input, minimatchOptions).hasMagic()
}

function matchesGlob(filePath: string, pattern: string): boolean {
  return minimatch(filePath, pattern.replaceAll('\\', '/'), minimatchOptions)
}

function matchesIgnoredDirectory(relativePath: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern =>
    minimatch(relativePath, pattern, minimatchOptions)
    || minimatch(`${relativePath}/`, pattern, minimatchOptions)
    || minimatch(`${relativePath}/__alint__`, pattern, minimatchOptions),
  )
}

function normalizeGlobPattern(cwd: string, pattern: string): string {
  return isAbsolute(pattern)
    ? normalizeRelativePath(cwd, pattern)
    : pattern.replaceAll('\\', '/')
}

function normalizeRelativePath(cwd: string, filePath: string): string {
  return relative(cwd, filePath).replaceAll('\\', '/')
}

async function resolveInputFiles(options: ResolveInputFilesOptions): Promise<LintTargets> {
  const hasFilePatterns = hasDiscoveryFilePatterns(options.config)
  const ignoredPatterns = collectGlobalIgnorePatterns(options.config)
  const candidates: string[] = []
  const directories: string[] = []

  for (const input of options.inputs) {
    const path = resolve(options.cwd, input)
    const stats = await statPath(path)

    if (stats?.isFile()) {
      candidates.push(input)
      continue
    }

    if (stats?.isDirectory()) {
      if (await shouldPruneDirectory(path, {
        cwd: options.cwd,
        gitignore: options.gitignore,
        ignoredPatterns,
      })) {
        continue
      }

      directories.push(input)

      if (!hasFilePatterns) {
        continue
      }

      const directoryFiles: string[] = []

      for await (const file of walkFiles(path, {
        cwd: options.cwd,
        gitignore: options.gitignore,
        ignoredPatterns,
      })) {
        const relativePath = normalizeRelativePath(options.cwd, file)

        if (hasFilePatterns && matchesDiscoveryFile(relativePath, options.config, { cwd: options.cwd })) {
          directoryFiles.push(relativePath)
        }
      }

      for (const file of directoryFiles.sort()) {
        candidates.push(file)
      }

      continue
    }

    if (options.globInputPaths && isGlobPattern(input)) {
      const matches = await searchGlob({
        config: options.config,
        cwd: options.cwd,
        gitignore: options.gitignore,
        hasFilePatterns,
        ignoredPatterns,
        pattern: input,
      })

      if (matches.length === 0 && options.errorOnUnmatchedPattern) {
        throw new NoFilesFoundError(input, { globInputPaths: options.globInputPaths })
      }

      for (const match of matches) {
        candidates.push(match)
      }
      continue
    }

    if (options.errorOnUnmatchedPattern) {
      throw new NoFilesFoundError(input, { globInputPaths: options.globInputPaths })
    }
  }

  return {
    directories: [...new Set(directories)],
    files: [...new Set(candidates)],
  }
}

async function searchGlob(options: SearchGlobOptions): Promise<string[]> {
  const root = resolve(options.cwd, getGlobParent(options.pattern))
  const rootStats = await statPath(root)
  const pattern = normalizeGlobPattern(options.cwd, options.pattern)

  if (!rootStats?.isDirectory()) {
    return []
  }

  const candidates: string[] = []

  for await (const file of walkFiles(root, {
    cwd: options.cwd,
    gitignore: options.gitignore,
    ignoredPatterns: options.ignoredPatterns,
  })) {
    const relativePath = normalizeRelativePath(options.cwd, file)

    if (matchesGlob(relativePath, pattern) && shouldIncludeGlobCandidate(relativePath, options.config, {
      cwd: options.cwd,
      hasFilePatterns: options.hasFilePatterns,
    })) {
      candidates.push(relativePath)
    }
  }

  return candidates.sort()
}

function shouldFilterGitignoredFiles(config: AlintConfig): boolean {
  return normalizeConfig(config).some(item => item.ignore?.gitignore === true)
}

function shouldIncludeGlobCandidate(
  filePath: string,
  config: AlintConfig,
  options: { cwd: string, hasFilePatterns: boolean },
): boolean {
  if (options.hasFilePatterns) {
    return matchesDiscoveryFile(filePath, config, { cwd: options.cwd })
  }

  return !resolveConfigForFile(filePath, config, { cwd: options.cwd }).ignored
}

async function shouldPruneDirectory(path: string, options: WalkFilesOptions): Promise<boolean> {
  const relativePath = normalizeRelativePath(options.cwd, path)

  if (matchesIgnoredDirectory(relativePath, options.ignoredPatterns)) {
    return true
  }

  return await options.gitignore?.ignores(`${path}/`) === true
}

/**
 * Streams directory entries so unmatched trees never accumulate into recursive child arrays.
 * The consumer owns result ordering because filesystem iteration order is not stable.
 */
async function* walkFiles(root: string, options: WalkFilesOptions): AsyncGenerator<string> {
  const pendingDirectories = [root]

  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop()

    if (currentDirectory === undefined) {
      continue
    }

    const childDirectories: string[] = []
    const directory = await opendir(currentDirectory, { bufferSize: directoryBufferSize })

    for await (const entry of directory) {
      const path = resolve(currentDirectory, entry.name)
      if (entry.isDirectory()) {
        if (!await shouldPruneDirectory(path, options)) {
          childDirectories.push(path)
        }
        continue
      }

      if (entry.isFile()) {
        yield path
      }
    }

    for (const path of childDirectories.reverse()) {
      pendingDirectories.push(path)
    }
  }
}

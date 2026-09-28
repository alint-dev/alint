import type { AlintConfig } from '@alint-js/core'

import type { ParsedStaticConfig, StaticConfigItem } from './static'

import { readdir } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { loadConfig } from 'c12'
import { createJiti } from 'jiti/static'

import { listMissing, listUnresolved, loadPluginLockFile, parsePluginLockFile } from '../plugins/lock'
import { resolvePluginImportTarget } from '../plugins/resolve'
import { importPlugin } from '../plugins/sources/import'
import { getPluginSpecifierKey } from '../plugins/spec'
import {
  parseStaticConfig,
  toAlintConfig,
} from './static'

export interface LoadedAlintConfig {
  config: AlintConfig
  configFile?: string
}

interface C12LoadConfigResult {
  _configFile?: string
}

interface LoadedStaticConfigSource {
  config: ParsedStaticConfig
  configFile?: string
}

interface NestedStaticConfigSource {
  config: ParsedStaticConfig
  configFile: string
  relativeDirectory: string
}

/**
 * Config file names a nested config may use, mirroring what c12 resolves for the root.
 *
 * @see {@link loadConfig} `configFile`
 */
const nestedConfigFileNames: readonly string[] = [
  'alint.config.cjs',
  'alint.config.cts',
  'alint.config.js',
  'alint.config.json',
  'alint.config.json5',
  'alint.config.jsonc',
  'alint.config.mjs',
  'alint.config.mts',
  'alint.config.toml',
  'alint.config.ts',
  'alint.config.yaml',
  'alint.config.yml',
]

/**
 * Directories that never hold a config a project means to run.
 *
 * Hidden directories are skipped wholesale so `.git`, `.cache`, and `.next` cost no lookups.
 */
const skippedDiscoveryDirectoryNames = new Set([
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'vendor',
])

export async function loadAlintConfig(
  cwd: string,
  configFile?: string,
): Promise<AlintConfig> {
  return (await loadAlintConfigWithMetadata(cwd, configFile)).config
}

export async function loadAlintConfigWithMetadata(
  cwd: string,
  configFile?: string,
): Promise<LoadedAlintConfig> {
  const source = await loadStaticConfigSource(cwd, configFile)
  const staticConfig = source.config
  const references = staticConfig.groups.flatMap(group => group.plugins)

  if (references.length === 0) {
    return {
      config: await toAlintConfig(staticConfig, {
        pluginResolver: async (reference) => {
          throw new Error(`Static plugin "${reference.alias}" was not expected to require resolution.`)
        },
      }),
      configFile: source.configFile,
    }
  }

  const lock = parsePluginLockFile(await loadPluginLockFile(cwd), { cwd })
  const missing = listMissing(staticConfig, lock)

  if (missing.length > 0) {
    throw new Error(`Static plugin references are missing from the lock file: ${formatPluginReferences(missing)}.\nRun: alint plugin install`)
  }

  const unresolved = await listUnresolved(staticConfig, lock)

  if (unresolved.length > 0) {
    const message = `Static plugins could not be resolved from the lock file: ${formatPluginReferences(unresolved)}.\nRun: alint plugin install`
    throw new Error(message, { cause: unresolved[0]?.resolutionError })
  }

  return {
    config: await toAlintConfig(staticConfig, {
      async pluginResolver(reference) {
        const resolved = await resolvePluginImportTarget(lock.get(reference))
        return importPlugin(resolved)
      },
    }),
    configFile: source.configFile,
  }
}

export async function loadStaticConfig(
  cwd: string,
  configFile?: string,
): Promise<ParsedStaticConfig> {
  return (await loadStaticConfigSource(cwd, configFile)).config
}

/**
 * Rejects two config files claiming one plugin alias with different plugins.
 *
 * The lock file is keyed by alias, so the second specifier would silently win and every rule id
 * from the first plugin would come from the wrong plugin.
 */
function assertDistinctPluginAliases(
  sources: readonly { config: ParsedStaticConfig, configFile?: string }[],
): void {
  const seen = new Map<string, { configFile?: string, key: string }>()

  for (const source of sources) {
    for (const group of source.config.groups) {
      for (const reference of group.plugins) {
        const key = getPluginSpecifierKey(reference.specifier)
        const previous = seen.get(reference.alias)

        if (previous === undefined) {
          seen.set(reference.alias, { configFile: source.configFile, key })
          continue
        }

        if (previous.key === key) {
          continue
        }

        throw new Error(
          `Static plugin "${reference.alias}" is configured in ${formatConfigOrigin(previous.configFile)} and ${formatConfigOrigin(source.configFile)} with different specifiers ("${previous.key}" and "${key}"). Nested configs share one plugin lock file, so give each plugin a distinct alias.`,
        )
      }
    }
  }
}

async function collectNestedConfigFiles(
  root: string,
  directory: string,
  found: string[],
): Promise<void> {
  let entries

  try {
    entries = await readdir(directory, { withFileTypes: true })
  }
  catch {
    // An unreadable directory holds no config the run can use, and failing the whole run over it
    // would make discovery the only thing that can break a lint.
    return
  }

  const childDirectories: string[] = []

  for (const entry of entries) {
    const path = join(directory, entry.name)

    if (entry.isDirectory()) {
      if (!shouldSkipDiscoveryDirectory(entry.name)) {
        childDirectories.push(path)
      }

      continue
    }

    // The root config is loaded on its own, with its own error handling.
    if (entry.isFile() && directory !== root && nestedConfigFileNames.includes(entry.name)) {
      found.push(path)
    }
  }

  for (const child of childDirectories.sort()) {
    await collectNestedConfigFiles(root, child, found)
  }
}

function directoryDepth(path: string): number {
  return path.split(sep).length
}

async function discoverNestedConfigFiles(cwd: string): Promise<string[]> {
  const found: string[] = []
  await collectNestedConfigFiles(cwd, cwd, found)

  return found.sort((left, right) => {
    const depthDifference = directoryDepth(left) - directoryDepth(right)

    return depthDifference === 0 ? left.localeCompare(right) : depthDifference
  })
}

function formatConfigOrigin(configFile: string | undefined): string {
  return configFile ?? 'the inline config'
}

function formatPluginReferences(
  references: readonly { alias: string, specifier: { raw: string } }[],
): string {
  return references
    .map(reference => `${reference.alias} (${reference.specifier.raw})`)
    .join(', ')
}

/**
 * Loads every `alint.config.*` below `cwd`, except the root config itself.
 *
 * A package that owns its rules writes one config next to its code instead of registering a
 * directory plugin in the root config, scoping the plugin, and repeating that scope in every
 * tool that reads it. Discovery is depth-first, parents before children, so a deeper config
 * overrides an outer one the same way a later flat-config item does.
 */
async function loadNestedStaticConfigSources(cwd: string): Promise<NestedStaticConfigSource[]> {
  const configFiles = await discoverNestedConfigFiles(cwd)
  const sources: NestedStaticConfigSource[] = []

  for (const configFile of configFiles) {
    const directory = dirname(configFile)
    // Nested configs do not read `.env`: a package's environment file must not change how the
    // root config and the providers are resolved.
    const source = await loadSingleStaticConfigSource(directory, basename(configFile), { dotenv: false })

    if (source.configFile === undefined) {
      continue
    }

    sources.push({
      config: source.config,
      configFile: source.configFile,
      relativeDirectory: toPosixPath(relative(cwd, directory)),
    })
  }

  return sources
}

/** Loads one config file in one directory. The root and every nested config go through here. */
async function loadSingleStaticConfigSource(
  cwd: string,
  configFile?: string,
  options: { dotenv?: boolean } = {},
): Promise<LoadedStaticConfigSource> {
  const jiti = createJiti(resolve(cwd, configFile ?? 'alint.config'), {
    interopDefault: true,
    moduleCache: false,
  })

  const result = await loadConfig({
    configFile,
    cwd,
    dotenv: options.dotenv ?? true,
    // NOTICE: c12's default `jiti` import lazy-loads `../dist/babel.cjs`,
    // which Bun standalone executables do not discover while compiling. The
    // `jiti/static` entrypoint exists for this exact packaging shape and keeps
    // Babel's transform bundle in the static module graph.
    //
    // Source: `https://github.com/unjs/jiti/blob/fd3bb289b75ed207edfb686d671ed50144f7e90f/lib/jiti-static.mjs#L3-L4`
    import: id => jiti.import(id),
    name: 'alint',
  })

  // NOTICE: c12 returns `{}` for a missing config even without defaults. The
  // resolved config-file marker is the only result field that distinguishes
  // "not found" from an intentionally exported empty object.
  if ((result as C12LoadConfigResult)._configFile === undefined) {
    return { config: parseStaticConfig(undefined) }
  }

  const resolvedConfigFile = (result as C12LoadConfigResult)._configFile

  return {
    config: parseStaticConfig(result.config, { configFile: resolvedConfigFile }),
    configFile: resolvedConfigFile,
  }
}

async function loadStaticConfigSource(
  cwd: string,
  configFile?: string,
): Promise<LoadedStaticConfigSource> {
  const root = await loadSingleStaticConfigSource(cwd, configFile)

  // An explicit config file pins exactly one file: merging implicit siblings in would make the
  // run depend on files the caller never named.
  if (configFile !== undefined) {
    return root
  }

  const nested = await loadNestedStaticConfigSources(cwd)

  if (nested.length === 0) {
    return root
  }

  assertDistinctPluginAliases([{ config: root.config, configFile: root.configFile }, ...nested])

  return {
    config: {
      groups: [
        ...root.config.groups,
        ...nested.flatMap(source => scopeNestedGroups(source)),
      ],
    },
    configFile: root.configFile,
  }
}

/**
 * Scopes one nested config item to the directory that declares it.
 *
 * `basePath` makes every pattern in the item resolve against that directory, so an `ignores`
 * entry or a plugin config the item extends stays inside it. The two defaults cover the item
 * shapes that declare no patterns at all: without them a rule set written next to a package
 * would silently apply to the whole repository.
 *
 * Limits: an item cannot target the project root (`onTargetProject`) from a nested config,
 * because the project target sits outside the item's base path.
 */
function scopeNestedConfigItem(item: StaticConfigItem, relativeDirectory: string): StaticConfigItem {
  return {
    ...item,
    basePath: item.basePath === undefined
      ? relativeDirectory
      : `${relativeDirectory}/${toPosixPath(item.basePath)}`,
    directories: item.directories ?? ['**'],
    files: item.files ?? ['**/*'],
  }
}

function scopeNestedGroups(source: NestedStaticConfigSource): ParsedStaticConfig['groups'] {
  return source.config.groups.map(group => ({
    ...group,
    item: scopeNestedConfigItem(group.item, source.relativeDirectory),
  }))
}

function shouldSkipDiscoveryDirectory(name: string): boolean {
  return name.startsWith('.') || skippedDiscoveryDirectoryNames.has(name)
}

function toPosixPath(path: string): string {
  return path.split(sep).join('/')
}

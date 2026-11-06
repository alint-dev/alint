import type { AlintConfig, AlintConfigItem, PluginDefinition } from '@alint-js/core'

import type { DirectoryPluginSpecifier, ParsedPluginSpecifier, ParsePluginSpecifierOptions, RegistryPluginSpecifier } from '../plugins/spec'

import { maximumStopGateTimeoutMs } from '@alint-js/core'
import { extname } from 'pathe'
import { array, boolean, integer, looseObject, maxValue, minValue, number, optional, parse, picklist, pipe, record, string, tupleWithRest, union, unknown } from 'valibot'

import { getPluginSpecifierKey, parsePluginSpecifier } from '../plugins/spec'

export { getPluginSpecifierKey, parsePluginSpecifier }
export type {
  DirectoryPluginSpecifier,
  ParsedPluginSpecifier,
  ParsePluginSpecifierOptions,
  RegistryPluginSpecifier,
}

export interface NormalizeLoadedAlintConfigOptions {
  configFile?: string
}

export interface ParsedStaticConfig {
  groups: ParsedStaticConfigGroup[]
}

export interface ParsedStaticConfigGroup {
  item: StaticConfigItem
  plugins: StaticPluginReference[]
}

export interface ParseStaticConfigOptions {
  configFile?: string
}

export type StaticConfigInput = readonly StaticConfigInput[] | StaticConfigItem

export interface StaticConfigItem extends Omit<AlintConfigItem, 'plugins'> {
  plugins?: Record<string, PluginDefinition | string>
}

export interface StaticPluginReference {
  alias: string
  specifier: ParsedPluginSpecifier
}

export type StaticPluginResolver = (
  reference: StaticPluginReference,
) => Promise<PluginDefinition>

export interface ToAlintConfigOptions {
  pluginResolver: StaticPluginResolver
}

interface StaticConfigWrapper {
  config?: {
    group?: unknown
  }
}

const filePatternSchema = union([
  string(),
  array(string()),
])
const ruleSeveritySchema = picklist(['error', 'off', 'warn'])
const ruleConfigEntrySchema = union([
  ruleSeveritySchema,
  tupleWithRest([ruleSeveritySchema], unknown()),
])
const staticConfigItemSchema = looseObject({
  agent: optional(unknown()),
  basePath: optional(string()),
  directories: optional(array(filePatternSchema)),
  extends: optional(array(unknown())),
  files: optional(array(filePatternSchema)),
  ignore: optional(looseObject({
    gitignore: optional(boolean()),
  })),
  ignores: optional(array(string())),
  integrations: optional(looseObject({
    stopGate: optional(looseObject({
      enabled: optional(boolean()),
      target: optional(picklist(['all', 'dirty-files'])),
      timeoutMs: optional(pipe(number(), integer(), minValue(1), maxValue(maximumStopGateTimeoutMs))),
    })),
  })),
  language: optional(string()),
  languageOptions: optional(record(string(), unknown())),
  linterOptions: optional(looseObject({
    noInlineConfig: optional(boolean()),
    reportUnregisteredLanguages: optional(ruleSeveritySchema),
    reportUnusedDisableDirectives: optional(ruleSeveritySchema),
  })),
  name: optional(string()),
  plugins: optional(record(string(), unknown())),
  processor: optional(unknown()),
  rules: optional(record(string(), ruleConfigEntrySchema)),
  runner: optional(unknown()),
  settings: optional(record(string(), unknown())),
})

export function normalizeLoadedAlintConfig(
  value: unknown,
  options: NormalizeLoadedAlintConfigOptions = {},
): AlintConfig {
  const items = toAlintConfigItems(value, options)
  assertStaticPluginsResolved(items)

  return items as AlintConfig
}

export function parseStaticConfig(
  value: unknown,
  options: ParseStaticConfigOptions = {},
): ParsedStaticConfig {
  const items = toAlintConfigItems(value, options)
  const pluginsByAlias = new Map<string, ParsedPluginSpecifier>()
  const groups = items.map((item): ParsedStaticConfigGroup => {
    const plugins = readStaticPluginReferences(item, pluginsByAlias, options)

    return {
      item,
      plugins,
    }
  })

  return { groups }
}

export async function toAlintConfig(
  config: ParsedStaticConfig,
  options: ToAlintConfigOptions,
): Promise<AlintConfig> {
  const pluginCache = new Map<string, Promise<PluginDefinition>>()

  return Promise.all(config.groups.map(group =>
    resolveStaticPlugins(group, options, pluginCache),
  ))
}

function assertStaticPluginsResolved(items: readonly StaticConfigItem[]): void {
  for (const item of items) {
    if (!isPlainObject(item.plugins)) {
      continue
    }

    for (const [alias, plugin] of Object.entries(item.plugins)) {
      if (typeof plugin === 'string') {
        throw new TypeError(`Static plugin "${alias}" requires async plugin resolution.`)
      }
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTomlConfig(configFile: string | undefined): boolean {
  return extname(configFile ?? '').toLowerCase() === '.toml'
}

function parseStaticConfigInputArray(
  value: readonly unknown[],
  arrayStack: readonly (readonly unknown[])[] = [],
): StaticConfigItem[] {
  if (arrayStack.includes(value)) {
    throw new Error('Circular static config array.')
  }

  return value.flatMap(item =>
    Array.isArray(item)
      ? parseStaticConfigInputArray(item, [...arrayStack, value])
      : [
          parseStaticConfigItem(item),
        ],
  )
}

function parseStaticConfigItem(value: unknown): StaticConfigItem {
  if (Array.isArray(value)) {
    throw new TypeError('Invalid type: Expected Object but received Array')
  }

  return parse(staticConfigItemSchema, value) as StaticConfigItem
}

function parseStaticConfigItems(value: readonly unknown[]): StaticConfigItem[] {
  return value.map(parseStaticConfigItem)
}

function readConfigGroup(value: unknown): undefined | unknown[] {
  if (!isPlainObject(value)) {
    return undefined
  }

  const wrapper = value as StaticConfigWrapper

  if (wrapper.config === undefined) {
    return undefined
  }

  if (!isPlainObject(wrapper.config) || !Array.isArray(wrapper.config.group)) {
    throw new TypeError('Static config field "config.group" must be an array.')
  }

  return wrapper.config.group
}

function readStaticPluginReferences(
  item: StaticConfigItem,
  pluginsByAlias: Map<string, ParsedPluginSpecifier>,
  options: ParseStaticConfigOptions,
): StaticPluginReference[] {
  if (!isPlainObject(item.plugins)) {
    return []
  }

  const references: StaticPluginReference[] = []

  for (const [alias, plugin] of Object.entries(item.plugins)) {
    if (typeof plugin !== 'string') {
      continue
    }

    const specifier = parsePluginSpecifier(plugin, options)
    const existing = pluginsByAlias.get(alias)

    if (
      existing !== undefined
      && getPluginSpecifierKey(existing) !== getPluginSpecifierKey(specifier)
    ) {
      throw new Error(
        `Static plugin "${alias}" is configured with multiple specifiers: "${existing.raw}" and "${specifier.raw}".`,
      )
    }

    pluginsByAlias.set(alias, specifier)
    references.push({ alias, specifier })
  }

  return references
}

async function resolveStaticPlugins(
  group: ParsedStaticConfigGroup,
  options: ToAlintConfigOptions,
  pluginCache: Map<string, Promise<PluginDefinition>>,
): Promise<AlintConfigItem> {
  if (group.item.plugins === undefined) {
    const { plugins: _plugins, ...item } = group.item

    return item
  }

  const plugins: Record<string, PluginDefinition> = {}

  for (const [alias, plugin] of Object.entries(group.item.plugins)) {
    if (typeof plugin !== 'string') {
      plugins[alias] = plugin
      continue
    }

    const reference = group.plugins.find(item => item.alias === alias)

    if (reference === undefined) {
      throw new Error(`Static plugin "${alias}" is missing a parsed plugin reference.`)
    }

    const pluginCacheKey = getPluginSpecifierKey(reference.specifier)
    let resolvedPlugin = pluginCache.get(pluginCacheKey)

    if (resolvedPlugin === undefined) {
      resolvedPlugin = options.pluginResolver(reference)
      pluginCache.set(pluginCacheKey, resolvedPlugin)
    }

    plugins[alias] = await resolvedPlugin
  }

  return { ...group.item, plugins }
}

function toAlintConfigItems(
  value: unknown,
  options: ParseStaticConfigOptions = {},
): StaticConfigItem[] {
  if (Array.isArray(value)) {
    return parseStaticConfigInputArray(value)
  }

  const group = readConfigGroup(value)

  if (group !== undefined) {
    return parseStaticConfigItems(group)
  }

  if (isTomlConfig(options.configFile)) {
    throw new Error('Static TOML config must use [[config.group]].')
  }

  if (value === undefined || value === null) {
    return []
  }

  throw new Error(
    'Static config must be a flat config array or { config: { group: [...] } }.',
  )
}

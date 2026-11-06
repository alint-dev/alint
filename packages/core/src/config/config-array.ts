import type {
  AlintConfig,
  AlintConfigInput,
  AlintConfigItem,
  PluginDefinition,
  RuleConfigEntry,
} from '../dsl/types'

import { minimatch } from 'minimatch'
import { isAbsolute, relative, resolve } from 'pathe'

const effectiveBasePathSymbol = Symbol('effectiveBasePath')
const inheritedMatcherScopesSymbol = Symbol('inheritedMatcherScopes')

export interface EffectiveAlintConfig {
  agent?: AlintConfigItem['agent']
  language?: string
  languageOptions: Record<string, unknown>
  linterOptions: Record<string, unknown>
  plugins: Record<string, PluginDefinition>
  processor?: AlintConfigItem['processor']
  rules: Record<string, RuleConfigEntry>
  runner?: AlintConfigItem['runner']
  settings: Record<string, unknown>
}

export interface ResolveConfigOptions {
  cwd: string
}

export interface ResolveConfigResult {
  config: EffectiveAlintConfig
  ignored: boolean
  matched: AlintConfigItem[]
  skipped: Array<{ item: AlintConfigItem, reason: string }>
}

type ConfigTargetKind = 'directory' | 'file' | 'project'

interface ExpandedConfigItem extends AlintConfigItem {
  [effectiveBasePathSymbol]?: string
  [inheritedMatcherScopesSymbol]?: MatcherScope[]
}

interface ExpandState {
  inheritedBasePath?: string
  inheritedMatcherScopes: MatcherScope[]
  objectStack: object[]
  plugins: Record<string, PluginDefinition>
  stringStack: string[]
}

interface MatcherScope {
  basePath?: string
  directories?: AlintConfigItem['directories']
  files?: AlintConfigItem['files']
  ignores?: AlintConfigItem['ignores']
}

export function hasDiscoveryFilePatterns(input: AlintConfig): boolean {
  return expandConfig(input).some(hasDiscoveryMatcher)
}

export function matchesDiscoveryFile(
  filePath: string,
  input: AlintConfig,
  options: ResolveConfigOptions,
): boolean {
  const result = resolveConfigForFile(filePath, input, options)

  if (result.ignored) {
    return false
  }

  return result.matched.some(hasDiscoveryMatcher)
}

export function normalizeConfig(input: readonly AlintConfigInput[]): AlintConfigItem[] {
  return normalizeConfigItems(input, [])
}

export function resolveConfigForDirectory(
  directoryPath: string,
  input: AlintConfig,
  options: ResolveConfigOptions,
): ResolveConfigResult {
  return resolveConfig(directoryPath, input, options, 'directory')
}

export function resolveConfigForFile(
  filePath: string,
  input: AlintConfig,
  options: ResolveConfigOptions,
): ResolveConfigResult {
  return resolveConfig(filePath, input, options, 'file')
}

export function resolveConfigForProject(
  projectPath: string,
  input: AlintConfig,
  options: ResolveConfigOptions,
): ResolveConfigResult {
  return resolveConfig(projectPath, input, options, 'project')
}

function createEmptyConfig(): EffectiveAlintConfig {
  return {
    languageOptions: {},
    linterOptions: {},
    plugins: {},
    rules: {},
    settings: {},
  }
}

function createMatcherScope(item: AlintConfigItem, basePath: string | undefined): MatcherScope | undefined {
  if (!item.directories && !item.files && !item.ignores) {
    return undefined
  }

  return {
    basePath,
    directories: item.directories,
    files: item.files,
    ignores: item.ignores,
  }
}

function expandConfig(input: AlintConfig): ExpandedConfigItem[] {
  return expandExtends(normalizeConfig(input), {
    inheritedBasePath: undefined,
    inheritedMatcherScopes: [],
    objectStack: [],
    plugins: {},
    stringStack: [],
  })
}

function expandExtends(
  items: AlintConfigItem[],
  state: ExpandState,
): ExpandedConfigItem[] {
  const expanded: AlintConfigItem[] = []

  for (const item of items) {
    if (state.objectStack.includes(item)) {
      throw new Error('Circular inline config extends.')
    }

    const effectiveBasePath = item.basePath ?? state.inheritedBasePath
    const itemObjectStack = [...state.objectStack, item]
    const itemMatcherScope = createMatcherScope(item, effectiveBasePath)
    const childMatcherScopes = itemMatcherScope
      ? [...state.inheritedMatcherScopes, itemMatcherScope]
      : state.inheritedMatcherScopes
    const plugins = {
      ...state.plugins,
      ...item.plugins,
    }

    for (const extension of item.extends ?? []) {
      if (typeof extension === 'string') {
        expanded.push(...resolvePluginConfig(extension, {
          inheritedBasePath: effectiveBasePath,
          inheritedMatcherScopes: childMatcherScopes,
          objectStack: itemObjectStack,
          plugins,
          stringStack: state.stringStack,
        }))
      }
      else {
        if (state.objectStack.includes(extension)) {
          throw new Error('Circular inline config extends.')
        }

        expanded.push(...expandExtends(normalizeConfig([extension]), {
          inheritedBasePath: effectiveBasePath,
          inheritedMatcherScopes: childMatcherScopes,
          objectStack: itemObjectStack,
          plugins,
          stringStack: state.stringStack,
        }))
      }
    }

    expanded.push(withExpansionMetadata(
      { ...item, extends: undefined },
      state.inheritedMatcherScopes,
      effectiveBasePath,
    ))
  }

  return expanded as ExpandedConfigItem[]
}

function getEffectiveBasePath(item: AlintConfigItem): string | undefined {
  return (item as ExpandedConfigItem)[effectiveBasePathSymbol] ?? item.basePath
}

function getInheritedMatcherScopes(item: AlintConfigItem): readonly MatcherScope[] {
  return (item as ExpandedConfigItem)[inheritedMatcherScopesSymbol] ?? []
}

function hasDiscoveryMatcher(item: AlintConfigItem): boolean {
  return hasPositiveFilePattern(item.files)
    || getInheritedMatcherScopes(item).some(scope => hasPositiveFilePattern(scope.files))
}

function hasOtherTargetPatterns(item: MatcherScope, targetKind: ConfigTargetKind): boolean {
  if (targetKind === 'project') {
    return item.files !== undefined || item.directories !== undefined
  }

  return targetKind === 'directory'
    ? item.files !== undefined
    : item.directories !== undefined
}

function hasPositiveFilePattern(files: AlintConfigItem['files']): boolean {
  return files?.some(pattern =>
    isPatternList(pattern)
      ? pattern.some(isPositivePattern)
      : isPositivePattern(pattern),
  ) ?? false
}

function isConfigArrayInput(input: AlintConfigInput): input is readonly AlintConfigInput[] {
  return Array.isArray(input)
}

function isGlobalIgnoreItem(item: AlintConfigItem): boolean {
  const keys = Object.keys(item).filter(key => item[key as keyof AlintConfigItem] !== undefined)

  return item.ignores !== undefined && keys.every(key => key === 'ignores' || key === 'name')
}

function isPatternList(pattern: readonly string[] | string): pattern is readonly string[] {
  return Array.isArray(pattern)
}

function isPositivePattern(pattern: string): boolean {
  return !pattern.startsWith('!')
}

function matchesConfigItem(
  filePath: string,
  item: AlintConfigItem,
  cwd: string,
  targetKind: ConfigTargetKind,
): boolean {
  const basePath = getEffectiveBasePath(item)

  if (!matchesInheritedScopes(filePath, item, cwd, targetKind)) {
    return false
  }

  if (matchesIgnores(filePath, item.ignores ?? [], cwd, basePath, targetKind)) {
    return false
  }

  const patterns = targetPatterns(item, targetKind)

  if (patterns !== undefined) {
    return patterns.length === 0
      || patterns.some(pattern => matchesPattern(filePath, pattern, cwd, basePath))
  }

  return !hasOtherTargetPatterns(item, targetKind)
}

function matchesIgnores(
  targetPath: string,
  patterns: readonly string[],
  cwd: string,
  basePath: string | undefined,
  targetKind: ConfigTargetKind,
): boolean {
  return patterns.some(pattern => matchesPattern(
    targetPath,
    pattern,
    cwd,
    basePath,
    targetKind === 'project',
  ))
}

function matchesInheritedScopes(
  filePath: string,
  item: AlintConfigItem,
  cwd: string,
  targetKind: ConfigTargetKind,
): boolean {
  return getInheritedMatcherScopes(item).every((scope) => {
    if (matchesIgnores(filePath, scope.ignores ?? [], cwd, scope.basePath, targetKind)) {
      return false
    }

    const patterns = targetPatterns(scope, targetKind)

    if (patterns !== undefined) {
      return patterns.length === 0
        || patterns.some(pattern => matchesPattern(filePath, pattern, cwd, scope.basePath))
    }

    return !hasOtherTargetPatterns(scope, targetKind)
  })
}

function matchesPattern(
  filePath: string,
  pattern: readonly string[] | string,
  cwd: string,
  basePath?: string,
  matchDirectoryRoot = false,
): boolean {
  if (isPatternList(pattern)) {
    return pattern.every(entry => matchesPattern(filePath, entry, cwd, basePath, matchDirectoryRoot))
  }

  const base = basePath
    ? resolve(cwd, basePath)
    : cwd
  const relativePath = relative(base, isAbsolute(filePath)
    ? filePath
    : resolve(cwd, filePath)).replaceAll('\\', '/')

  if (relativePath === '..' || relativePath.startsWith('../')) {
    return false
  }

  return minimatch(relativePath, pattern, { dot: true })
    || (matchDirectoryRoot && minimatch(`${relativePath}/`, pattern, { dot: true }))
}

function mergeConfig(config: EffectiveAlintConfig, item: AlintConfigItem): void {
  if (item.plugins) {
    for (const [alias, plugin] of Object.entries(item.plugins)) {
      const existingPlugin = config.plugins[alias]
      if (existingPlugin && existingPlugin !== plugin) {
        throw new Error(`Duplicate plugin alias "${alias}".`)
      }

      config.plugins[alias] = plugin
    }
  }

  Object.assign(config.rules, item.rules)
  Object.assign(config.settings, item.settings)
  Object.assign(config.languageOptions, item.languageOptions)
  Object.assign(config.linterOptions, item.linterOptions)

  if (item.agent !== undefined) {
    config.agent = item.agent
  }

  if (item.language !== undefined) {
    config.language = item.language
  }

  if (item.processor !== undefined) {
    config.processor = item.processor
  }

  if (item.runner !== undefined) {
    config.runner = {
      ...config.runner,
      ...item.runner,
    }
  }
}

function normalizeConfigItems(
  input: readonly AlintConfigInput[],
  arrayStack: readonly (readonly AlintConfigInput[])[],
): AlintConfigItem[] {
  if (arrayStack.includes(input)) {
    throw new Error('Circular config array.')
  }

  return input.flatMap(item =>
    isConfigArrayInput(item)
      ? normalizeConfigItems(item, [...arrayStack, input])
      : [item],
  )
}

function resolveConfig(
  targetPath: string,
  input: AlintConfig,
  options: ResolveConfigOptions,
  targetKind: ConfigTargetKind,
): ResolveConfigResult {
  const items = expandConfig(input)
  const matched: AlintConfigItem[] = []
  const skipped: ResolveConfigResult['skipped'] = []
  const config = createEmptyConfig()

  for (const item of items) {
    if (isGlobalIgnoreItem(item)) {
      if (matchesInheritedScopes(targetPath, item, options.cwd, targetKind)
        && matchesIgnores(
          targetPath,
          item.ignores ?? [],
          options.cwd,
          getEffectiveBasePath(item),
          targetKind,
        )) {
        return {
          config: createEmptyConfig(),
          ignored: true,
          matched: [],
          skipped,
        }
      }

      skipped.push({ item, reason: 'global ignores did not match' })
      continue
    }

    if (!matchesConfigItem(targetPath, item, options.cwd, targetKind)) {
      skipped.push({ item, reason: 'target patterns or ignores did not match' })
      continue
    }

    matched.push(item)
    mergeConfig(config, item)
  }

  return {
    config,
    ignored: false,
    matched,
    skipped,
  }
}

function resolvePluginConfig(
  reference: string,
  state: ExpandState,
): ExpandedConfigItem[] {
  if (state.stringStack.includes(reference)) {
    throw new Error(`Circular config extends: ${[...state.stringStack, reference].join(' -> ')}`)
  }

  const separator = reference.indexOf('/')
  const alias = reference.slice(0, separator)
  const name = reference.slice(separator + 1)
  const config = state.plugins[alias]?.configs?.[name]

  if (!config) {
    throw new Error(`Unknown config "${reference}".`)
  }

  return expandExtends(normalizeConfig([config]), {
    ...state,
    stringStack: [...state.stringStack, reference],
  })
}

function targetPatterns(
  item: MatcherScope,
  targetKind: ConfigTargetKind,
): AlintConfigItem['directories'] | AlintConfigItem['files'] | undefined {
  if (targetKind === 'directory') {
    return item.directories
  }

  if (targetKind === 'file') {
    return item.files
  }

  return undefined
}

function withExpansionMetadata(
  item: AlintConfigItem,
  inheritedMatcherScopes: MatcherScope[],
  effectiveBasePath: string | undefined,
): ExpandedConfigItem {
  Object.defineProperties(item, {
    [effectiveBasePathSymbol]: {
      value: effectiveBasePath,
    },
    [inheritedMatcherScopesSymbol]: {
      value: inheritedMatcherScopes,
    },
  })

  return item as ExpandedConfigItem
}

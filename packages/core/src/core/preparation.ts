import type { AgentAdapter } from '../agent/types'
import type { EffectiveAlintConfig } from '../config/config-array'
import type { AlintConfig, DirectoryTarget, EnabledRule, LanguageDefinition } from '../dsl/types'
import type { LanguageRegistry } from './languages'
import type { MissingLanguage, UnregisteredLanguage } from './languages/diagnostics'
import type { SourceRuntime } from './source/types'
import type { RunOptions } from './types'

import { cwd as processCwd } from 'node:process'

import { resolve } from 'pathe'

import { resolveConfigForDirectory, resolveConfigForFile, resolveConfigForProject } from '../config/config-array'
import { buildRuleRegistry } from '../dsl/registry'
import { stableHash } from './hash'
import { createBuiltInLanguageRegistry, registerLanguage, resolveLanguageForPath } from './languages'
import { recordMissingLanguage, recordUnregistered, unregisteredLanguageSeverity } from './languages/diagnostics'
import { isTargetLanguageAccepted, resolveRuleLanguages } from './languages/rule-languages'
import { matchesRuleFilter } from './rule-filter'

export interface PreparationIndex {
  directories: readonly PreparedDirectoryInput[]
  files: readonly PreparedInput[]
  /**
   * Languages that enabled rules named and no plugin registered, grouped by language id. `run` turns
   * these into error-severity `alint/missing-language` diagnostics.
   */
  missingLanguages: ReadonlyMap<string, MissingLanguage>
  project?: PreparedProjectInput
  /**
   * Linted files no language claimed, so they were handled as plain text. Reports are grouped by
   * extension so one missing language pack is one diagnostic, not one per file. `run` turns these into
   * `alint/unregistered-language` diagnostics. Empty when nothing mismatched.
   */
  unregisteredLanguages: ReadonlyMap<string, UnregisteredLanguage>
}

export interface PreparedDirectoryInput {
  agent?: AgentAdapter
  configHash: string
  directoryIndex: number
  rules: readonly PreparedRule[]
  settings: Record<string, unknown>
  target: DirectoryTarget
}

export interface PreparedInput {
  agent?: AgentAdapter
  configHash: string
  fileIndex: number
  language: LanguageDefinition
  languageOptions: Record<string, unknown>
  path: string
  rules: readonly PreparedRule[]
  settings: Record<string, unknown>
}

export interface PreparedProjectInput {
  agent?: AgentAdapter
  configHash: string
  root: string
  rules: readonly PreparedRule[]
  settings: Record<string, unknown>
}

export interface PreparedRule {
  enabledRule: EnabledRule
  // Zero-based enabled-registry position, distinct from a job's per-rule occurrence index.
  ruleIndex: number
}

/**
 * The `ctx.src.extract` a run hands to rules, for parsing files it was never asked to lint, which
 * an index builder sweeping the workspace needs.
 *
 * It resolves each file's OWN config rather than a caller's, because the language a file resolves to
 * is a config decision and two config groups may register different plugins. It extracts on demand
 * and holds nothing: source planning releases rich extractor values after compact jobs are admitted,
 * and a run-wide parse memo here would put that retention back. A caller keeps only what it derives.
 *
 * `getSrc` defers reading the runtime because the runtime is built around this closure. It is assigned
 * before any rule runs, so by the first call it is present.
 */
export function createSourceExtractor(
  cwd: string,
  config: AlintConfig,
  getSrc: () => SourceRuntime,
): SourceRuntime['extract'] {
  return async (filePath, options = {}) => {
    const path = resolve(cwd, filePath)
    const resolvedConfig = resolveConfigForFile(path, config, { cwd })

    // An ignored file is not a missing language: the config excluded it, so a caller sweeping the
    // tree should skip it, not fail. Returning nothing lets every caller do that without guarding.
    if (resolvedConfig.ignored)
      return []

    const effectiveConfig = resolvedConfig.config
    const language = resolveLanguageForPath(path, createLanguageRegistry(effectiveConfig), {
      language: options.language ?? effectiveConfig.language,
    })
    const src = getSrc()
    const file = await src.readFile(path)

    return language.extract(file, { cwd, languageOptions: effectiveConfig.languageOptions, src })
  }
}

export function prepareRun(options: RunOptions = {}): PreparationIndex {
  const cwd = options.cwd ?? processCwd()
  const config = options.config ?? []
  const ruleFilter = options.ruleFilter ?? []
  const files: PreparedInput[] = []
  const directories: PreparedDirectoryInput[] = []
  const knownRuleIds = new Set<string>()
  const missingLanguages = new Map<string, MissingLanguage>()
  const unregisteredLanguages = new Map<string, UnregisteredLanguage>()

  const prepareRulesFor = (effectiveConfig: EffectiveAlintConfig): PreparedRule[] => {
    const enabledRules = buildRuleRegistry(effectiveConfig).enabledRules
    for (const enabledRule of enabledRules)
      knownRuleIds.add(enabledRule.id)

    return prepareRules(enabledRules, ruleFilter)
  }

  for (const filePath of options.files ?? []) {
    const path = resolve(cwd, filePath)
    const resolvedConfig = resolveConfigForFile(path, config, { cwd })
    if (resolvedConfig.ignored)
      continue

    const effectiveConfig = resolvedConfig.config
    const languageRegistry = createLanguageRegistry(effectiveConfig)
    const language = resolveLanguageForPath(path, languageRegistry, { language: effectiveConfig.language })
    const rules = prepareRulesFor(effectiveConfig)

    recordMissingLanguages(missingLanguages, rules, languageRegistry, path)

    // The mismatch only the run can see: rules that need a real language were configured for this
    // file, yet nothing claimed its extension, so it fell back to plain text and those rules are
    // turned away. An explicit `language:` pin (including `plaintext`) is intent and stays silent.
    if (
      effectiveConfig.language === undefined
      && language.name === 'plaintext'
      && rules.some(({ enabledRule }) => !isTargetLanguageAccepted(resolveRuleLanguages(enabledRule.rule.languages), 'file', 'plaintext'))
    ) {
      recordUnregistered(unregisteredLanguages, path, unregisteredLanguageSeverity(effectiveConfig.linterOptions))
    }

    files.push({
      agent: effectiveConfig.agent,
      configHash: stableHash({
        language: effectiveConfig.language,
        languageOptions: effectiveConfig.languageOptions,
        processor: effectiveConfig.processor,
        resolvedLanguage: language.name,
        settings: effectiveConfig.settings,
      }),
      fileIndex: files.length,
      language,
      languageOptions: effectiveConfig.languageOptions,
      path,
      rules,
      settings: effectiveConfig.settings,
    })
  }

  for (const directoryPath of options.directories ?? []) {
    const path = resolve(cwd, directoryPath)
    const resolvedConfig = resolveConfigForDirectory(path, config, { cwd })
    if (resolvedConfig.ignored)
      continue

    const effectiveConfig = resolvedConfig.config
    directories.push({
      agent: effectiveConfig.agent,
      configHash: stableHash({ settings: effectiveConfig.settings }),
      directoryIndex: directories.length,
      rules: prepareRulesFor(effectiveConfig),
      settings: effectiveConfig.settings,
      target: { kind: 'directory', path },
    })
  }

  const project = options.projectTargets === false ? undefined : prepareProject(cwd, config, prepareRulesFor)

  if (ruleFilter.length > 0 && !hasPreparedRule(files, directories, project))
    throw new Error(formatUnmatchedRuleFilter(ruleFilter, knownRuleIds))

  return {
    directories,
    files,
    missingLanguages,
    project,
    unregisteredLanguages,
  }
}

function createLanguageRegistry(config: EffectiveAlintConfig) {
  const registry = createBuiltInLanguageRegistry()

  for (const plugin of Object.values(config.plugins)) {
    for (const language of Object.values(plugin.languages ?? {}))
      registerLanguage(registry, language)
  }

  return registry
}

function formatUnmatchedRuleFilter(ruleFilter: readonly string[], knownRuleIds: ReadonlySet<string>): string {
  const patterns = ruleFilter.map(pattern => `"${pattern}"`).join(', ')
  const knownIds = [...knownRuleIds].sort()
  const known = knownIds.length === 0
    ? 'This run enabled no rule at all. Run `alint config inspect <file>` to see which rules apply to a file.'
    : `Enabled rules: ${knownIds.slice(0, 20).join(', ')}${knownIds.length > 20 ? ', ...' : ''}.`

  return `No enabled rule matched --rule ${patterns}. ${known}`
}

function hasPreparedRule(
  files: readonly PreparedInput[],
  directories: readonly PreparedDirectoryInput[],
  project: PreparedProjectInput | undefined,
): boolean {
  return files.some(input => input.rules.length > 0)
    || directories.some(input => input.rules.length > 0)
    || (project?.rules.length ?? 0) > 0
}

function prepareProject(
  root: string,
  config: AlintConfig,
  prepareRulesFor: (config: EffectiveAlintConfig) => PreparedRule[],
): PreparedProjectInput | undefined {
  const resolvedConfig = resolveConfigForProject(root, config, { cwd: root })
  if (resolvedConfig.ignored)
    return undefined

  const effectiveConfig = resolvedConfig.config
  return {
    agent: effectiveConfig.agent,
    configHash: stableHash({ settings: effectiveConfig.settings }),
    root,
    rules: prepareRulesFor(effectiveConfig),
    settings: effectiveConfig.settings,
  }
}

/**
 * Keeps the registry position of every surviving rule: `ruleIndex` is an enabled-registry
 * position that jobs and progress refs share, so filtering must not renumber the rules that stay.
 */
function prepareRules(enabledRules: readonly EnabledRule[], ruleFilter: readonly string[]): PreparedRule[] {
  return enabledRules
    .map((enabledRule, ruleIndex) => ({ enabledRule, ruleIndex }))
    .filter(rule => ruleFilter.length === 0 || matchesRuleFilter(rule.enabledRule, ruleFilter))
}

function recordMissingLanguages(
  into: Map<string, MissingLanguage>,
  rules: readonly PreparedRule[],
  registry: LanguageRegistry,
  path: string,
): void {
  for (const { enabledRule } of rules) {
    const languages = resolveRuleLanguages(enabledRule.rule.languages)

    if (languages.kind !== 'list' || languages.skipMissing)
      continue

    for (const languageId of languages.ids) {
      if (!registry.languages.has(languageId))
        recordMissingLanguage(into, languageId, enabledRule.id, path)
    }
  }
}

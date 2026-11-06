import type {
  ModelSize,
  ProviderType,
  RunnerConfig,
  SetupModelDefinition,
} from '@alint-js/core'

import type { AcpModelConfig, ModelConfig, ProviderConfig, SetupConfig } from './types'

import { parse as parseToml, stringify } from 'smol-toml'
import { array, boolean, check, finite, integer, literal, minValue, nonEmpty, number, object, optional, parse, picklist, pipe, record, string, transform, undefined_, union, unknown, variant } from 'valibot'

import { isAcpModel } from './types'

const modelEntries = {
  aliases: optional(array(string())),
  capabilities: optional(array(string())),
  context_window: optional(number()),
  default_params: optional(record(string(), unknown())),
  driver: optional(undefined_()),
  id: pipe(string(), nonEmpty('Model id must be a non-empty string.')),
  name: optional(string()),
  size: optional(picklist(['large', 'medium', 'small'])),
}

const providerModelSchema = object(modelEntries)

const acpModelSchema = object({
  ...modelEntries,
  args: optional(array(string())),
  command: pipe(string(), nonEmpty('ACP model command must be a non-empty string.')),
  cwd: optional(pipe(string(), nonEmpty('ACP model cwd must be a non-empty string.'))),
  driver: literal('acp'),
  env: optional(record(string(), string())),
})

const modelSchema = pipe(
  variant('driver', [acpModelSchema, providerModelSchema]),
  transform(({ context_window: contextWindow, default_params: defaultParams, ...model }): ModelConfig => ({
    ...model,
    ...(contextWindow === undefined
      ? {}
      : { contextWindow }),
    ...(defaultParams === undefined
      ? {}
      : { defaultParams }),
  })),
)
const providerSchema = pipe(
  object({
    endpoint: optional(pipe(string(), nonEmpty('Provider endpoint must be a non-empty string.'))),
    headers: optional(record(string(), string())),
    id: pipe(string(), nonEmpty('Provider id must be a non-empty string.')),
    models: array(modelSchema),
    type: optional(literal('openai-compatible')),
  }),
  check(
    provider => provider.models.every(isAcpModel) || provider.type === 'openai-compatible',
    issue => `Invalid provider "${issue.input.id}": type is required for models without a driver.`,
  ),
  check(
    provider => provider.models.every(isAcpModel) || provider.endpoint !== undefined,
    issue => `Invalid provider "${issue.input.id}": endpoint is required for models without a driver.`,
  ),
)

const runnerCacheSchema = union([
  boolean(),
  object({
    enabled: optional(boolean()),
    location: optional(pipe(
      string('Invalid runner cache location: must be a string.'),
      nonEmpty('Invalid runner cache location: must be a non-empty string.'),
    )),
  }),
])

const positiveIntegerSchemas = {
  retentionMonths: pipe(
    number('Invalid runner stats retention_months: must be a positive integer.'),
    integer('Invalid runner stats retention_months: must be a positive integer.'),
    minValue(1, 'Invalid runner stats retention_months: must be a positive integer.'),
  ),
  ruleConcurrency: pipe(
    number('Invalid runner rule_concurrency: must be a positive integer.'),
    integer('Invalid runner rule_concurrency: must be a positive integer.'),
    minValue(1, 'Invalid runner rule_concurrency: must be a positive integer.'),
  ),
  timeoutMs: pipe(
    number('Invalid runner timeout_ms: must be a positive integer.'),
    integer('Invalid runner timeout_ms: must be a positive integer.'),
    minValue(1, 'Invalid runner timeout_ms: must be a positive integer.'),
  ),
}

const runnerStatsSchema = union([
  boolean(),
  pipe(
    object({
      enabled: optional(boolean()),
      location: optional(pipe(
        string('Invalid runner stats location: must be a string.'),
        nonEmpty('Invalid runner stats location: must be a non-empty string.'),
      )),
      retention_months: optional(positiveIntegerSchemas.retentionMonths),
    }),
    transform(({ retention_months: retentionMonths, ...stats }) => ({
      ...stats,
      ...(retentionMonths === undefined
        ? {}
        : { retentionMonths }),
    })),
  ),
])

const runnerSchema = pipe(
  object({
    agent_retries: optional(pipe(
      number('Invalid runner agent_retries: must be a finite number.'),
      finite('Invalid runner agent_retries: must be a finite number.'),
    )),
    cache: optional(runnerCacheSchema),
    rule_concurrency: optional(positiveIntegerSchemas.ruleConcurrency),
    stats: optional(runnerStatsSchema),
    timeout_ms: optional(positiveIntegerSchemas.timeoutMs),
  }),
  transform(({
    agent_retries: agentRetries,
    rule_concurrency: ruleConcurrency,
    timeout_ms: timeoutMs,
    ...runner
  }): RunnerConfig => ({
    ...runner,
    ...(agentRetries === undefined
      ? {}
      : { agentRetries }),
    ...(ruleConcurrency === undefined
      ? {}
      : { ruleConcurrency }),
    ...(timeoutMs === undefined
      ? {}
      : { timeoutMs }),
  })),
)

const setupConfigSchema = pipe(
  object({
    providers: optional(array(providerSchema), []),
    runner: optional(runnerSchema),
    version: literal(1, 'Invalid setup config: version must be 1.'),
  }),
  transform(({ runner, ...config }): SetupConfig => ({
    ...config,
    ...(runner === undefined
      ? {}
      : { runner }),
  })),
)

interface StringifiableAcpModelConfig extends StringifiableSetupModelDefinition {
  args?: string[]
  command: string
  cwd?: string
  driver: 'acp'
  env?: Record<string, string>
}

interface StringifiableProviderDefinition {
  endpoint?: string
  headers?: Record<string, string>
  id: string
  models: Array<StringifiableAcpModelConfig | StringifiableSetupModelDefinition>
  type?: ProviderType
}

interface StringifiableRunnerCacheConfig {
  enabled?: boolean
  location?: string
}

interface StringifiableRunnerConfig {
  agent_retries?: number
  cache?: boolean | StringifiableRunnerCacheConfig
  rule_concurrency?: number
  stats?: boolean | StringifiableRunnerStatsConfig
  timeout_ms?: number
}

interface StringifiableRunnerStatsConfig {
  enabled?: boolean
  location?: string
  retention_months?: number
}

interface StringifiableSetupConfig {
  providers: StringifiableProviderDefinition[]
  runner?: StringifiableRunnerConfig
  version: 1
}

interface StringifiableSetupModelDefinition {
  aliases?: string[]
  capabilities?: string[]
  context_window?: number
  default_params?: Record<string, unknown>
  id: string
  name?: string
  size?: ModelSize
}

export function parseSetupConfigToml(toml: string): SetupConfig {
  return parse(setupConfigSchema, parseToml(toml))
}

export function stringifySetupConfigToml(config: SetupConfig): string {
  const stringifiableConfig: StringifiableSetupConfig = {
    providers: config.providers.map(toTomlProvider),
    version: config.version,
  }

  if (config.runner !== undefined) {
    stringifiableConfig.runner = toTomlRunner(config.runner)
  }

  return stringify(stringifiableConfig)
}

function toTomlAcpModel(model: AcpModelConfig): StringifiableAcpModelConfig {
  return {
    ...toTomlModel(model),
    args: model.args,
    command: model.command,
    cwd: model.cwd,
    driver: 'acp',
    env: model.env,
  }
}

function toTomlModel(
  model: SetupModelDefinition,
): StringifiableSetupModelDefinition {
  const tomlModel: StringifiableSetupModelDefinition = {
    id: model.id,
  }

  if (model.name !== undefined) {
    tomlModel.name = model.name
  }

  if (model.aliases !== undefined) {
    tomlModel.aliases = model.aliases
  }

  if (model.capabilities !== undefined) {
    tomlModel.capabilities = model.capabilities
  }

  if (model.size !== undefined) {
    tomlModel.size = model.size
  }

  if (model.contextWindow !== undefined) {
    tomlModel.context_window = model.contextWindow
  }

  if (model.defaultParams !== undefined) {
    tomlModel.default_params = model.defaultParams
  }

  return tomlModel
}

function toTomlProvider(
  provider: ProviderConfig,
): StringifiableProviderDefinition {
  const tomlProvider: StringifiableProviderDefinition = {
    endpoint: provider.endpoint,
    id: provider.id,
    models: provider.models.map(model => 'driver' in model && model.driver === 'acp'
      ? toTomlAcpModel(model)
      : toTomlModel(model)),
    type: provider.type,
  }

  if (provider.headers !== undefined) {
    tomlProvider.headers = provider.headers
  }

  return tomlProvider
}

function toTomlRunner(runner: RunnerConfig): StringifiableRunnerConfig {
  return {
    agent_retries: runner.agentRetries,
    cache: toTomlRunnerCache(runner.cache),
    rule_concurrency: runner.ruleConcurrency,
    stats: toTomlRunnerStats(runner.stats),
    timeout_ms: runner.timeoutMs,
  }
}

function toTomlRunnerCache(
  cache: RunnerConfig['cache'],
): StringifiableRunnerConfig['cache'] {
  return cache
}

function toTomlRunnerStats(
  stats: RunnerConfig['stats'],
): StringifiableRunnerConfig['stats'] {
  if (stats === undefined || typeof stats === 'boolean') {
    return stats
  }

  const tomlStats: StringifiableRunnerStatsConfig = {
    enabled: stats.enabled,
    location: stats.location,
    retention_months: stats.retentionMonths,
  }

  return tomlStats
}

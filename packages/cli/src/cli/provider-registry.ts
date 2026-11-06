import type { ProviderDefinition, SetupConfig, SetupModelDefinition } from '@alint-js/config'
import type { ModelBenchmarkProgress, ModelBenchmarkResult } from '@alint-js/core'

import { getBorderCharacters, table } from 'table'
import { createColors } from 'tinyrainbow'

import { escapeLineValue } from './output'
import { formatMiniBar } from './reporters/progress/bar'

export interface AcpProviderSetupSource {
  args?: string[]
  command: string
  defaultProviderId: string
  kind: 'acp'
  label: string
  model: {
    id: string
    name: string
  }
  value: 'claudeCodeAcp' | 'codexAcp' | 'geminiCliAcp' | 'kimiCliAcp' | 'openCodeAcp'
}

export interface FlattenedModel {
  model: SetupModelDefinition
  provider: ProviderDefinition
}

export interface FormatModelBenchmarkListOptions {
  color?: boolean
}

export interface FormatModelBenchmarkProgressListOptions extends FormatModelBenchmarkListOptions {
  frame: string
  maxRows?: number
  tick: number
}

export interface ModelBenchmarkProgressFrame {
  rows: readonly ModelBenchmarkProgressFrameRow[]
}

export interface ModelBenchmarkProgressFrameRow {
  prefix: string
  suffix: string
}

export interface OpenAICompatibleProviderSetupSource {
  benchmarkConcurrency: number
  defaultEndpoint?: string
  defaultProviderId?: string
  kind: 'openai-compatible'
  label: string
  probeModels: boolean
  value: 'cerebras' | 'cliProxyApi' | 'custom' | 'groq' | 'manual' | 'ollama' | 'openrouter'
}

export type ProviderSetupSource = AcpProviderSetupSource | OpenAICompatibleProviderSetupSource

const colors = createColors({ force: true })
const defaultBenchmarkConcurrency = 2

export function formatDuplicateModelIdentity(identity: string): string {
  return [
    `model "${escapeLineValue(identity)}" is configured more than once.`,
    'remove duplicate provider/model definitions from the setup configuration.',
    '',
  ].join('\n')
}

export const providerSetupSources: ProviderSetupSource[] = [
  {
    benchmarkConcurrency: 2,
    defaultEndpoint: 'http://127.0.0.1:8317/v1',
    defaultProviderId: 'CLIProxyAPI',
    kind: 'openai-compatible',
    label: 'CLIProxyAPI',
    probeModels: true,
    value: 'cliProxyApi',
  },
  {
    benchmarkConcurrency: 2,
    kind: 'openai-compatible',
    label: 'Custom OpenAI-compatible provider',
    probeModels: true,
    value: 'custom',
  },
  {
    benchmarkConcurrency: 20,
    defaultEndpoint: 'https://openrouter.ai/api/v1',
    defaultProviderId: 'openrouter',
    kind: 'openai-compatible',
    label: 'OpenRouter',
    probeModels: true,
    value: 'openrouter',
  },
  {
    benchmarkConcurrency: 2,
    defaultEndpoint: 'https://api.cerebras.ai/v1',
    defaultProviderId: 'cerebras',
    kind: 'openai-compatible',
    label: 'Cerebras',
    probeModels: true,
    value: 'cerebras',
  },
  {
    benchmarkConcurrency: 2,
    defaultEndpoint: 'https://api.groq.com/openai/v1',
    defaultProviderId: 'groq',
    kind: 'openai-compatible',
    label: 'Groq',
    probeModels: true,
    value: 'groq',
  },
  {
    benchmarkConcurrency: 2,
    defaultEndpoint: 'http://localhost:11434/v1',
    kind: 'openai-compatible',
    label: 'Ollama',
    probeModels: true,
    value: 'ollama',
  },
  {
    benchmarkConcurrency: 2,
    kind: 'openai-compatible',
    label: 'Manual model entry',
    probeModels: false,
    value: 'manual',
  },
  // NOTICE: Launch command adapted from `https://github.com/agentclientprotocol/registry/blob/1b16fc11f382572ad88d5b19a96f040a71383846/claude-acp/agent.json#L13-L16`.
  {
    args: ['-y', '@agentclientprotocol/claude-agent-acp'],
    command: 'npx',
    defaultProviderId: 'claude-code',
    kind: 'acp',
    label: 'Claude Code (ACP)',
    model: { id: 'claude-code', name: 'Claude Code' },
    value: 'claudeCodeAcp',
  },
  // NOTICE: Launch command adapted from `https://github.com/agentclientprotocol/codex-acp/blob/0d45a13c2618e8175a24d0bb080a482c7920f291/README.md#L20-L26`.
  {
    args: ['-y', '@agentclientprotocol/codex-acp'],
    command: 'npx',
    defaultProviderId: 'codex',
    kind: 'acp',
    label: 'Codex (ACP)',
    model: { id: 'codex', name: 'Codex' },
    value: 'codexAcp',
  },
  // NOTICE: Launch command adapted from `https://github.com/agentclientprotocol/registry/blob/1b16fc11f382572ad88d5b19a96f040a71383846/gemini/agent.json#L12-L18`.
  {
    args: ['-y', '@google/gemini-cli', '--acp'],
    command: 'npx',
    defaultProviderId: 'gemini-cli',
    kind: 'acp',
    label: 'Gemini CLI (ACP)',
    model: { id: 'gemini-cli', name: 'Gemini CLI' },
    value: 'geminiCliAcp',
  },
  // NOTICE: Launch command adapted from `https://github.com/MoonshotAI/kimi-code/blob/0b2e803d5e71afaab45212bb2ee6117ecbf8bbc9/docs/en/reference/kimi-acp.md#L1-L12`.
  {
    args: ['acp'],
    command: 'kimi',
    defaultProviderId: 'kimi-code',
    kind: 'acp',
    label: 'Kimi Code CLI (ACP)',
    model: { id: 'kimi-code', name: 'Kimi Code CLI' },
    value: 'kimiCliAcp',
  },
  // NOTICE: Launch command adapted from `https://github.com/anomalyco/opencode/blob/284214c78d32a09fd9c729bdefc07be50f74eb40/packages/web/src/content/docs/acp.mdx#L28-L39`.
  {
    args: ['acp'],
    command: 'opencode',
    defaultProviderId: 'opencode',
    kind: 'acp',
    label: 'OpenCode (ACP)',
    model: { id: 'opencode', name: 'OpenCode' },
    value: 'openCodeAcp',
  },
]

export function buildModelsUrl(endpoint: string): string {
  return new URL('models', endpoint.endsWith('/')
    ? endpoint
    : `${endpoint}/`).toString()
}

export function createProviderId(endpoint: string, existingIds: Set<string>): string {
  let base = 'provider'

  try {
    const url = new URL(endpoint)
    const source = findProviderSetupSourceByEndpoint(url)
    base = normalizeProviderIdBase(
      source?.defaultProviderId
      ?? source?.label
      ?? url.hostname,
    )
  }
  catch {
    base = 'provider'
  }

  if (!existingIds.has(base)) {
    return base
  }

  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`

    if (!existingIds.has(candidate)) {
      return candidate
    }
  }
}

export function findModels(config: SetupConfig, request: string): FlattenedModel[] {
  const candidates = flattenModels(config)
  const canonicalCandidates = candidates.filter(candidate => canonicalIdentity(candidate) === request)

  if (canonicalCandidates.length > 0) {
    return canonicalCandidates
  }

  return candidates.filter((candidate) => {
    const names = [
      candidate.model.id,
      candidate.model.name,
      ...(candidate.model.aliases ?? []),
    ]
      .filter((name): name is string => name !== undefined)

    return names.some(name =>
      name === request || `${candidate.provider.id}/${name}` === request,
    )
  })
}

export function findProviderSetupSource(value: ProviderSetupSource['value']): ProviderSetupSource | undefined {
  return providerSetupSources.find(source => source.value === value)
}

export function findProviderSetupSourceByEndpoint(endpoint: string | URL): OpenAICompatibleProviderSetupSource | undefined {
  const normalizedEndpoint = endpoint instanceof URL
    ? endpoint.toString()
    : new URL(endpoint).toString()

  return providerSetupSources.find((source): source is OpenAICompatibleProviderSetupSource =>
    source.kind === 'openai-compatible'
    && source.defaultEndpoint !== undefined
    && new URL(source.defaultEndpoint).toString() === normalizedEndpoint,
  )
}

export function flattenModels(config: SetupConfig): FlattenedModel[] {
  return config.providers.flatMap(provider =>
    provider.models.map(model => ({ model, provider })),
  )
}

export function formatAmbiguousModels(request: string, candidates: FlattenedModel[]): string {
  const candidatesByIdentity = new Map<string, FlattenedModel[]>()

  for (const candidate of candidates) {
    const identity = canonicalIdentity(candidate)
    const matchingCandidates = candidatesByIdentity.get(identity) ?? []
    matchingCandidates.push(candidate)
    candidatesByIdentity.set(identity, matchingCandidates)
  }

  const duplicateIdentity = [...candidatesByIdentity]
    .find(([, matchingCandidates]) => matchingCandidates.length > 1)?.[0]

  if (duplicateIdentity !== undefined) {
    return formatDuplicateModelIdentity(duplicateIdentity)
  }

  const choices = [
    ...candidatesByIdentity.keys(),
  ]

  return `${[
    `ambiguous model "${escapeLineValue(request)}".`,
    'specify a provider-qualified model:',
    ...choices.map(choice => `  ${escapeLineValue(choice)}`),
  ].join('\n')}\n`
}

export function formatModelBenchmarkList(
  config: SetupConfig,
  benchmarks: readonly ModelBenchmarkResult[],
  options: FormatModelBenchmarkListOptions = {},
): string {
  const benchmarksByIdentity = new Map<string, ModelBenchmarkResult[]>()

  for (const benchmark of benchmarks) {
    const identity = `${benchmark.providerId}/${benchmark.modelId}`
    const matches = benchmarksByIdentity.get(identity) ?? []
    matches.push(benchmark)
    benchmarksByIdentity.set(identity, matches)
  }

  return formatBenchmarkTable(
    flattenModels(config).map(({ model, provider }) => {
      const benchmark = benchmarksByIdentity.get(`${provider.id}/${model.id}`)?.shift()

      return benchmark === undefined
        ? [
            model.id,
            provider.id,
            model.name ?? model.id,
            'n/a',
            'n/a',
            'n/a',
            '0/0',
          ]
        : benchmarkRow(model.id, model.name ?? model.id, provider.id, benchmark, options.color === true)
    }),
  )
}

export function formatModelBenchmarkProgressFrame(
  config: SetupConfig,
  progress: ModelBenchmarkProgress,
  options: FormatModelBenchmarkProgressListOptions,
): ModelBenchmarkProgressFrame {
  const columns = {
    3: { truncate: 10, width: 10 },
    4: { truncate: 12, width: 12 },
    5: { truncate: 16, width: 16 },
    6: { truncate: 8, width: 8 },
  }
  const models = flattenModels(config)
  const modelCapacity = options.maxRows === undefined
    ? models.length
    : Math.max(options.maxRows - 2, 1)
  const activeByModelIndex = new Map(progress.active.map(current => [current.modelIndex, current]))
  const completed = progress.results.filter(result => result !== undefined).length
  const activeIndex = progress.active[0]?.modelIndex ?? completed
  const start = Math.min(
    Math.max(activeIndex - Math.floor(modelCapacity / 2), 0),
    Math.max(models.length - modelCapacity, 0),
  )
  const end = Math.min(start + modelCapacity, models.length)
  const visibleModels = models.slice(start, end)
  const bodyRows = formatBenchmarkTable(
    visibleModels.map(({ model, provider }, visibleIndex) => {
      const modelIndex = start + visibleIndex
      const benchmark = progress.results[modelIndex]

      if (benchmark !== undefined) {
        return benchmarkRow(model.id, model.name ?? model.id, provider.id, benchmark, options.color === true)
      }

      const current = activeByModelIndex.get(modelIndex)

      if (current !== undefined) {
        return activeBenchmarkRow(model.id, model.name ?? model.id, provider.id, current, options)
      }

      return [
        model.id,
        provider.id,
        model.name ?? model.id,
        'pending',
        'pending',
        'pending',
        '0/0',
      ]
    }),
    columns,
  ).trimEnd().split('\n')
  const range = models.length > visibleModels.length
    ? ` · showing models ${start + 1}-${end} of ${models.length}`
    : ''
  const bar = formatMiniBar({
    completed,
    planned: progress.modelsTotal,
    tick: options.tick,
    width: 12,
  })

  const running = progress.active.length === 0
    ? ''
    : ` · ${progress.active.length} running`

  const speedColumn = bodyRows[0]?.indexOf('repeat') ?? -1

  if (speedColumn < 0) {
    throw new Error('Benchmark progress table is missing its speed columns.')
  }

  return {
    rows: [
      ...bodyRows.map(row => ({
        prefix: row.slice(0, speedColumn),
        suffix: row.slice(speedColumn),
      })),
      {
        prefix: '',
        suffix: `${completed}/${progress.modelsTotal} models complete ${bar}${running}${range}`,
      },
    ],
  }
}

export function formatModelBenchmarkProgressList(
  config: SetupConfig,
  progress: ModelBenchmarkProgress,
  options: FormatModelBenchmarkProgressListOptions,
): string {
  const frame = formatModelBenchmarkProgressFrame(config, progress, options)

  return `${frame.rows.map(row => `${row.prefix}${row.suffix}`).join('\n')}\n`
}

export function formatModelList(config: SetupConfig): string {
  const rows = flattenModels(config)

  return formatTable([
    ['id', 'provider', 'name'],
    ...rows.map(({ model, provider }) => [
      model.id,
      provider.id,
      model.name ?? model.id,
    ]),
  ])
}

export function formatModelShow(candidate: FlattenedModel): string {
  const { model, provider } = candidate
  const lines = [
    `id: ${model.id}`,
    `name: ${model.name ?? model.id}`,
    `provider: ${provider.id}`,
    `endpoint: ${provider.endpoint}`,
  ]

  if (model.aliases?.length) {
    lines.push(`aliases: ${model.aliases.join(', ')}`)
  }

  if (model.capabilities?.length) {
    lines.push(`capabilities: ${model.capabilities.join(', ')}`)
  }

  if (model.size !== undefined) {
    lines.push(`size: ${model.size}`)
  }

  if (model.contextWindow !== undefined) {
    lines.push(`contextWindow: ${model.contextWindow}`)
  }

  if (model.defaultParams !== undefined) {
    lines.push(`defaultParams: ${JSON.stringify(model.defaultParams)}`)
  }

  return `${lines.join('\n')}\n`
}

export function formatProviderList(config: SetupConfig): string {
  return formatTable([
    ['id', 'type', 'endpoint', 'models'],
    ...config.providers.map(provider => [
      provider.id,
      provider.type ?? 'model-driven',
      provider.endpoint ?? '-',
      String(provider.models.length),
    ]),
  ])
}

export function formatProviderShow(provider: ProviderDefinition): string {
  const lines = [
    `id: ${provider.id}`,
    `type: ${provider.type ?? 'model-driven'}`,
    `endpoint: ${provider.endpoint ?? '-'}`,
    `models: ${provider.models.map(model => model.id).join(', ')}`,
  ]
  const headerKeys = Object.keys(provider.headers ?? {})

  if (headerKeys.length > 0) {
    lines.push(`headers: ${headerKeys.join(', ')}`)
  }

  return `${lines.join('\n')}\n`
}

// NOTICE: This matches Undici's HTTP token grammar so unsafe field names never enter provider config.
// Adapted from `https://github.com/nodejs/undici/blob/a0922b0b6b5db878881017abb6fca3bbcdea555a/lib/core/util.js#L746-L760`.
const httpTokenPattern = /^[\w^`\-!#$%&'*+.|~]+$/u

export function isValidProviderHeaderName(name: string): boolean {
  return httpTokenPattern.test(name)
}

export function parseHeaderList(headers: string[]): Record<string, string> | undefined {
  if (headers.length === 0) {
    return undefined
  }

  const parsedHeaders: Record<string, string> = {}

  for (const header of headers) {
    const separatorIndex = header.indexOf('=')

    if (separatorIndex <= 0) {
      throw new Error('Invalid provider header. Expected Key=Value.')
    }

    const name = header.slice(0, separatorIndex)

    if (!isValidProviderHeaderName(name)) {
      throw new Error('Invalid provider header name. Expected an HTTP field-name token.')
    }

    parsedHeaders[name] = header.slice(separatorIndex + 1)
  }

  return parsedHeaders
}

export async function probeModels(endpoint: string, headers: Record<string, string> = {}): Promise<string[]> {
  const response = await fetch(buildModelsUrl(endpoint), { headers })

  if (!response.ok) {
    throw new Error(`GET ${buildModelsUrl(endpoint)} returned ${response.status}.`)
  }

  const body: unknown = await response.json()
  if (!isRecord(body) || !Array.isArray(body.data) || !body.data.every(isModelRecord)) {
    throw new TypeError('Expected OpenAI-compatible models response with data array.')
  }

  return body.data.map(model => model.id)
}

export function resolveProviderBenchmarkConcurrency(
  config: SetupConfig,
  overrides: readonly string[] = [],
): Record<string, number> {
  const concurrency = Object.fromEntries(config.providers.map(provider => [
    provider.id,
    provider.endpoint === undefined
      ? defaultBenchmarkConcurrency
      : findProviderSetupSourceByEndpoint(provider.endpoint)?.benchmarkConcurrency ?? defaultBenchmarkConcurrency,
  ]))

  for (const override of overrides) {
    const separatorIndex = override.indexOf('=')

    if (separatorIndex <= 0 || separatorIndex === override.length - 1) {
      throw new Error('Invalid benchmark concurrency override. Expected <provider-id>=<limit>.')
    }

    const providerId = override.slice(0, separatorIndex)
    const value = override.slice(separatorIndex + 1)
    const limit = Number(value)

    if (!(providerId in concurrency)) {
      throw new Error(`Unknown provider "${escapeLineValue(providerId)}" in benchmark concurrency override.`)
    }

    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(limit) || limit < 1) {
      throw new Error(`Benchmark concurrency for provider "${escapeLineValue(providerId)}" must be a positive integer.`)
    }

    concurrency[providerId] = limit
  }

  return concurrency
}

function activeBenchmarkRow(
  modelId: string,
  modelName: string,
  providerId: string,
  current: ModelBenchmarkProgress['active'][number],
  options: FormatModelBenchmarkProgressListOptions,
): string[] {
  const frame = options.color === true
    ? colors.cyan(options.frame)
    : options.frame
  const active = current.warmup
    ? 'warm-up'
    : `${frame} ${current.sample}/${current.samples}`

  return [
    modelId,
    providerId,
    modelName,
    current.phase === 'repeat'
      ? active
      : 'done',
    current.phase === 'non-repeat'
      ? active
      : 'pending',
    current.phase === 'non-repeat'
      ? 'measuring'
      : 'pending',
    `${current.success.completed}/${current.success.attempted}`,
  ]
}

function benchmarkRow(
  modelId: string,
  modelName: string,
  providerId: string,
  benchmark: ModelBenchmarkResult,
  color: boolean,
): string[] {
  const errored = color
    ? colors.red('errored')
    : 'errored'

  return [
    modelId,
    providerId,
    modelName,
    benchmark.error === undefined
      ? formatDuration(benchmark.repeatMs)
      : errored,
    benchmark.error === undefined
      ? formatDuration(benchmark.nonRepeatMs)
      : errored,
    benchmark.error === undefined
      ? formatThroughput(benchmark.throughput)
      : errored,
    `${benchmark.success.completed}/${benchmark.success.attempted}`,
  ]
}

function canonicalIdentity(candidate: FlattenedModel): string {
  return `${candidate.provider.id}/${candidate.model.id}`
}

function formatBenchmarkTable(
  rows: string[][],
  columns?: Record<number, { truncate: number, width: number }>,
): string {
  return formatTable([
    [
      'id',
      'provider',
      'name',
      'repeat',
      'non-repeat',
      'throughput',
      'success',
    ],
    ...rows,
  ], columns)
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) {
    return 'n/a'
  }

  if (durationMs < 1_000) {
    return `${Math.round(durationMs)}ms`
  }

  return `${stripTrailingZeros((durationMs / 1_000).toFixed(2))}s`
}

function formatTable(
  rows: string[][],
  columns?: Record<number, { truncate: number, width: number }>,
): string {
  if (rows.length <= 1) {
    return ''
  }

  return table(rows, {
    border: getBorderCharacters('void'),
    columnDefault: {
      paddingLeft: 0,
      paddingRight: 2,
    },
    columns,
    drawHorizontalLine: () => false,
  })
}

function formatThroughput(throughput: number | undefined): string {
  return throughput === undefined
    ? 'n/a'
    : `${throughput.toFixed(1)} tok/s`
}

function isModelRecord(value: unknown): value is Record<string, unknown> & { id: string } {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeProviderIdBase(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'provider'
}

function stripTrailingZeros(value: string): string {
  return String(Number(value))
}

import type { Message } from '@xsai/shared-chat'

import type { SetupConfig } from '../config/types'
import type { ResolvedModel } from './types'

import { errorMessageFrom } from '@moeru/std/error'
import { streamText } from '@xsai/stream-text'

import { scheduleProviderJobs } from './benchmark-scheduler'
import { resolveModel } from './resolve'

const defaultSampleCount = 3
const defaultTimeoutMs = 60_000
const maxOutputTokens = 128

export interface BenchmarkModelsOptions {
  onProgress?: (progress: ModelBenchmarkProgress) => void
  providerConcurrency?: Readonly<Record<string, number>>
  request?: (request: ModelBenchmarkRequest) => Promise<ModelBenchmarkMeasurement>
  sampleCount?: number
  seed?: number
  timeoutMs?: number
}

export interface ModelBenchmarkActive {
  modelId: string
  modelIndex: number
  phase: 'non-repeat' | 'repeat'
  providerId: string
  sample: number
  samples: number
  success: ModelBenchmarkResult['success']
  warmup: boolean
}

export interface ModelBenchmarkMeasurement {
  durationMs: number
  firstOutputMs?: number
  outputTokens?: number
}

export interface ModelBenchmarkProgress {
  active: readonly ModelBenchmarkActive[]
  modelsTotal: number
  results: readonly (ModelBenchmarkResult | undefined)[]
}

export interface ModelBenchmarkRequest {
  model: ResolvedModel
  prompt: string
  signal: AbortSignal
}

export interface ModelBenchmarkResult {
  error?: string
  modelId: string
  nonRepeatMs?: number
  providerId: string
  repeatMs?: number
  success: {
    attempted: number
    completed: number
  }
  throughput?: number
}

/**
 * Benchmarks model jobs concurrently within independent provider limits.
 *
 * Each model's repeat warm-up, measured repeats, and non-repeats remain serial so concurrent samples cannot
 * distort that model's cache behavior. Non-repeat prompts put their nonce before the shared corpus.
 */
export async function benchmarkModels(
  config: SetupConfig,
  options: BenchmarkModelsOptions = {},
): Promise<ModelBenchmarkResult[]> {
  const request = options.request ?? measureModel
  const sampleCount = options.sampleCount ?? defaultSampleCount
  const seed = options.seed ?? Math.floor(Date.now() / 1_000)
  const timeoutMs = options.timeoutMs ?? config.runner?.timeoutMs ?? defaultTimeoutMs
  const jobs = config.providers.flatMap(provider => provider.models.map(model => ({
    identity: `${provider.id}/${model.id}`,
    model,
    providerId: provider.id,
  })))
  const results: Array<ModelBenchmarkResult | undefined> = Array.from({ length: jobs.length })
  const active = new Map<number, ModelBenchmarkActive>()
  const modelsTotal = jobs.length

  if (!Number.isInteger(sampleCount) || sampleCount < 1) {
    throw new RangeError('Benchmark sample count must be a positive integer.')
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Benchmark timeout must be greater than zero.')
  }

  return scheduleProviderJobs(jobs, options.providerConcurrency ?? {}, async (job, modelIndex) => {
    const baseResult: ModelBenchmarkResult = {
      modelId: job.model.id,
      providerId: job.providerId,
      success: { attempted: 0, completed: 0 },
    }

    let model: ResolvedModel

    try {
      model = resolveModel(config, { request: job.identity })
    }
    catch (error) {
      const result = {
        ...baseResult,
        error: errorMessageFrom(error) ?? 'Could not resolve model.',
      }
      results[modelIndex] = result
      reportProgress(options, modelsTotal, results, active)
      return result
    }

    const result = await benchmarkModel(model, modelIndex, seed, sampleCount, timeoutMs, request, (current) => {
      active.set(modelIndex, current)
      reportProgress(options, modelsTotal, results, active)
    })
    active.delete(modelIndex)
    results[modelIndex] = result
    reportProgress(options, modelsTotal, results, active)
    return result
  })
}

async function attempt(
  result: ModelBenchmarkResult,
  request: (signal: AbortSignal) => Promise<ModelBenchmarkMeasurement>,
  timeoutMs: number,
  onStarted: () => void,
): Promise<ModelBenchmarkMeasurement> {
  result.success.attempted += 1
  onStarted()
  const measurement = await request(AbortSignal.timeout(timeoutMs))
  result.success.completed += 1
  return measurement
}

async function benchmarkModel(
  model: ResolvedModel,
  modelIndex: number,
  seed: number,
  sampleCount: number,
  timeoutMs: number,
  request: (request: ModelBenchmarkRequest) => Promise<ModelBenchmarkMeasurement>,
  onProgress: (current: ModelBenchmarkActive) => void,
): Promise<ModelBenchmarkResult> {
  const result: ModelBenchmarkResult = {
    modelId: model.id,
    providerId: model.provider.id,
    success: { attempted: 0, completed: 0 },
  }
  const repeatPrompt = benchmarkPrompt(seed, model, 0, true)
  const repeatMeasurements: ModelBenchmarkMeasurement[] = []
  const nonRepeatMeasurements: ModelBenchmarkMeasurement[] = []

  try {
    await attempt(
      result,
      signal => request({ model, prompt: repeatPrompt, signal }),
      timeoutMs,
      () => onProgress(currentProgress(model, modelIndex, result, 'repeat', 0, sampleCount, true)),
    )

    for (let index = 0; index < sampleCount; index += 1) {
      repeatMeasurements.push(await attempt(
        result,
        signal => request({ model, prompt: repeatPrompt, signal }),
        timeoutMs,
        () => onProgress(currentProgress(model, modelIndex, result, 'repeat', index + 1, sampleCount, false)),
      ))
    }

    for (let index = 0; index < sampleCount; index += 1) {
      const prompt = benchmarkPrompt(seed, model, index + 1, false)
      nonRepeatMeasurements.push(await attempt(
        result,
        signal => request({ model, prompt, signal }),
        timeoutMs,
        () => onProgress(currentProgress(model, modelIndex, result, 'non-repeat', index + 1, sampleCount, false)),
      ))
    }
  }
  catch (error) {
    return {
      ...result,
      error: errorMessageFrom(error) ?? 'Benchmark request failed.',
    }
  }

  return {
    ...result,
    nonRepeatMs: median(nonRepeatMeasurements.map(measurement => measurement.durationMs)),
    repeatMs: median(repeatMeasurements.map(measurement => measurement.durationMs)),
    throughput: medianOptional(nonRepeatMeasurements.map(throughputOf)),
  }
}

function benchmarkPrompt(seed: number, model: ResolvedModel, sample: number, repeat: boolean): string {
  const nonce = repeat
    ? `${seed}:${model.provider.id}/${model.id}:repeat`
    : `${seed}:${model.provider.id}/${model.id}:non-repeat:${sample}`
  const corpus = sampleCorpus(seed + sample)

  return [
    `[alint benchmark nonce: ${nonce}]`,
    'Read the following source review corpus. Return exactly eight concise bullet points summarizing its behavior, risks, and maintainability. Do not quote the nonce.',
    '',
    corpus,
  ].join('\n')
}

function currentProgress(
  model: ResolvedModel,
  modelIndex: number,
  result: ModelBenchmarkResult,
  phase: ModelBenchmarkActive['phase'],
  sample: number,
  samples: number,
  warmup: boolean,
): ModelBenchmarkActive {
  return {
    modelId: model.id,
    modelIndex,
    phase,
    providerId: model.provider.id,
    sample,
    samples,
    success: { ...result.success },
    warmup,
  }
}

async function measureModel({ model, prompt, signal }: ModelBenchmarkRequest): Promise<ModelBenchmarkMeasurement> {
  const messages: Message[] = [{ content: prompt, role: 'user' }]
  const startedAt = performance.now()
  let firstOutputAt: number | undefined
  let outputDeltaCount = 0
  const result = streamText({
    ...model.params,
    abortSignal: signal,
    baseURL: model.provider.endpoint,
    headers: model.provider.headers,
    maxTokens: maxOutputTokens,
    messages,
    model: model.id,
    streamOptions: { includeUsage: true },
    temperature: 0,
  })

  // streamText exposes several views over one request. Attach rejection handlers immediately so a
  // transport failure cannot leave unused result promises as unhandled rejections.
  const completion = Promise.allSettled([
    result.messages,
    result.steps,
    result.totalUsage,
    result.usage,
  ] as const)
  let settled: Awaited<typeof completion>

  try {
    for await (const event of result.eventStream) {
      if (
        (event.type === 'reasoning.delta' || event.type === 'text.delta')
        && event.delta.length > 0
      ) {
        outputDeltaCount += 1
        firstOutputAt ??= performance.now()
      }
    }
  }
  finally {
    settled = await completion
  }

  const endedAt = performance.now()
  const usageResult = settled[3]

  if (usageResult.status === 'rejected') {
    throw usageResult.reason
  }

  return {
    durationMs: endedAt - startedAt,
    // One output timestamp cannot show the provider's decode interval. Providers can buffer the full output in one delta.
    firstOutputMs: firstOutputAt === undefined || outputDeltaCount < 2 ? undefined : firstOutputAt - startedAt,
    outputTokens: usageResult.value?.outputTokens,
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!
}

function medianOptional(values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value !== undefined)
  return present.length === 0 ? undefined : median(present)
}

function reportProgress(
  options: BenchmarkModelsOptions,
  modelsTotal: number,
  results: readonly (ModelBenchmarkResult | undefined)[],
  active: ReadonlyMap<number, ModelBenchmarkActive>,
): void {
  options.onProgress?.({
    active: [...active.values()]
      .sort((left, right) => left.modelIndex - right.modelIndex)
      .map(current => ({
        ...current,
        success: { ...current.success },
      })),
    modelsTotal,
    results: results.map(result => result === undefined
      ? undefined
      : {
          ...result,
          success: { ...result.success },
        }),
  })
}

function throughputOf(measurement: ModelBenchmarkMeasurement): number | undefined {
  if (
    measurement.firstOutputMs === undefined
    || measurement.outputTokens === undefined
    || measurement.durationMs <= measurement.firstOutputMs
  ) {
    return undefined
  }

  // Excluding time-to-first-output keeps provider queueing and prompt ingestion out of decode throughput.
  return measurement.outputTokens / ((measurement.durationMs - measurement.firstOutputMs) / 1_000)
}

const corpusLines = [
  'type QueueEntry = { id: string, attempts: number, payload: string }',
  'type QueueState = { active: Map<string, QueueEntry>, pending: QueueEntry[] }',
  '',
  'export function createQueue(limit: number) {',
  '  const state: QueueState = { active: new Map(), pending: [] }',
  '  let closed = false',
  '',
  '  function enqueue(entry: QueueEntry): boolean {',
  '    if (closed || state.active.has(entry.id)) return false',
  '    state.pending.push({ ...entry })',
  '    drain()',
  '    return true',
  '  }',
  '',
  '  function drain(): void {',
  '    while (!closed && state.active.size < limit && state.pending.length > 0) {',
  '      const next = state.pending.shift()',
  '      if (!next) break',
  '      state.active.set(next.id, next)',
  '      void execute(next).finally(() => {',
  '        state.active.delete(next.id)',
  '        drain()',
  '      })',
  '    }',
  '  }',
  '',
  '  async function execute(entry: QueueEntry): Promise<void> {',
  '    const response = await fetch("/jobs/" + entry.id, {',
  '      body: JSON.stringify(entry.payload),',
  '      headers: { "content-type": "application/json" },',
  '      method: "POST",',
  '    })',
  '    if (!response.ok && entry.attempts < 3) {',
  '      state.pending.push({ ...entry, attempts: entry.attempts + 1 })',
  '    }',
  '  }',
  '',
  '  function close(): void {',
  '    closed = true',
  '    state.pending.length = 0',
  '  }',
  '',
  '  return { close, enqueue }',
  '}',
  '',
  'The queue accepts independent jobs and limits concurrent requests.',
  'Its retry path changes ordering because failed jobs return at the tail.',
  'Closing drops pending work but does not cancel requests already in flight.',
  'Callers receive admission status but cannot observe completion or failure.',
  'The mutable map prevents duplicate active identifiers, not duplicate pending identifiers.',
  'A synchronous drain call establishes ownership before asynchronous execution starts.',
  'Network failures reject execute and are not retried by the response-status branch.',
  'The relative URL assumes a runtime with an application-specific fetch base.',
  'Payload serialization can throw before a request is created.',
  'The limit must be positive or pending work can remain stuck forever.',
]

function sampleCorpus(seed: number): string {
  const offset = Math.abs(seed) % corpusLines.length
  const rotated = [...corpusLines.slice(offset), ...corpusLines.slice(0, offset)].join('\n')

  // Repeat the representative source to cross common prompt-cache minimums; the nonce still makes
  // non-repeat samples unique from their first token while repeat samples remain byte-identical.
  return [1, 2, 3].map(section => `--- corpus section ${section} ---\n${rotated}`).join('\n\n')
}

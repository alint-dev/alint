import type { SetupConfig } from '../config/types'
import type { CacheRunContext, RuleJobOutcome } from './execution/types'
import type { AlintFileFailure, AlintRunFailure, InferenceUsageRecord, RunOptions, RunResult, RunUsage, RunUsageTotals } from './types'

import { cwd as processCwd } from 'node:process'

import { createCacheStore, normalizeRunnerCacheConfig } from './cache'
import { compareJobOrder, executeRuleJob, resolveRuleExecutionTimeout } from './execution/job'
import { createRunProgress } from './execution/progress'
import { snapshotDiagnostics, snapshotUsageRecords } from './execution/records'
import { createRuleRuntimes } from './execution/runtime'
import { resolveRuleConcurrency, RuleScheduler } from './execution/scheduler'
import { stableHash } from './hash'
import { missingLanguageDiagnostics, unregisteredLanguageDiagnostics } from './languages/diagnostics'
import { createSourceExtractor, prepareRun } from './preparation'
import { createProjectJobs, ProjectIndexBuilder } from './project'
import { planSources } from './source/planner'
import { createSourceRuntime } from './source/runtime'
import { createDirectoryJobs } from './targets/directory'

export class AlintRunCancelledError extends Error {
  readonly result: RunResult

  constructor(result: RunResult, cause?: unknown) {
    super('Alint run cancelled.', { cause })
    this.name = 'AlintRunCancelledError'
    this.result = result
  }
}

/** Cancellation error carrying the partial result gathered before the abort. */
export class AlintAbortError extends AlintRunCancelledError {
  constructor(result: RunResult, options: { cause?: unknown } = {}) {
    super(result, options.cause)
    this.name = 'AlintAbortError'
  }
}

export class AlintCachePersistenceError extends Error {
  readonly result: RunResult

  constructor(result: RunResult, cause: unknown) {
    super('Failed to persist the alint cache.', { cause })
    this.name = 'AlintCachePersistenceError'
    this.result = result
  }
}

export class AlintRunError extends Error {
  readonly failures: AlintRunFailure[]
  readonly result: RunResult

  constructor(message: string, result: RunResult, options: { cause?: unknown, failures?: AlintRunFailure[] } = {}) {
    super(message, { cause: options.cause })
    this.name = 'AlintRunError'
    this.failures = options.failures ?? []
    this.result = result
  }
}

export async function runAlint(options: RunOptions = {}): Promise<RunResult> {
  const clock = Date.now
  const timeoutMs = resolveRuleExecutionTimeout(options.runner?.timeoutMs)
  const concurrency = resolveRuleConcurrency(options.runner?.ruleConcurrency)
  const prepareStartedAt = clock()
  options.progress?.onPrepareStart?.({ startedAt: prepareStartedAt })
  const preparation = prepareRun(options)
  options.progress?.onPrepareEnd?.({
    endedAt: clock(),
    filesTotal: preparation.files.length,
    startedAt: prepareStartedAt,
  })

  const runProgress = createRunProgress(preparation.files.length)
  const runStartedAt = clock()
  options.progress?.onExecuteStart?.({
    progress: runProgress.snapshot(),
    startedAt: runStartedAt,
  })
  const cwd = options.cwd ?? processCwd()
  const config = options.config ?? []
  const setupConfig: SetupConfig = options.setupConfig ?? { providers: [], version: 1 }
  const src = createSourceRuntime({
    extract: createSourceExtractor(cwd, config, () => src),
  })
  const normalizedCacheConfig = normalizeRunnerCacheConfig(options.runner?.cache, cwd)
  const cacheStore = await createCacheStore({
    cwd,
    enabled: normalizedCacheConfig.enabled,
    location: normalizedCacheConfig.location,
    readOnly: options.cacheOnly,
  })
  const cacheContext: CacheRunContext = {
    modelHash: stableHash({
      defaultModel: options.modelOverride === undefined
        ? options.defaultModel
        : undefined,
      modelOverride: options.modelOverride,
      outputLanguage: options.outputLanguage,
      setupConfig,
    }),
  }
  const createRuntimes = (input: { agent?: typeof preparation.files[number]['agent'], rules: typeof preparation.files[number]['rules'], settings: Record<string, unknown> }) => createRuleRuntimes({
    cwd,
    effectiveAgent: input.agent,
    effectiveSettings: input.settings,
    progress: options.progress,
    rules: input.rules,
    runOptions: options,
    runProgress,
    setupConfig,
    src,
  })
  const scheduler = new RuleScheduler({
    clock,
    concurrency,
    execute: (job, _startedAt) => executeRuleJob(job, {
      cache: cacheContext,
      cacheOnly: options.cacheOnly,
      progress: options.progress,
      runProgress,
      runSignal: options.signal,
      timeoutMs,
    }),
    progress: runProgress,
    reporter: options.progress,
    signal: options.signal,
  })
  const outcomes: RuleJobOutcome[] = []
  const fileFailures: AlintFileFailure[] = []
  let infrastructureError: unknown
  let cachePersistenceError: unknown
  let infrastructureFailed = false
  let admissionFailed = false

  try {
    const projectRuntimes = preparation.project
      ? createRuntimes(preparation.project)
      : []
    const projectBuilder = preparation.project && projectRuntimes.some(runtime => runtime.handlers.onTargetWith || runtime.handlers.onTargetProject)
      ? new ProjectIndexBuilder(preparation.project.root)
      : undefined
    const sourceResults = await planSources(preparation.files, {
      cacheStore,
      createRuleRuntimes: createRuntimes,
      cwd,
      progress: options.progress,
      projectSnapshots: projectBuilder !== undefined,
      scheduler,
      signal: options.signal,
      src,
    })
    for (const result of sourceResults) {
      if (result.failure)
        fileFailures.push(result.failure)
    }
    const pendingOutcomes: Promise<RuleJobOutcome[]>[] = sourceResults.map(result => result.outcomes)
    if (projectBuilder) {
      for (const result of [...sourceResults].sort((left, right) => (left.project?.fileIndex ?? Number.MAX_SAFE_INTEGER) - (right.project?.fileIndex ?? Number.MAX_SAFE_INTEGER))) {
        if (result.project)
          projectBuilder.add(result.project)
      }
    }

    const directoryBatches = preparation.directories.map((input) => {
      return scheduler.schedule(createDirectoryJobs(input, createRuntimes(input)))
    })
    pendingOutcomes.push(...directoryBatches.map(batch => batch.outcomes))

    let clearEmptyProjectOwner = false
    if (fileFailures.length === 0 && preparation.project && !options.signal?.aborted) {
      if (projectBuilder) {
        const project = createProjectJobs({
          cacheStore,
          configHash: preparation.project.configHash,
          project: projectBuilder.build(),
          runtimes: projectRuntimes,
        })
        const projectOwner = project.owner
        const batch = scheduler.schedule(project.jobs)
        pendingOutcomes.push(batch.outcomes.then((settled) => {
          projectOwner?.commit({
            mode: options.signal?.aborted ? 'merge' : 'replace',
          })
          return settled
        }))
      }
      else if (!options.cacheOnly) {
        clearEmptyProjectOwner = true
      }
    }
    const planningProgress = runProgress.completePlanning()
    options.progress?.onPlanningEnd?.({ progress: planningProgress })
    outcomes.push(...(await Promise.all(pendingOutcomes)).flat())
    if (clearEmptyProjectOwner) {
      // A complete run with no project handlers still replaces the prior config's slots,
      // without retaining source descriptors solely to build an empty project index.
      cacheStore.beginOwner({ kind: 'project', path: preparation.project!.root }).commit({ mode: 'replace' })
    }
  }
  catch (error) {
    scheduler.cancelWithError(error)
    infrastructureError = error
    infrastructureFailed = true
    admissionFailed = true
  }
  finally {
    runProgress.completePlanning()
    try {
      await scheduler.close()
    }
    catch (error) {
      infrastructureError ??= error
      infrastructureFailed = true
    }
    if (!admissionFailed && !options.cacheOnly) {
      try {
        await cacheStore.reconcile()
      }
      catch (error) {
        cachePersistenceError = error
      }
    }
  }

  runProgress.finalize()
  if (admissionFailed)
    throw infrastructureError

  outcomes.sort((left, right) => compareJobOrder(left.orderKey, right.orderKey))
  const ruleFailures = outcomes.flatMap(outcome => outcome.state === 'failed'
    ? [outcome.failure]
    : [])
  const failures: AlintRunFailure[] = [
    ...fileFailures.sort((left, right) => left.file.index - right.file.index),
    ...ruleFailures,
  ]
  const result: RunResult = {
    diagnostics: [
      // Language builtins
      ...missingLanguageDiagnostics(preparation.missingLanguages),
      ...unregisteredLanguageDiagnostics(preparation.unregisteredLanguages),
      // Other diagnostics
      ...outcomes.flatMap(outcome => outcome.diagnostics),
    ],
    execution: executionCounts(outcomes),
    usage: runUsage(outcomes),
  }

  options.progress?.onExecuteEnd?.({
    endedAt: clock(),
    progress: runProgress.snapshot(),
  })
  options.progress?.onRunEnd?.({
    diagnostics: snapshotDiagnostics(result.diagnostics),
    endedAt: clock(),
    execution: { ...result.execution },
    progress: runProgress.snapshot(),
    startedAt: runStartedAt,
    usage: snapshotRunUsage(result.usage),
  })

  if (infrastructureFailed)
    throw infrastructureError
  if (cachePersistenceError !== undefined)
    throw new AlintCachePersistenceError(result, cachePersistenceError)
  if (options.signal?.aborted)
    throw new AlintAbortError(result, { cause: options.signal.reason })
  if (failures.length > 0) {
    const hasFileFailure = fileFailures.length > 0
    const message = hasFileFailure
      ? `${failures.length} alint execution${failures.length === 1
        ? ''
        : 's'} failed.`
      : `${failures.length} rule execution${failures.length === 1
        ? ''
        : 's'} failed.`
    throw new AlintRunError(message, result, {
      cause: new AggregateError(failures.map(failure => new Error(failure.message)), 'Alint execution failures.'),
      failures,
    })
  }

  return result
}

function executionCounts(outcomes: RuleJobOutcome[]): RunResult['execution'] {
  const counts: RunResult['execution'] = {
    cached: 0,
    cancelled: 0,
    completed: 0,
    failed: 0,
    planned: outcomes.length,
    queued: 0,
    running: 0,
    skipped: 0,
  }
  for (const outcome of outcomes)
    counts[outcome.state] += 1
  return counts
}

function runUsage(outcomes: RuleJobOutcome[]): RunUsage {
  const live: InferenceUsageRecord[] = []
  const cached: InferenceUsageRecord[] = []
  for (const outcome of outcomes) {
    (outcome.state === 'cached'
      ? cached
      : live).push(...outcome.usage)
  }
  return {
    ...usageTotals(live),
    ...(cached.length > 0
      ? {
          cached: usageTotals(cached),
        }
      : {}),
  }
}

function snapshotRunUsage(usage: RunUsage): RunUsage {
  return {
    ...usage,
    ...(usage.cached
      ? {
          cached: {
            ...usage.cached,
            records: snapshotUsageRecords(usage.cached.records),
          },
        }
      : {}),
    records: snapshotUsageRecords(usage.records),
  }
}

function usageTotals(records: InferenceUsageRecord[]): RunUsageTotals {
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0
  for (const record of records) {
    if (record.inputTokens != null && Number.isFinite(record.inputTokens))
      inputTokens += record.inputTokens
    if (record.outputTokens != null && Number.isFinite(record.outputTokens))
      outputTokens += record.outputTokens
    if (record.totalTokens != null && Number.isFinite(record.totalTokens))
      totalTokens += record.totalTokens
  }
  return {
    inputTokens,
    outputTokens,
    records: [...records],
    totalTokens,
  }
}

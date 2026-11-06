import type { DirectoryTarget, ProjectTarget } from '../../dsl/types'
import type { CacheEntry, CacheFingerprint, CacheSlotIdentity } from '../cache'
import type { ClassTarget, FileTarget, FunctionTarget } from '../source/types'
import type { AlintFailureCause, AlintRuleFailure, Diagnostic, ProgressJobRef, ProgressReporter } from '../types'
import type { RunProgress } from './progress'
import type { CacheRunContext, JobOrderKey, JobScope, RuleExecutionBucket, RuleJob, RuleJobOutcome, RuleRuntimeState, TerminalOutcome } from './types'

import { errorMessageFrom } from '@moeru/std/error'

import { SourceChangedError } from '../source/runtime'
import { snapshotDiagnostic, snapshotDiagnostics, snapshotFailure, snapshotProgressJobRef, snapshotUsage, snapshotUsageRecords } from './records'

export interface ExecuteRuleJobOptions {
  cache: CacheRunContext
  cacheOnly?: boolean
  progress?: ProgressReporter
  runProgress: RunProgress
  runSignal?: AbortSignal
  timeoutMs?: number
}

export type { RuleJob, RuleJobOutcome } from './types'

class CacheReplayProcessingError {
  constructor(readonly cause: unknown) {}
}

export function compareJobOrder(left: JobOrderKey, right: JobOrderKey): number {
  return scopeRank(left.scope) - scopeRank(right.scope)
    || left.inputIndex - right.inputIndex
    || left.targetIndex - right.targetIndex
    || left.ruleIndex - right.ruleIndex
}

export async function executeRuleJob(job: RuleJob, options: ExecuteRuleJobOptions): Promise<RuleJobOutcome> {
  const bucket: RuleExecutionBucket = { diagnostics: [], usage: [] }
  if (options.runSignal?.aborted)
    return finish(job, bucket, { cache: 'miss', state: 'cancelled' })

  const slot: CacheSlotIdentity | undefined = job.target.cacheOwner && job.execution.runtime.cacheable
    ? {
        ruleId: job.execution.runtime.enabledRule.id,
        scope: job.target.kind,
        targetIdentity: job.target.identity,
      }
    : undefined
  const fingerprint = slot
    ? createFingerprint(job, options.cache.modelHash)
    : undefined
  const cachedEntry = slot && fingerprint
    ? job.target.cacheOwner?.lookup(slot, fingerprint)
    : undefined
  if (slot && cachedEntry) {
    try {
      replayCachedEntry(cachedEntry, bucket, job.jobRef, options.progress, options.runProgress)
    }
    catch (error) {
      if (!(error instanceof CacheReplayProcessingError))
        throw error
      job.target.cacheOwner?.discard(slot)
      return finish(job, bucket, {
        cache: 'hit',
        failure: failure(error.cause, job, 'cache-replay'),
        state: 'failed',
      })
    }

    return finish(job, bucket, { cache: 'hit', state: 'cached' })
  }

  if (options.cacheOnly)
    return finish(job, bucket, { cache: 'miss', state: 'skipped' })

  const controller = new AbortController()
  let timedOut = false
  let deadlineError: Error | undefined
  const forwardRunAbort = () => controller.abort(options.runSignal?.reason)
  if (options.runSignal?.aborted)
    forwardRunAbort()
  else
    options.runSignal?.addEventListener('abort', forwardRunAbort, { once: true })

  const timer = options.timeoutMs == null
    ? undefined
    : setTimeout(() => {
        timedOut = true
        deadlineError = new Error(`Rule execution timed out after ${options.timeoutMs}ms.`)
        controller.abort(deadlineError)
      }, options.timeoutMs)

  const state: RuleRuntimeState = {
    activeFilePath: job.target.activeFilePath,
    bucket,
    jobRef: job.jobRef,
    reporterFailed: false,
    runProgress: options.runProgress,
    sealed: false,
    signal: controller.signal,
  }
  let handlerCause: unknown
  let handlerFailed = false

  try {
    // NOTICE: JavaScript handlers cannot be force-terminated. A timed-out handler keeps its permit until its promise settles; process isolation would require a separately approved runtime design.
    await job.execution.runtime.executionState.run(state, () => runHandler(job))
  }
  catch (cause) {
    if (state.reporterFailed)
      throw state.reporterCause
    handlerCause = cause
    handlerFailed = true
  }
  finally {
    state.sealed = true
    if (timer != null)
      clearTimeout(timer)
    options.runSignal?.removeEventListener('abort', forwardRunAbort)
  }

  if (state.reporterFailed)
    throw state.reporterCause

  if (options.runSignal?.aborted)
    return finish(job, bucket, { cache: 'miss', state: 'cancelled' })

  if (timedOut) {
    return finish(job, bucket, {
      cache: 'miss',
      failure: failure(deadlineError, job, 'timeout'),
      state: 'failed',
    })
  }

  if (handlerFailed) {
    return finish(job, bucket, {
      cache: 'miss',
      failure: failure(handlerCause, job, handlerCause instanceof SourceChangedError
        ? 'source-changed'
        : 'handler'),
      state: 'failed',
    })
  }

  if (slot && fingerprint) {
    job.target.cacheOwner?.put(slot, createCacheEntry(job, fingerprint, bucket))
    await job.target.cacheOwner?.checkpoint()
  }

  return finish(job, bucket, { cache: 'miss', state: 'completed' })
}

export function resolveRuleExecutionTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined)
    return undefined
  if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw new TypeError('Rule execution timeout must be a finite positive integer.')
  return timeoutMs
}

function createCacheEntry(job: RuleJob, fingerprint: CacheFingerprint, bucket: RuleExecutionBucket): CacheEntry {
  return {
    diagnostics: snapshotDiagnostics(bucket.diagnostics),
    fingerprint,
    target: {
      hash: fingerprint.targetHash,
      identity: job.target.identity,
      kind: job.target.kind,
      loc: job.target.loc
        ? {
            end: { column: job.target.loc.end.column, line: job.target.loc.end.line },
            start: { column: job.target.loc.start.column, line: job.target.loc.start.line },
          }
        : undefined,
      name: job.target.name,
      range: job.target.range
        ? { end: job.target.range.end, start: job.target.range.start }
        : undefined,
    },
    usage: snapshotUsageRecords(bucket.usage),
  }
}

function createFingerprint(job: RuleJob, modelHash: string): CacheFingerprint {
  return {
    configHash: job.target.configHash,
    modelHash,
    ruleHash: job.execution.runtime.ruleHash,
    targetHash: createTargetHash(job),
  }
}

function createTargetHash(job: RuleJob): string {
  return job.target.cacheTargetHash
}

function errorCause(error: unknown): unknown {
  if (error === null || typeof error !== 'object')
    return undefined

  try {
    return 'cause' in error
      ? error.cause
      : undefined
  }
  catch {
    return undefined
  }
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object')
    return undefined

  try {
    const code = 'code' in error
      ? error.code
      : undefined
    return typeof code === 'string' || typeof code === 'number'
      ? String(code)
      : undefined
  }
  catch {
    return undefined
  }
}

function failure(cause: unknown, job: RuleJob, kind: AlintRuleFailure['kind']): AlintRuleFailure {
  return {
    causes: failureCauses(cause),
    job: snapshotProgressJobRef(job.jobRef),
    kind,
    message: failureMessage(cause),
  }
}

// Error.cause is deliberately flattened into serializable records here. Raw provider errors can
// retain sockets, request bodies, or hostile getters and must not escape the execution boundary.
function failureCauses(error: unknown): AlintFailureCause[] {
  const causes: AlintFailureCause[] = []
  const seen = new Set<object>()
  let current = error

  if (current !== null && typeof current === 'object')
    seen.add(current)

  while (true) {
    const cause = errorCause(current)
    if (cause === undefined)
      return causes
    if (cause !== null && typeof cause === 'object') {
      if (seen.has(cause))
        return causes
      seen.add(cause)
    }

    const code = errorCode(cause)
    causes.push({
      ...(code === undefined
        ? {}
        : { code }),
      message: failureMessage(cause),
    })
    current = cause
  }
}

function failureMessage(cause: unknown): string {
  try {
    return errorMessageFrom(cause) ?? 'Unknown rule failure.'
  }
  catch {
    return 'Unknown rule failure.'
  }
}

function finish(
  job: RuleJob,
  bucket: RuleExecutionBucket,
  terminal: TerminalOutcome,
): RuleJobOutcome {
  const detachedTerminal: TerminalOutcome = terminal.state === 'failed'
    ? {
        ...terminal,
        failure: snapshotFailure(terminal.failure),
      }
    : terminal
  const outcome: RuleJobOutcome = {
    diagnostics: snapshotDiagnostics(bucket.diagnostics),
    jobRef: snapshotProgressJobRef(job.jobRef),
    orderKey: { ...job.orderKey },
    usage: snapshotUsageRecords(bucket.usage),
    ...detachedTerminal,
  }
  return outcome
}

function replayCachedEntry(
  entry: CacheEntry,
  bucket: RuleExecutionBucket,
  job: ProgressJobRef,
  progress: ProgressReporter | undefined,
  runProgress: RunProgress,
): void {
  let diagnostics: CacheEntry['diagnostics']
  let usage: CacheEntry['usage']
  try {
    diagnostics = entry.diagnostics
    usage = entry.usage
  }
  catch (cause) {
    throw new CacheReplayProcessingError(cause)
  }

  for (const cachedDiagnostic of diagnostics) {
    const diagnostic: Diagnostic = snapshotDiagnostic({ ...cachedDiagnostic, cached: true })
    bucket.diagnostics.push(diagnostic)
    progress?.onDiagnostic?.({
      diagnostic: snapshotDiagnostic(diagnostic),
      job: snapshotProgressJobRef(job),
      progress: runProgress.snapshot(),
    })
  }

  for (const record of usage) {
    const usageRecord = snapshotUsage(record)
    bucket.usage.push(usageRecord)
    progress?.onUsage?.({
      job: snapshotProgressJobRef(job),
      progress: runProgress.snapshot(),
      record: snapshotUsage(usageRecord),
    })
  }
}

/**
 * Dispatches one compact job descriptor to its registered rule handler.
 *
 * Triggering workflow:
 *
 * {@link executeRuleJob}
 *   -> {@link runHandler}
 *     -> `RuleHandlers.onTarget*`
 *
 * Upstream:
 * - {@link executeRuleJob}
 *
 * Downstream:
 * - `RuleRuntime.handlers`
 */
function runHandler(job: RuleJob) {
  const { handlers } = job.execution.runtime
  const target = job.target.descriptor
  switch (job.execution.handler) {
    case 'class':
      if (target.kind !== 'class')
        throw new TypeError(`Expected class target, received "${target.kind}".`)

      return handlers.onTargetClass?.(target as ClassTarget)

    case 'directory':
      if (target.kind !== 'directory')
        throw new TypeError(`Expected directory target, received "${target.kind}".`)

      return handlers.onTargetDirectory?.(target as DirectoryTarget)

    case 'file':
      if (target.kind !== 'file')
        throw new TypeError(`Expected file target, received "${target.kind}".`)

      return handlers.onTargetFile?.(target as FileTarget)

    case 'function':
      if (target.kind !== 'function')
        throw new TypeError(`Expected function target, received "${target.kind}".`)

      return handlers.onTargetFunction?.(target as FunctionTarget)

    case 'language-declaration-error':
      throw new Error(
        `Rule "${job.execution.runtime.enabledRule.id}" handles function or class targets but declares no "languages", so it receives none. Declare \`languages: 'any'\`, or list the language ids it handles.`,
      )

    case 'project':
      if (target.kind !== 'project')
        throw new TypeError(`Expected project target, received "${target.kind}".`)

      return handlers.onTargetProject?.(target as ProjectTarget)

    case 'with':
      return handlers.onTargetWith?.(target)
  }
}

function scopeRank(scope: JobScope): number {
  if (scope === 'source')
    return 0
  if (scope === 'directory')
    return 1
  return 2
}

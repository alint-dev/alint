import type { RunnerConfig, SetupConfig } from '../config/types'
import type { AlintConfig, DiagnosticLocation, RuleInferenceUsageRecord } from '../dsl/types'
import type { SourceTargetKind } from './source/types'

export interface AlintFailureCause {
  code?: string
  message: string
}

export interface AlintFileFailure {
  file: {
    index: number
    path: string
  }
  kind: 'extract' | 'read'
  message: string
}

export interface AlintRuleFailure {
  causes: AlintFailureCause[]
  job: ProgressJobRef
  kind: 'cache-replay' | 'handler' | 'source-changed' | 'timeout'
  message: string
}

export type AlintRunFailure = AlintFileFailure | AlintRuleFailure

export interface Diagnostic {
  cached?: boolean
  evidence?: unknown
  filePath: string
  loc?: DiagnosticLocation
  message: string
  model?: {
    providerId: string
    requested?: string
    resolvedId: string
  }
  ruleId: string
  severity: 'error' | 'warn'
}

export interface DiagnosticProgressPayload {
  diagnostic: Diagnostic
  job: ProgressJobRef
  progress: ProgressSnapshot
}

export interface ExecutionCounts {
  cached: number
  cancelled: number
  completed: number
  failed: number
  planned: number
  queued: number
  running: number
  /** Rules left unexecuted because they missed the cache under {@link RunOptions.cacheOnly}. */
  skipped: number
}

export interface ExecutionProgressPayload {
  progress: ProgressSnapshot
}

export interface FileReadyPayload extends ExecutionProgressPayload {
  fileIndex: number
  inputPath: string
  jobsAdded: number
}

export type InferenceUsageRecord = Omit<RuleInferenceUsageRecord, 'ruleId'> & {
  ruleId: string
}

export interface JobEndPayload extends JobStartPayload {
  cache: 'hit' | 'miss'
  endedAt?: number
  failure?: AlintRuleFailure
  state: 'cached' | 'cancelled' | 'completed' | 'failed' | 'skipped'
}

export interface JobQueuedPayload {
  job: ProgressJobRef
  progress: ProgressSnapshot
}

export interface JobRetryPayload {
  attempt: number
  job: ProgressJobRef
  maxAttempts: number
  progress: ProgressSnapshot
  startedAt?: number
}

export interface JobStartPayload {
  job: ProgressJobRef
  progress: ProgressSnapshot
  startedAt?: number
}

export interface PrepareEndPayload extends PrepareStartPayload {
  endedAt?: number
  filesTotal: number
}

export interface PrepareStartPayload {
  startedAt?: number
}

export interface ProgressJobRef {
  id: string
  index: number
  inputPath: string
  ruleId: string
  target: {
    identity: string
    kind: ProgressTargetKind
    name?: string
  }
}

export interface ProgressReporter {
  onDiagnostic?: (payload: DiagnosticProgressPayload) => void
  onExecuteEnd?: (payload: ExecutionProgressPayload & { endedAt?: number }) => void
  onExecuteStart?: (payload: ExecutionProgressPayload & { startedAt?: number }) => void
  onFileReady?: (payload: FileReadyPayload) => void
  onJobEnd?: (payload: JobEndPayload) => void
  onJobQueued?: (payload: JobQueuedPayload) => void
  onJobRetry?: (payload: JobRetryPayload) => void
  onJobStart?: (payload: JobStartPayload) => void
  onPlanningEnd?: (payload: ExecutionProgressPayload) => void
  onPrepareEnd?: (payload: PrepareEndPayload) => void
  onPrepareStart?: (payload: PrepareStartPayload) => void
  onRunEnd?: (payload: RunEndPayload) => void
  onUsage?: (payload: UsageProgressPayload) => void
}

export interface ProgressSnapshot {
  execution: ExecutionCounts
  filesPlanned: number
  filesTotal: number
  jobsCompleted: number
  jobsStarted: number
  jobsTotal: number
  planningComplete: boolean
}

export type ProgressTargetKind = SourceTargetKind

export interface RunEndPayload {
  diagnostics: Diagnostic[]
  endedAt?: number
  execution: ExecutionCounts
  progress: ProgressSnapshot
  startedAt?: number
  usage: RunUsage
}

export type RunExecution = ExecutionCounts

export type RunnerOptions = RunnerConfig

export interface RunOptions {
  /**
   * Return only diagnostics that are already cached, without calling any model.
   * Rules that miss the cache are skipped, and the cache remains read-only.
   */
  cacheOnly?: boolean
  config?: AlintConfig
  cwd?: string
  defaultModel?: string
  directories?: string[]
  files?: string[]
  modelOverride?: string
  outputLanguage?: string
  progress?: ProgressReporter
  /**
   * Run project-scoped rules (`onTargetProject` and the project pass of `onTargetWith`).
   * Defaults to `true`. Pass `false` for runs that target partial subsets of a project.
   */
  projectTargets?: boolean
  /**
   * Only run rules whose configured id (`plugin/rule`) or own name (`rule`) matches one of these
   * glob patterns. Everything else stays unplanned, so a filtered run neither calls its model nor
   * reports its diagnostics.
   *
   * A filter that matches no enabled rule fails the run, because a silent empty run is
   * indistinguishable from a clean one. Pass the patterns you typed on the command line.
   */
  ruleFilter?: readonly string[]
  runner?: RunnerOptions
  setupConfig?: SetupConfig
  /**
   * Cancels the run. Aborting stops the engine from starting further rules and cancels the
   * in-flight model call, so a cancelled run stops spending tokens.
   *
   * `runAlint` rejects with {@link AlintAbortError}, which carries the diagnostics gathered
   * before the abort. Rules that already finished keep their cache entries: cancelling never
   * throws away work you already paid for.
   */
  signal?: AbortSignal
}

export interface RunResult {
  diagnostics: Diagnostic[]
  execution: ExecutionCounts
  usage: RunUsage
}

export interface RunUsage {
  cached?: RunUsageTotals
  inputTokens: number
  outputTokens: number
  records: InferenceUsageRecord[]
  totalTokens: number
}

export interface RunUsageTotals {
  inputTokens: number
  outputTokens: number
  records: InferenceUsageRecord[]
  totalTokens: number
}

export interface UsageProgressPayload {
  job: ProgressJobRef
  progress: ProgressSnapshot
  record: InferenceUsageRecord
}

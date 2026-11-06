import type { ExecutionCounts, ProgressJobRef, ProgressReporter, ProgressSnapshot } from '@alint-js/core'

import { relative } from 'node:path'

import fastStringTruncatedWidth from 'fast-string-truncated-width'
import fastStringWidth from 'fast-string-width'

import { formatDuration as formatDateFnsDuration, intervalToDuration } from 'date-fns'
import { createColors } from 'tinyrainbow'

import { formatMiniBar } from './bar'

const colors = createColors({ force: true })
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export interface SummaryProgressReporter extends ProgressReporter {
  getRows: () => string[]
  tick: () => void
}

export interface SummaryProgressReporterOptions {
  color: boolean
  columns: number
  cwd?: string
  rows?: number
  spinnerFrames: string[]
}

type JobLifecycle = 'queued' | 'running'

interface JobState {
  job: ProgressJobRef
  retry?: { attempt: number, maxAttempts: number, startedAt?: number }
  startedAt?: number
  state: JobLifecycle
}

interface RuleGroup {
  cached: number
  cancelled: number
  completed: number
  failed: number
  firstJobIndex: number
  jobs: JobState[]
  planned: number
  ruleId: string
  skipped: number
  terminalDurationMs: number
}

type StoredRuleGroup = Omit<RuleGroup, 'jobs'>

interface SummaryState {
  activeJobs: Map<string, JobState>
  animationTick: number
  cachedTokens: number
  errorCount: number
  execution: ExecutionCounts
  jobTokens: Map<string, number>
  progress: ProgressSnapshot
  ruleGroups: Map<string, StoredRuleGroup>
  runStartedAt?: number
  totalTokens: number
  warnCount: number
}

export function createSummaryProgressReporter(options: SummaryProgressReporterOptions): SummaryProgressReporter {
  const now = Date.now
  const state = createInitialState()

  return {
    getRows: () => createRows(state, options, now()),
    onDiagnostic: ({ diagnostic, progress }) => {
      updateProgress(state, progress)
      if (diagnostic.severity === 'warn')
        state.warnCount += 1
      else
        state.errorCount += 1
    },
    onExecuteEnd: ({ progress }) => {
      updateProgress(state, progress)
    },
    onExecuteStart: ({ progress, startedAt }) => {
      updateProgress(state, progress)
      state.runStartedAt = startedAt ?? state.runStartedAt ?? now()
    },
    onFileReady: ({ progress }) => updateProgress(state, progress),
    onJobEnd: (payload) => {
      updateProgress(state, payload.progress)
      const current = state.activeJobs.get(payload.job.id)
      const group = state.ruleGroups.get(payload.job.ruleId)
      if (!group)
        throw new Error(`Cannot finish unqueued progress job "${payload.job.id}".`)
      group[payload.state] += 1
      if (payload.endedAt !== undefined && current?.startedAt !== undefined && payload.state !== 'cached')
        group.terminalDurationMs += Math.max(payload.endedAt - current.startedAt, 0)
      if (payload.state === 'cached') {
        const cachedTokens = state.jobTokens.get(payload.job.id) ?? 0
        state.totalTokens = Math.max(state.totalTokens - cachedTokens, 0)
        state.cachedTokens += cachedTokens
      }
      state.activeJobs.delete(payload.job.id)
      state.jobTokens.delete(payload.job.id)
    },
    onJobQueued: ({ job, progress }) => {
      updateProgress(state, progress)
      // The run engine admits each job exactly once, so rule totals need no unbounded dedupe set.
      const group = state.ruleGroups.get(job.ruleId) ?? createRuleGroup(job)
      group.planned += 1
      state.ruleGroups.set(job.ruleId, group)
      state.activeJobs.set(job.id, { job, state: 'queued' })
    },
    onJobRetry: (payload) => {
      updateProgress(state, payload.progress)
      const current = state.activeJobs.get(payload.job.id)
      state.activeJobs.set(payload.job.id, {
        job: payload.job,
        retry: { attempt: payload.attempt, maxAttempts: payload.maxAttempts, startedAt: payload.startedAt },
        startedAt: current?.startedAt ?? payload.startedAt ?? now(),
        state: current?.state ?? 'running',
      })
    },
    onJobStart: (payload) => {
      updateProgress(state, payload.progress)
      state.activeJobs.set(payload.job.id, {
        job: payload.job,
        startedAt: payload.startedAt ?? now(),
        state: 'running',
      })
    },
    onPlanningEnd: ({ progress }) => updateProgress(state, progress),
    onPrepareStart: ({ startedAt }) => {
      state.activeJobs.clear()
      state.errorCount = 0
      state.execution = createCounts()
      state.progress = createProgress()
      state.ruleGroups.clear()
      state.runStartedAt = startedAt ?? now()
      state.animationTick = 0
      state.cachedTokens = 0
      state.jobTokens.clear()
      state.totalTokens = 0
      state.warnCount = 0
    },
    onRunEnd: (payload) => {
      state.warnCount = payload.diagnostics.filter(diagnostic => diagnostic.severity === 'warn').length
      state.errorCount = payload.diagnostics.length - state.warnCount
      updateProgress(state, payload.progress)
      state.totalTokens = payload.usage.totalTokens
      state.cachedTokens = payload.usage.cached?.totalTokens ?? 0
      state.runStartedAt = payload.startedAt ?? state.runStartedAt
    },
    onUsage: ({ job, progress, record }) => {
      updateProgress(state, progress)
      if (record.totalTokens != null && Number.isFinite(record.totalTokens)) {
        state.jobTokens.set(job.id, (state.jobTokens.get(job.id) ?? 0) + record.totalTokens)
        state.totalTokens += record.totalTokens
      }
    },
    /**
     * Advances the summary animation on each renderer interval.
     *
     * Triggering workflow:
     *
     * `createTtyProgressRenderer`
     *   -> `createCliProgressReporter` `createInterval` callback
     *     -> `SummaryProgressReporter.tick` (this handler)
     *
     * Upstream:
     * - `createCliProgressReporter` `createInterval` callback registered by `createTtyProgressRenderer`
     *
     * Downstream:
     * - Increments `state.animationTick`, consumed by {@link createRows}, {@link formatSpinnerFrame}, and {@link formatMiniBarSegment}.
     */
    tick: () => {
      state.animationTick += 1
    },
  }
}

function compareRuleGroups(left: RuleGroup, right: RuleGroup): number {
  const leftActive = left.jobs.some(job => job.state === 'running')
    ? 1
    : 0
  const rightActive = right.jobs.some(job => job.state === 'running')
    ? 1
    : 0
  if (leftActive !== rightActive)
    return rightActive - leftActive
  if (left.failed !== right.failed)
    return right.failed - left.failed
  return left.firstJobIndex - right.firstJobIndex
}

function compareRunningJobs(left: JobState, right: JobState): number {
  const leftStartedAt = left.startedAt ?? Number.POSITIVE_INFINITY
  const rightStartedAt = right.startedAt ?? Number.POSITIVE_INFINITY
  if (leftStartedAt !== rightStartedAt)
    return leftStartedAt - rightStartedAt
  return left.job.index - right.job.index
}

function completeGraphemeBoundary(input: string, maximumIndex: number): number {
  let boundary = 0

  for (const segment of graphemeSegmenter.segment(input)) {
    const end = segment.index + segment.segment.length
    if (end > maximumIndex)
      break
    boundary = end
  }

  return boundary
}

function createCounts(planned = 0): ExecutionCounts {
  return {
    cached: 0,
    cancelled: 0,
    completed: 0,
    failed: 0,
    planned,
    queued: 0,
    running: 0,
    skipped: 0,
  }
}

function createInitialState(): SummaryState {
  return {
    activeJobs: new Map(),
    animationTick: 0,
    cachedTokens: 0,
    errorCount: 0,
    execution: createCounts(),
    jobTokens: new Map(),
    progress: createProgress(),
    ruleGroups: new Map(),
    totalTokens: 0,
    warnCount: 0,
  }
}

function createProgress(): ProgressSnapshot {
  return {
    execution: createCounts(),
    filesPlanned: 0,
    filesTotal: 0,
    jobsCompleted: 0,
    jobsStarted: 0,
    jobsTotal: 0,
    planningComplete: false,
  }
}

function createRows(state: SummaryState, options: SummaryProgressReporterOptions, now: number): string[] {
  if (options.rows !== undefined && options.rows <= 0)
    return []

  const groups = createRuleGroups(state)
  const footerRows = options.rows === undefined
    ? 3
    : Math.min(options.rows, 3)
  const separatorRows = options.rows === undefined || options.rows - footerRows > 1
    ? 1
    : 0
  const contentBudget = options.rows === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(options.rows - footerRows - separatorRows, 0)
  const visible = formatContentRows(groups, state, options, now, contentBudget)
  const footer = formatFooters(state, options, now)
  const actualSeparatorRows = visible.length > 0
    ? separatorRows
    : 0
  const visibleFooters = options.rows === undefined
    ? footer
    : footer.slice(0, Math.max(options.rows - visible.length - actualSeparatorRows, 0))

  if (actualSeparatorRows === 1)
    visible.push('')
  visible.push(...visibleFooters)

  return options.color
    ? visible.map(row => styleRow(row, state, state.warnCount, state.errorCount, options))
    : visible
}

function createRuleGroup(job: ProgressJobRef): StoredRuleGroup {
  return {
    cached: 0,
    cancelled: 0,
    completed: 0,
    failed: 0,
    firstJobIndex: job.index,
    planned: 0,
    ruleId: job.ruleId,
    skipped: 0,
    terminalDurationMs: 0,
  }
}

function createRuleGroups(state: SummaryState): RuleGroup[] {
  const groups = new Map<string, RuleGroup>(
    [...state.ruleGroups].map(([ruleId, group]) => [
      ruleId,
      { ...group, jobs: [] },
    ]),
  )
  for (const job of state.activeJobs.values())
    groups.get(job.job.ruleId)?.jobs.push(job)

  return [
    ...groups.values(),
  ]
    .sort(compareRuleGroups)
}

function estimateEta(durationMs: number, terminal: number, planned: number): string {
  if (terminal <= 0 || planned <= 0 || durationMs <= 0)
    return 'eta ?'
  const remaining = planned - terminal
  return `eta ~${formatDuration(durationMs * remaining / terminal)}`
}

function fitRow(row: string, columns: number): string {
  if (columns <= 0)
    return ''
  if (fastStringWidth(row) <= columns)
    return row

  // Re-measure the candidate because ambiguous glyphs may differ between the
  // truncation primitive's index calculation and the terminal-width primitive.
  let limit = columns
  while (limit > 0) {
    const result = fastStringTruncatedWidth(row, { ellipsis: '…', limit })
    // The width primitive already skips complete ANSI escape sequences. Clamp
    // its raw index to a grapheme boundary so astral, ZWJ, and combining
    // sequences cannot be split while preserving that ANSI-safe upper bound.
    const index = completeGraphemeBoundary(row, result.index)
    const visible = row.slice(0, index)
    const reset = visible.includes('\u001B')
      ? '\u001B[0m'
      : ''
    const fitted = `${visible}${reset}${result.ellipsed ? '…' : ''}`
    const overflow = fastStringWidth(fitted) - columns

    if (overflow <= 0)
      return fitted
    limit -= overflow
  }

  return ''
}

function formatCollapsedRunningRow(hidden: number, options: SummaryProgressReporterOptions): string {
  return fitRow(`   └─ ${hidden} more running`, options.columns)
}

function formatContentRows(
  groups: RuleGroup[],
  state: SummaryState,
  options: SummaryProgressReporterOptions,
  now: number,
  contentBudget: number,
): string[] {
  const rows: string[] = []
  const renderableGroups = groups.filter(group => group.jobs.some(job => job.state === 'running') || group.failed > 0)
  const runningCount = renderableGroups.reduce(
    (sum, group) => sum + group.jobs.filter(job => job.state === 'running').length,
    0,
  )

  if (contentBudget === 1) {
    const failedGroup = renderableGroups.find(group => group.failed > 0)
    if (failedGroup) {
      return [
        formatRuleRow(failedGroup, state, options),
      ]
    }
    if (runningCount > 0) {
      return [
        formatCollapsedRunningRow(runningCount, options),
      ]
    }
  }

  for (const [groupIndex, group] of renderableGroups.entries()) {
    if (rows.length >= contentBudget)
      break

    const groupStart = rows.length
    rows.push(formatRuleRow(group, state, options))
    const runningJobs = group.jobs
      .filter(job => job.state === 'running')
      .sort(compareRunningJobs)
    const remainingGroups = renderableGroups.length - groupIndex - 1

    for (const [index, job] of runningJobs.entries()) {
      const rowsReservedForLaterGroups = Math.min(remainingGroups, Math.max(contentBudget - rows.length, 0))
      if (rows.length >= contentBudget) {
        const hidden = runningJobs.length - index
        if (rows.length > groupStart + 1 && hidden > 0)
          rows[rows.length - 1] = formatCollapsedRunningRow(hidden, options)
        break
      }
      if (rows.length + 1 + rowsReservedForLaterGroups >= contentBudget) {
        if (runningJobs.length > 1)
          rows.push(formatCollapsedRunningRow(runningJobs.length - index, options))
        break
      }

      rows.push(formatTargetRow(job, options, now, index === runningJobs.length - 1))
    }
  }

  return rows
}

function formatDuration(ms: number): string {
  const durationMs = Math.max(ms, 0)

  // Sub-minute progress changes quickly enough that the existing decimal precision remains useful.
  if (durationMs < 60_000)
    return `${(durationMs / 1000).toFixed(1)}s`

  return formatDateFnsDuration(intervalToDuration({ end: durationMs, start: 0 }))
}

function formatFooters(state: SummaryState, options: SummaryProgressReporterOptions, now: number): string[] {
  const terminal = terminalCount(state.execution)
  const elapsed = state.runStartedAt === undefined
    ? 0
    : now - state.runStartedAt
  const progressBar = state.progress.planningComplete
    ? formatMiniBarSegment(terminal, state.execution.planned, state.animationTick, options)
    : ''
  const eta = state.progress.planningComplete
    ? estimateEta(elapsed, terminal, state.execution.planned)
    : 'eta ?'
  const projectedTokens = state.progress.planningComplete && terminal > 0 && state.execution.planned > 0
    ? Math.ceil((state.totalTokens + state.cachedTokens) * state.execution.planned / terminal)
    : undefined
  const discovering = state.progress.planningComplete ? '' : ' jobs (discovering)'

  return [
    fitRow(`${terminal}/${state.execution.planned}${discovering}${progressBar} ${formatDuration(elapsed)} -> ${eta === 'eta ?'
      ? '~?'
      : eta.replace('eta ', '')}`, options.columns),
    fitRow(`${state.execution.running} concurrency / ${state.execution.queued} queued / ${state.execution.cached} cached / ${state.execution.failed} failed`, options.columns),
    fitRow(`${state.totalTokens.toLocaleString('en-US')} tokens (${state.cachedTokens.toLocaleString('en-US')} cached) -> ${projectedTokens === undefined
      ? '~?'
      : `~${projectedTokens.toLocaleString('en-US')} tokens`}`, options.columns),
  ]
}

function formatMiniBarSegment(completed: number, planned: number, tick: number, options: SummaryProgressReporterOptions): string {
  if (options.columns < 60)
    return ''

  return ` ${formatMiniBar({ completed, planned, tick, width: 10 })}`
}

function formatRuleRow(group: RuleGroup, state: SummaryState, options: SummaryProgressReporterOptions): string {
  const spinner = formatSpinnerFrame(state.animationTick, options.spinnerFrames)
  const terminal = group.completed + group.cached + group.failed + group.cancelled + group.skipped
  const percent = group.planned > 0
    ? Math.floor((terminal / group.planned) * 100)
    : 0
  const bar = formatMiniBarSegment(terminal, group.planned, state.animationTick, options)
  const running = group.jobs.filter(job => job.state === 'running').length
  const failed = group.failed > 0
    ? ` ${group.failed} failed`
    : ''
  const eta = estimateEta(group.terminalDurationMs, terminal, group.planned)

  return fitRow(`${spinner} ${group.ruleId} ${terminal}/${group.planned} ${percent}%${bar} ${eta} ${running} running${failed}`, options.columns)
}

function formatSpinnerFrame(animationTick: number, spinnerFrames: string[]): string {
  return spinnerFrames[animationTick % Math.max(spinnerFrames.length, 1)] ?? ''
}

function formatTargetRow(jobState: JobState, options: SummaryProgressReporterOptions, now: number, last: boolean): string {
  const inputPath = options.cwd
    ? relative(options.cwd, jobState.job.inputPath) || '.'
    : jobState.job.inputPath
  const target = jobState.job.target.name
    ? `${jobState.job.target.kind} ${jobState.job.target.name}`
    : jobState.job.target.kind
  const startedAt = jobState.retry?.startedAt ?? jobState.startedAt ?? now
  const prefix = last ? '   └─' : '   ├─'
  const stateText = jobState.retry
    ? `${jobState.retry.attempt}/${jobState.retry.maxAttempts} retrying elapsed ${formatDuration(now - startedAt)}`
    : `running ${formatDuration(now - startedAt)}`

  return fitRow(`${prefix} ${inputPath} > ${target} ${stateText}`, options.columns)
}

function styleRow(
  row: string,
  state: SummaryState,
  warnCount: number,
  errorCount: number,
  options: SummaryProgressReporterOptions,
): string {
  let styledRow = row
  const spinner = formatSpinnerFrame(state.animationTick, options.spinnerFrames)

  if (spinner)
    styledRow = styledRow.replace(spinner, colors.cyan(spinner))

  return styledRow
    .replace(`${state.execution.running} concurrency`, colors.cyan(`${state.execution.running} concurrency`))
    .replace(`${state.totalTokens.toLocaleString('en-US')} tokens`, colors.cyan(`${state.totalTokens.toLocaleString('en-US')} tokens`))
    .replace(`(${state.cachedTokens.toLocaleString('en-US')} cached)`, colors.dim(`(${state.cachedTokens.toLocaleString('en-US')} cached)`))
    .replace(` / ${state.execution.cached} cached / `, ` / ${colors.dim(`${state.execution.cached} cached`)} / `)
    .replace(`${warnCount} warn`, colors.yellow(`${warnCount} warn`))
    .replace(`${errorCount} error`, (errorCount > 0
      ? colors.red
      : colors.gray)(`${errorCount} error`))
    .replace(`${state.execution.failed} failed`, (state.execution.failed > 0
      ? colors.red
      : colors.gray)(`${state.execution.failed} failed`))
    // eslint-disable-next-line regexp/no-super-linear-backtracking
    .replace(/\[([█▓░]*?)(░+)\]/g, (_, active: string, pending: string) => `[${active}${colors.gray(pending)}]`)
    .replace(/\//g, colors.gray('/'))
}

function terminalCount(counts: ExecutionCounts): number {
  return counts.completed + counts.failed + counts.cached + counts.skipped + counts.cancelled
}

function updateProgress(state: SummaryState, progress: ProgressSnapshot): void {
  state.execution = { ...progress.execution }
  state.progress = {
    ...progress,
    execution: { ...progress.execution },
  }
}

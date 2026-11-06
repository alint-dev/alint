import type { ProgressReporter } from '../types'
import type { RunProgress } from './progress'
import type { RuleJob, RuleJobOutcome } from './types'

import { snapshotFailure, snapshotProgressJobRef } from './records'

export interface RuleSchedulerOptions {
  clock: () => number
  concurrency: number
  execute: (job: RuleJob, startedAt: number) => Promise<RuleJobOutcome>
  progress: RunProgress
  reporter?: ProgressReporter
  signal?: AbortSignal
}

export interface ScheduledRuleBatch {
  jobsAdded: number
  outcomes: Promise<RuleJobOutcome[]>
}

interface Lane {
  items: ScheduledJob[]
  outcomes: Array<RuleJobOutcome | undefined>
  promise: Promise<RuleJobOutcome[]>
  ready: boolean
  remaining: number
  resolve: (outcomes: RuleJobOutcome[]) => void
  settled: boolean
}

interface ScheduledJob {
  index: number
  job: RuleJob
  lane: Lane
}

export class RuleScheduler {
  private accepting = true
  private active = 0
  private cancellingQueued = false
  private closePromise: Promise<void> | undefined
  private closeReject: ((reason: unknown) => void) | undefined
  private closeResolve: (() => void) | undefined
  private infrastructureError: unknown
  private infrastructureFailed = false
  private lanes: Lane[] = []
  private nextAdmissionIndex = 1
  private pumpQueued = false
  private readyLanes: Lane[] = []
  constructor(private readonly options: RuleSchedulerOptions) {
    resolveRuleConcurrency(options.concurrency)
    if (options.signal?.aborted)
      this.accepting = false
    else
      options.signal?.addEventListener('abort', this.abort, { once: true })
  }

  cancelWithError(error: unknown): void {
    this.fail(error)
  }

  close(): Promise<void> {
    this.accepting = false
    if (!this.closePromise) {
      this.closePromise = new Promise<void>((resolve, reject) => {
        this.closeResolve = resolve
        this.closeReject = reject
      })
    }
    this.queuePump()
    this.settleClose()
    return this.closePromise
  }

  completeFilePlanning() {
    return this.options.progress.completeFilePlanning()
  }

  schedule(jobs: readonly RuleJob[]): ScheduledRuleBatch {
    if (!this.accepting || jobs.length === 0) {
      return {
        jobsAdded: 0,
        outcomes: Promise.resolve([]),
      }
    }

    const lane = createLane()
    this.lanes.push(lane)
    let jobsAdded = 0

    for (const job of jobs) {
      if (!this.accepting)
        break
      const index = jobsAdded
      try {
        job.jobRef.index = this.nextAdmissionIndex
        this.nextAdmissionIndex += 1
        const progress = this.options.progress.queue()
        jobsAdded += 1
        lane.remaining += 1
        lane.items.push({ index, job, lane })
        this.options.reporter?.onJobQueued?.({
          job: snapshotProgressJobRef(job.jobRef),
          progress,
        })
      }
      catch (error) {
        this.fail(error)
        throw error
      }
    }

    lane.outcomes.length = jobsAdded
    if (jobsAdded === 0) {
      this.settleLane(lane)
    }
    else {
      this.enqueue(lane)
      this.queuePump()
    }

    return { jobsAdded, outcomes: lane.promise }
  }

  snapshot() {
    return this.options.progress.snapshot()
  }

  private readonly abort = (): void => {
    this.accepting = false
    this.cancelQueued()
    this.settleClose()
  }

  private cancel(item: ScheduledJob, from: 'queued' | 'running', startedAt?: number): void {
    const outcome = cancelledOutcome(item.job)
    const progress = this.options.progress.finish(from, 'cancelled')
    item.lane.outcomes[item.index] = outcome
    item.lane.remaining -= 1
    try {
      this.options.reporter?.onJobEnd?.({
        cache: 'miss',
        endedAt: this.options.clock(),
        job: snapshotProgressJobRef(item.job.jobRef),
        progress,
        startedAt,
        state: 'cancelled',
      })
    }
    catch (error) {
      this.fail(error)
    }
    this.settleLane(item.lane)
  }

  private cancelQueued(): void {
    if (this.cancellingQueued)
      return
    this.cancellingQueued = true
    this.readyLanes = []
    for (const lane of this.lanes)
      lane.ready = false
    try {
      for (const lane of [...this.lanes]) {
        const queued = lane.items.splice(0)
        for (const item of queued)
          this.cancel(item, 'queued')
      }
    }
    finally {
      this.cancellingQueued = false
    }
  }

  private enqueue(lane: Lane): void {
    if (lane.ready || lane.settled || lane.items.length === 0)
      return
    lane.ready = true
    this.readyLanes.push(lane)
  }

  private fail(error: unknown): void {
    this.recordFailure(error)
    this.accepting = false
    this.cancelQueued()
    this.settleClose()
  }

  private finish(item: ScheduledJob, outcome: RuleJobOutcome, startedAt: number): void {
    const progress = this.options.progress.finish('running', outcome.state)
    item.lane.outcomes[item.index] = outcome
    item.lane.remaining -= 1
    try {
      this.options.reporter?.onJobEnd?.({
        cache: outcome.cache,
        endedAt: this.options.clock(),
        failure: outcome.failure
          ? snapshotFailure(outcome.failure)
          : undefined,
        job: snapshotProgressJobRef(item.job.jobRef),
        progress,
        startedAt,
        state: outcome.state,
      })
    }
    catch (error) {
      this.fail(error)
    }
    this.settleLane(item.lane)
  }

  private next(): ScheduledJob | undefined {
    while (this.readyLanes.length > 0) {
      const lane = this.readyLanes.shift()!
      lane.ready = false
      const item = lane.items.shift()
      this.enqueue(lane)
      if (item)
        return item
    }
    return undefined
  }

  private pump(): void {
    this.pumpQueued = false
    if (this.infrastructureFailed || this.options.signal?.aborted) {
      this.cancelQueued()
      this.settleClose()
      return
    }

    while (this.active < this.options.concurrency) {
      const item = this.next()
      if (!item)
        break

      let startedAt: number
      try {
        startedAt = this.options.clock()
      }
      catch (error) {
        this.fail(error)
        this.cancel(item, 'queued')
        break
      }

      try {
        const progress = this.options.progress.start()
        this.options.reporter?.onJobStart?.({
          job: snapshotProgressJobRef(item.job.jobRef),
          progress,
          startedAt,
        })
      }
      catch (error) {
        this.fail(error)
        this.cancel(item, 'running')
        break
      }

      this.active += 1
      void this.run(item, startedAt)
    }
    this.settleClose()
  }

  private queuePump(): void {
    if (this.pumpQueued)
      return
    this.pumpQueued = true
    queueMicrotask(() => this.pump())
  }

  private recordFailure(error: unknown): void {
    if (this.infrastructureFailed)
      return
    this.infrastructureFailed = true
    this.infrastructureError = error
  }

  private removeLane(lane: Lane): void {
    const index = this.lanes.indexOf(lane)
    if (index < 0)
      return
    this.lanes.splice(index, 1)
    if (lane.ready) {
      const readyIndex = this.readyLanes.indexOf(lane)
      if (readyIndex >= 0)
        this.readyLanes.splice(readyIndex, 1)
      lane.ready = false
    }
  }

  private async run(item: ScheduledJob, startedAt: number): Promise<void> {
    try {
      const outcome = await this.options.execute(item.job, startedAt)
      this.finish(item, outcome, startedAt)
    }
    catch (error) {
      this.fail(error)
      this.cancel(item, 'running', startedAt)
    }
    finally {
      this.active -= 1
      this.queuePump()
      this.settleClose()
    }
  }

  private settleClose(): void {
    if (!this.closePromise || this.active !== 0 || this.lanes.length !== 0)
      return
    this.options.signal?.removeEventListener('abort', this.abort)
    if (this.infrastructureFailed)
      this.closeReject?.(this.infrastructureError)
    else
      this.closeResolve?.()
  }

  private settleLane(lane: Lane): void {
    if (lane.settled || lane.remaining !== 0)
      return
    lane.settled = true
    this.removeLane(lane)
    lane.resolve(lane.outcomes.filter((outcome): outcome is RuleJobOutcome => outcome !== undefined))
    this.settleClose()
  }
}

export function cancelledOutcome(job: RuleJob): RuleJobOutcome {
  return {
    cache: 'miss',
    diagnostics: [],
    jobRef: snapshotProgressJobRef(job.jobRef),
    orderKey: { ...job.orderKey },
    state: 'cancelled',
    usage: [],
  }
}

export function resolveRuleConcurrency(ruleConcurrency: number | undefined): number {
  if (ruleConcurrency === undefined)
    return 4
  if (!Number.isFinite(ruleConcurrency) || !Number.isInteger(ruleConcurrency) || ruleConcurrency <= 0)
    throw new TypeError('Rule execution concurrency must be a finite positive integer.')
  return ruleConcurrency
}

function createLane(): Lane {
  let resolve!: (outcomes: RuleJobOutcome[]) => void
  const promise = new Promise<RuleJobOutcome[]>((resolvePromise) => {
    resolve = resolvePromise
  })
  return {
    items: [],
    outcomes: [],
    promise,
    ready: false,
    remaining: 0,
    resolve,
    settled: false,
  }
}

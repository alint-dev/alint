import type { RuleJob, RuleJobOutcome, RuleRuntime, RuleRuntimeState } from './types'

import { AsyncLocalStorage } from 'node:async_hooks'

import { describe, expect, it } from 'vitest'

import { defineRule } from '../../dsl/define'
import { createRunProgress } from './progress'
import { cancelledOutcome, RuleScheduler } from './scheduler'

describe('ruleScheduler', () => {
  it('fairly shares global permits between synchronously admitted batches', async () => {
    const starts: string[] = []
    const active: string[] = []
    let maximum = 0
    const releases = new Map<string, () => void>()
    const progress = createRunProgress(0)
    const scheduler = new RuleScheduler({
      clock: () => 10,
      concurrency: 2,
      execute: async (job) => {
        const name = job.jobRef.id
        starts.push(name)
        active.push(name)
        maximum = Math.max(maximum, active.length)
        await new Promise<void>((resolve) => {
          releases.set(name, resolve)
        })
        active.splice(active.indexOf(name), 1)
        return completedOutcome(job)
      },
      progress,
    })

    const first = scheduler.schedule([
      createJob('a1', 1),
      createJob('a2', 2),
    ])
    const second = scheduler.schedule([
      createJob('b1', 3),
      createJob('b2', 4),
    ])

    await until(() => starts.length === 2)
    expect(starts).toEqual(['a1', 'b1'])
    expect(maximum).toBe(2)

    releases.get('b1')?.()
    await until(() => starts.length === 3)
    releases.get('a1')?.()
    await until(() => starts.length === 4)
    releases.get('a2')?.()
    releases.get('b2')?.()

    const [firstOutcomes, secondOutcomes] = await Promise.all([first.outcomes, second.outcomes])
    await scheduler.close()

    expect(first.jobsAdded).toBe(2)
    expect(second.jobsAdded).toBe(2)
    expect(firstOutcomes.map(outcome => outcome.jobRef.id)).toEqual(['a1', 'a2'])
    expect(secondOutcomes.map(outcome => outcome.jobRef.id)).toEqual(['b1', 'b2'])
    expect(progress.snapshot()).toMatchObject({
      execution: {
        completed: 4,
        planned: 4,
        queued: 0,
        running: 0,
      },
    })
  })

  it('bounds dynamically admitted lanes without starving an existing lane', async () => {
    const starts: string[] = []
    const releases = new Map<string, () => void>()
    const scheduler = new RuleScheduler({
      clock: () => 10,
      concurrency: 1,
      execute: async (job) => {
        starts.push(job.jobRef.id)
        await new Promise<void>((resolve) => {
          releases.set(job.jobRef.id, resolve)
        })
        return completedOutcome(job)
      },
      progress: createRunProgress(0),
    })

    const first = scheduler.schedule([
      createJob('a1', 1),
      createJob('a2', 2),
      createJob('a3', 3),
    ])
    await until(() => starts.length === 1)
    const second = scheduler.schedule([
      createJob('b1', 4),
    ])

    releases.get('a1')?.()
    await until(() => starts.length === 2)
    releases.get('a2')?.()
    await until(() => starts.length === 3)
    const third = scheduler.schedule([
      createJob('c1', 5),
    ])
    const fourth = scheduler.schedule([
      createJob('d1', 6),
    ])

    releases.get('b1')?.()
    await until(() => starts.length === 4)
    expect(starts).toEqual(['a1', 'a2', 'b1', 'a3'])

    releases.get('a3')?.()
    await until(() => starts.length === 5)
    releases.get('c1')?.()
    await until(() => starts.length === 6)
    releases.get('d1')?.()
    await Promise.all([
      first.outcomes,
      second.outcomes,
      third.outcomes,
      fourth.outcomes,
    ])
    await scheduler.close()

    expect(starts).toEqual(['a1', 'a2', 'b1', 'a3', 'c1', 'd1'])
  })

  it('stops admission and starts after abort while draining only active jobs', async () => {
    const controller = new AbortController()
    const starts: string[] = []
    const ends: string[] = []
    const releases = new Map<string, () => void>()
    const progress = createRunProgress(0)
    const scheduler = new RuleScheduler({
      clock: () => 10,
      concurrency: 2,
      execute: async (job) => {
        starts.push(job.jobRef.id)
        await new Promise<void>((resolve) => {
          releases.set(job.jobRef.id, resolve)
        })
        expect(controller.signal.aborted).toBe(true)
        return cancelledOutcome(job)
      },
      progress,
      reporter: {
        onJobEnd: ({ job }) => ends.push(job.id),
      },
      signal: controller.signal,
    })

    const batch = scheduler.schedule([
      createJob('a1', 1),
      createJob('a2', 2),
      createJob('a3', 3),
      createJob('a4', 4),
    ])
    await until(() => starts.length === 2)

    controller.abort('stop')
    await until(() => ends.length === 2)
    const afterAbort = scheduler.schedule([
      createJob('late', 5),
    ])
    const closing = scheduler.close()
    let closed = false
    void closing.then(() => {
      closed = true
    })
    await Promise.resolve()

    expect(starts).toEqual(['a1', 'a2'])
    expect(ends).toEqual(['a3', 'a4'])
    expect(afterAbort.jobsAdded).toBe(0)
    await expect(afterAbort.outcomes).resolves.toEqual([])
    expect(progress.snapshot()).toMatchObject({
      execution: {
        cancelled: 2,
        planned: 4,
        queued: 0,
        running: 2,
      },
    })
    expect(closed).toBe(false)

    releases.get('a1')?.()
    releases.get('a2')?.()
    await expect(batch.outcomes).resolves.toHaveLength(4)
    await closing

    expect(ends).toEqual(['a3', 'a4', 'a1', 'a2'])
    expect(progress.snapshot()).toMatchObject({
      execution: {
        cancelled: 4,
        planned: 4,
        queued: 0,
        running: 0,
      },
    })
  })

  it('resolves terminal batch outcomes but rejects close when execution rejects', async () => {
    const sentinel = new Error('executor failed')
    const progress = createRunProgress(0)
    const scheduler = new RuleScheduler({
      clock: () => 10,
      concurrency: 1,
      execute: async () => { throw sentinel },
      progress,
    })
    const batch = scheduler.schedule([
      createJob('a1', 1),
      createJob('a2', 2),
    ])

    await expect(batch.outcomes).resolves.toMatchObject([
      {
        jobRef: { id: 'a1' },
        state: 'cancelled',
      },
      {
        jobRef: { id: 'a2' },
        state: 'cancelled',
      },
    ])
    await expect(scheduler.close()).rejects.toBe(sentinel)
    expect(progress.snapshot()).toMatchObject({
      execution: {
        cancelled: 2,
        planned: 2,
        queued: 0,
        running: 0,
      },
    })
  })

  it('rejects close when execution rejects with undefined', async () => {
    const progress = createRunProgress(0)
    const scheduler = new RuleScheduler({
      clock: () => 10,
      concurrency: 1,
      execute: () => {
        // eslint-disable-next-line prefer-promise-reject-errors -- The scheduler must preserve an undefined rejection reason.
        return Promise.reject()
      },
      progress,
    })
    const batch = scheduler.schedule([
      createJob('a1', 1),
      createJob('a2', 2),
    ])

    await expect(batch.outcomes).resolves.toMatchObject([
      {
        jobRef: { id: 'a1' },
        state: 'cancelled',
      },
      {
        jobRef: { id: 'a2' },
        state: 'cancelled',
      },
    ])
    const closeResult = await rejectionResult(scheduler.close())

    expect(closeResult).toEqual({ reason: undefined, rejected: true, resolved: false })
    expect(progress.snapshot()).toMatchObject({
      execution: {
        cancelled: 2,
        planned: 2,
        queued: 0,
        running: 0,
      },
    })
  })

  it('rejects close when the start reporter throws undefined', async () => {
    const progress = createRunProgress(0)
    const scheduler = new RuleScheduler({
      clock: () => 10,
      concurrency: 1,
      execute: async job => completedOutcome(job),
      progress,
      reporter: {
        onJobStart: () => {
          // eslint-disable-next-line no-throw-literal -- The scheduler must distinguish an undefined rejection reason from success.
          throw undefined
        },
      },
    })
    const batch = scheduler.schedule([
      createJob('a1', 1),
      createJob('a2', 2),
    ])

    await expect(batch.outcomes).resolves.toMatchObject([
      {
        jobRef: { id: 'a1' },
        state: 'cancelled',
      },
      {
        jobRef: { id: 'a2' },
        state: 'cancelled',
      },
    ])
    const closeResult = await rejectionResult(scheduler.close())

    expect(closeResult).toEqual({ reason: undefined, rejected: true, resolved: false })
    expect(progress.snapshot()).toMatchObject({
      execution: {
        cancelled: 2,
        planned: 2,
        queued: 0,
        running: 0,
      },
    })
  })

  it('iteratively cancels many lanes when every terminal reporter call throws', async () => {
    const controller = new AbortController()
    const progress = createRunProgress(0)
    const reporterErrors: Error[] = []
    const scheduler = new RuleScheduler({
      clock: () => 10,
      concurrency: 1,
      execute: async job => completedOutcome(job),
      progress,
      reporter: {
        onJobEnd: ({ job }) => {
          const error = new Error(`end reporter failed for ${job.id}`)
          reporterErrors.push(error)
          throw error
        },
      },
      signal: controller.signal,
    })
    const batches = Array.from({ length: 5_000 }, (_, index) => {
      return scheduler.schedule([
        createJob(`job-${index}`, index + 1),
      ])
    })

    controller.abort('stop')
    const outcomes = await Promise.all(batches.map(batch => batch.outcomes))
    const closeResult = await rejectionResult(scheduler.close())

    expect(outcomes).toHaveLength(5_000)
    expect(outcomes.every(batch => batch[0]?.state === 'cancelled')).toBe(true)
    expect(reporterErrors).toHaveLength(5_000)
    expect(closeResult).toEqual({ reason: reporterErrors[0], rejected: true, resolved: false })
    expect(progress.snapshot()).toMatchObject({
      execution: {
        cancelled: 5_000,
        planned: 5_000,
        queued: 0,
        running: 0,
      },
    })
  })

  it('returns an immediate empty batch', async () => {
    const scheduler = new RuleScheduler({
      clock: () => 10,
      concurrency: 1,
      execute: async job => completedOutcome(job),
      progress: createRunProgress(0),
    })

    const batch = scheduler.schedule([])

    expect(batch.jobsAdded).toBe(0)
    await expect(batch.outcomes).resolves.toEqual([])
    await scheduler.close()
  })
})

function completedOutcome(job: RuleJob): RuleJobOutcome {
  return {
    cache: 'miss',
    diagnostics: [],
    jobRef: {
      ...job.jobRef,
      target: { ...job.jobRef.target },
    },
    orderKey: { ...job.orderKey },
    state: 'completed',
    usage: [],
  }
}

function createJob(id: string, index: number): RuleJob {
  const rule = defineRule({
    create: () => ({}),
  })
  const runtime: RuleRuntime = {
    cacheable: false,
    enabledRule: {
      id: 'company/review',
      localId: 'review',
      options: [],
      rule,
      severity: 'warn',
    },
    executionState: new AsyncLocalStorage<RuleRuntimeState>(),
    handlers: {},
    ruleHash: 'rule-hash',
    ruleIndex: 0,
  }
  return {
    execution: { handler: 'file', runtime },
    jobRef: {
      id,
      index,
      inputPath: `/repo/${id}.ts`,
      ruleId: 'company/review',
      target: { identity: id, kind: 'file' },
    },
    orderKey: {
      inputIndex: index,
      ruleIndex: 0,
      scope: 'source',
      targetIndex: 0,
    },
    target: {
      cacheTargetHash: `target-${id}`,
      configHash: 'config-hash',
      descriptor: {
        file: {
          contentHash: `content-${id}`,
          language: 'typescript',
          path: `/repo/${id}.ts`,
        },
        identity: id,
        kind: 'file',
        language: 'typescript',
      },
      identity: id,
      kind: 'file',
    },
  }
}

async function rejectionResult(promise: Promise<void>): Promise<{ reason?: unknown, rejected: boolean, resolved: boolean }> {
  let reason: unknown
  let rejected = false
  let resolved = false
  await promise.then(
    () => {
      resolved = true
    },
    (error) => {
      reason = error
      rejected = true
    },
  )
  return { reason, rejected, resolved }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (predicate())
      return
    await Promise.resolve()
  }
  throw new Error('Condition was not reached within the microtask limit.')
}

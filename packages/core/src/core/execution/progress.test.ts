import type { ExecutionCounts } from '../types'

import { describe, expect, it } from 'vitest'

import { createRunProgress } from './progress'

function counts(overrides: Partial<ExecutionCounts> = {}): ExecutionCounts {
  return {
    cached: 0,
    cancelled: 0,
    completed: 0,
    failed: 0,
    planned: 0,
    queued: 0,
    running: 0,
    skipped: 0,
    ...overrides,
  }
}

describe('createRunProgress', () => {
  it.each([0, 2, 7])('starts with %i files and no admitted jobs', (filesTotal) => {
    expect(createRunProgress(filesTotal).snapshot()).toEqual({
      execution: counts(),
      filesPlanned: 0,
      filesTotal,
      jobsCompleted: 0,
      jobsStarted: 0,
      jobsTotal: 0,
      planningComplete: false,
    })
  })

  it('tracks admitted, running, and every terminal job state', () => {
    const progress = createRunProgress(2)
    progress.queue(7)
    progress.completeFilePlanning()
    progress.completeFilePlanning()
    progress.start()
    progress.finish('running', 'completed')
    progress.start()
    progress.finish('running', 'cached')
    progress.start()
    progress.finish('running', 'failed')
    progress.start()
    progress.finish('running', 'skipped')
    progress.start()
    progress.finish('running', 'cancelled')
    progress.finish('queued', 'cancelled')
    progress.finish('queued', 'cancelled')

    expect(progress.snapshot()).toEqual({
      execution: counts({
        cached: 1,
        cancelled: 3,
        completed: 1,
        failed: 1,
        planned: 7,
        skipped: 1,
      }),
      filesPlanned: 2,
      filesTotal: 2,
      jobsCompleted: 7,
      jobsStarted: 7,
      jobsTotal: 7,
      planningComplete: false,
    })
  })

  it('returns detached snapshots', () => {
    const progress = createRunProgress(1)
    const snapshot = progress.snapshot()
    snapshot.execution.planned = 99

    expect(progress.snapshot().execution.planned).toBe(0)
  })

  it('seals planning while admitted jobs are still active, then finalizes execution', () => {
    const progress = createRunProgress(1)
    progress.completeFilePlanning()
    progress.queue(1)
    expect(() => progress.finalize()).toThrow('queued or running')
    expect(progress.completePlanning()).toMatchObject({ jobsCompleted: 0, jobsTotal: 1, planningComplete: true })
    expect(() => progress.queue(1)).toThrow('planning is complete')
    expect(() => progress.completeFilePlanning()).toThrow('planning is complete')
    progress.finish('queued', 'cancelled')

    expect(progress.finalize()).toMatchObject({
      jobsCompleted: 1,
      jobsStarted: 1,
      jobsTotal: 1,
      planningComplete: true,
    })
    expect(progress.snapshot().planningComplete).toBe(true)
  })

  it('rejects invalid counts and transitions', () => {
    expect(() => createRunProgress(-1)).toThrow(TypeError)
    expect(() => createRunProgress(1.5)).toThrow(TypeError)

    const progress = createRunProgress(1)
    expect(() => progress.finalize()).toThrow('planning is complete')
    expect(() => progress.queue(-1)).toThrow(TypeError)
    expect(() => progress.queue(1.5)).toThrow(TypeError)
    expect(() => progress.start()).toThrow('queued')
    expect(() => progress.finish('queued', 'completed')).toThrow('queued')
    progress.queue(1)
    expect(() => progress.finish('running', 'completed')).toThrow('running')
  })

  it('rejects cumulative queue overflow without changing state', () => {
    const progress = createRunProgress(0)
    progress.queue(Number.MAX_SAFE_INTEGER)

    expect(() => progress.queue()).toThrow(TypeError)
    expect(progress.snapshot()).toMatchObject({
      execution: { planned: Number.MAX_SAFE_INTEGER, queued: Number.MAX_SAFE_INTEGER },
      jobsTotal: Number.MAX_SAFE_INTEGER,
    })
  })
})

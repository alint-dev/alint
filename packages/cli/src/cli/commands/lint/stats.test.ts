import type { JobStartPayload, RunEndPayload } from '@alint-js/core'

import { describe, expect, it } from 'vitest'

import { createStatsCollector, mergeProgressReporters, resolveStatsWrite } from './stats'

const EMPTY_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  records: [],
  totalTokens: 0,
}

describe('resolveStatsWrite', () => {
  it('uses the default stats directory', () => {
    expect(resolveStatsWrite(undefined, { XDG_CONFIG_HOME: '/x' })).toEqual({
      dir: '/x/alint/stats',
      retentionMonths: undefined,
    })
  })

  it('does not write in CI or when disabled', () => {
    expect(resolveStatsWrite(undefined, { CI: 'true', XDG_CONFIG_HOME: '/x' })).toBeUndefined()
    expect(resolveStatsWrite(false, { XDG_CONFIG_HOME: '/x' })).toBeUndefined()
    expect(resolveStatsWrite({ enabled: false }, { XDG_CONFIG_HOME: '/x' })).toBeUndefined()
  })

  it('honors a custom location and retention', () => {
    expect(resolveStatsWrite({ location: '/custom', retentionMonths: 3 }, {})).toEqual({
      dir: '/custom',
      retentionMonths: 3,
    })
  })
})

describe('createStatsCollector', () => {
  it('captures final counts and duration', () => {
    const collector = createStatsCollector()
    collector.reporter.onPrepareStart?.({
      startedAt: 1000,
    })
    collector.reporter.onRunEnd?.(runEnd({
      endedAt: 1500,
      execution: counts({
        cached: 1,
        cancelled: 1,
        completed: 1,
        failed: 2,
        planned: 5,
      }),
    }))

    expect(collector.counts).toEqual({
      cached: 1,
      cancelled: 1,
      completed: 1,
      failed: 2,
      planned: 5,
    })
    expect(collector.durationMs()).toBe(500)
  })

  it('leaves duration undefined without timing', () => {
    expect(createStatsCollector().durationMs()).toBeUndefined()
  })
})

describe('mergeProgressReporters', () => {
  it('returns the sole reporter or undefined', () => {
    const reporter = {
      onPrepareStart: () => {},
    }
    expect(mergeProgressReporters(undefined, reporter)).toBe(reporter)
    expect(mergeProgressReporters()).toBeUndefined()
  })

  it('fans payloads out to both reporters', () => {
    const events: string[] = []
    const merged = mergeProgressReporters(
      {
        onRunEnd: () => events.push('base'),
      },
      {
        onRunEnd: () => events.push('extra'),
      },
    )

    merged?.onRunEnd?.(runEnd())

    expect(events).toEqual(['base', 'extra'])
  })

  it('forwards all preparation and execution stage events to both reporters', () => {
    const events: string[] = []
    const stageReporter = (name: string) => ({
      onExecuteEnd: () => events.push(`${name}:execute:end`),
      onExecuteStart: () => events.push(`${name}:execute:start`),
      onFileReady: () => events.push(`${name}:file`),
      onPlanningEnd: () => events.push(`${name}:planning:end`),
      onPrepareEnd: () => events.push(`${name}:prepare:end`),
      onPrepareStart: () => events.push(`${name}:prepare:start`),
    })
    const merged = mergeProgressReporters(stageReporter('base'), stageReporter('extra'))
    const initial = progress(counts({}))

    merged?.onPrepareStart?.({})
    merged?.onPrepareEnd?.({ filesTotal: 1 })
    merged?.onExecuteStart?.({ progress: initial })
    merged?.onFileReady?.({
      fileIndex: 0,
      inputPath: '/repo/a.ts',
      jobsAdded: 0,
      progress: initial,
    })
    merged?.onPlanningEnd?.({
      progress: { ...initial, planningComplete: true },
    })
    merged?.onExecuteEnd?.({
      progress: { ...initial, planningComplete: true },
    })

    expect(events).toEqual([
      'base:prepare:start',
      'extra:prepare:start',
      'base:prepare:end',
      'extra:prepare:end',
      'base:execute:start',
      'extra:execute:start',
      'base:file',
      'extra:file',
      'base:planning:end',
      'extra:planning:end',
      'base:execute:end',
      'extra:execute:end',
    ])
  })

  it('forwards retry progress to both reporters', () => {
    const events: string[] = []
    const payload = {
      attempt: 1,
      job: jobStart().job,
      maxAttempts: 3,
      progress: progress(counts({ planned: 1, running: 1 })),
    }
    const merged = mergeProgressReporters(
      {
        onJobRetry: retry => events.push(`base:${retry.attempt}/${retry.maxAttempts}`),
      },
      {
        onJobRetry: retry => events.push(`extra:${retry.job.ruleId}`),
      },
    )

    merged?.onJobRetry?.(payload)

    expect(events).toEqual(['base:1/3', 'extra:rule/a'])
  })

  it('isolates a failed consumer while the other receives current and later events', () => {
    const cause = new Error('UI failed')
    const baseEvents: string[] = []
    const extraEvents: string[] = []
    const merged = mergeProgressReporters(
      {
        onJobStart: () => {
          baseEvents.push('job:start')
          throw cause
        },
        onRunEnd: () => baseEvents.push('run:end'),
      },
      {
        onJobStart: () => extraEvents.push('job:start'),
        onRunEnd: () => extraEvents.push('run:end'),
      },
    )

    merged?.onJobStart?.(jobStart())

    expect(() => merged?.onRunEnd?.(runEnd())).toThrow(cause)
    expect(baseEvents).toEqual(['job:start'])
    expect(extraEvents).toEqual(['job:start', 'run:end'])
  })

  it('normalizes one nullish consumer failure after delivering to both', () => {
    const events: string[] = []
    const merged = mergeProgressReporters(
      {
        onRunEnd: () => {
          events.push('base')
          throwValue(null)
        },
      },
      {
        onRunEnd: () => events.push('extra'),
      },
    )

    expect(() => merged?.onRunEnd?.(runEnd())).toThrow(new Error('Unknown progress reporter error.'))
    expect(events).toEqual(['base', 'extra'])
  })
})

function counts(overrides: Partial<RunEndPayload['execution']>): RunEndPayload['execution'] {
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

function jobStart(): JobStartPayload {
  return {
    job: {
      id: 'job:0',
      index: 0,
      inputPath: '/repo/a.ts',
      ruleId: 'rule/a',
      target: { identity: 'file:0', kind: 'file' },
    },
    progress: progress(counts({ planned: 1, running: 1 })),
  }
}

function progress(execution: RunEndPayload['execution'], final = false): RunEndPayload['progress'] {
  const jobsCompleted = execution.cached + execution.cancelled + execution.completed + execution.failed + execution.skipped
  return {
    execution,
    filesPlanned: 0,
    filesTotal: 0,
    jobsCompleted,
    jobsStarted: jobsCompleted + execution.running,
    jobsTotal: execution.planned,
    planningComplete: final,
  }
}

function runEnd(overrides: Partial<RunEndPayload> = {}): RunEndPayload {
  return {
    diagnostics: [],
    execution: counts({}),
    progress: progress(counts({}), true),
    usage: EMPTY_USAGE,
    ...overrides,
  }
}

function throwValue(value: unknown): never {
  throw value
}

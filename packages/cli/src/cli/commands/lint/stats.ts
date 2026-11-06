import type { RunnerConfig } from '@alint-js/config'
import type { PrepareStartPayload, ProgressReporter, RunEndPayload, RunResult } from '@alint-js/core'

import type { RunRuleCounts } from '../../stats'

import { getStatsDir } from '@alint-js/config'

import { createJsonlStatsStore, createRunStat, isCi } from '../../stats'

export interface StatsCollector {
  counts: RunRuleCounts
  durationMs: () => number | undefined
  reporter: ProgressReporter
}

interface StatsWriteTarget {
  dir: string
  retentionMonths?: number
}

export function createStatsCollector(): StatsCollector {
  const counts: RunRuleCounts = {
    cached: 0,
    cancelled: 0,
    completed: 0,
    failed: 0,
    planned: 0,
  }
  let startedAt: number | undefined
  let endedAt: number | undefined

  return {
    counts,
    durationMs: () => (startedAt !== undefined && endedAt !== undefined
      ? endedAt - startedAt
      : undefined),
    reporter: {
      onPrepareStart: (payload: PrepareStartPayload) => {
        startedAt = payload.startedAt
      },
      onRunEnd: (payload: RunEndPayload) => {
        counts.cached = payload.execution.cached
        counts.cancelled = payload.execution.cancelled
        counts.completed = payload.execution.completed
        counts.failed = payload.execution.failed
        counts.planned = payload.execution.planned
        endedAt = payload.endedAt
      },
    },
  }
}

export function mergeProgressReporters(
  base?: ProgressReporter,
  extra?: ProgressReporter,
): ProgressReporter | undefined {
  if (!base) {
    return extra
  }

  if (!extra) {
    return base
  }

  const baseState = { disabled: false, reporter: base }
  const extraState = { disabled: false, reporter: extra }
  let firstFailure: Error | undefined
  const deliver = (
    state: { disabled: boolean, reporter: ProgressReporter },
    callback: (reporter: ProgressReporter) => void,
  ): void => {
    if (state.disabled)
      return

    try {
      callback(state.reporter)
    }
    catch (error) {
      state.disabled = true
      firstFailure ??= normalizeReporterError(error)
    }
  }
  const deliverBoth = (callback: (reporter: ProgressReporter) => void): void => {
    deliver(baseState, callback)
    deliver(extraState, callback)
  }

  return {
    onDiagnostic: (payload) => {
      deliverBoth(reporter => reporter.onDiagnostic?.(payload))
    },
    onExecuteEnd: (payload) => {
      deliverBoth(reporter => reporter.onExecuteEnd?.(payload))
    },
    onExecuteStart: (payload) => {
      deliverBoth(reporter => reporter.onExecuteStart?.(payload))
    },
    onFileReady: (payload) => {
      deliverBoth(reporter => reporter.onFileReady?.(payload))
    },
    onJobEnd: (payload) => {
      deliverBoth(reporter => reporter.onJobEnd?.(payload))
    },
    onJobQueued: (payload) => {
      deliverBoth(reporter => reporter.onJobQueued?.(payload))
    },
    onJobRetry: (payload) => {
      deliverBoth(reporter => reporter.onJobRetry?.(payload))
    },
    onJobStart: (payload) => {
      deliverBoth(reporter => reporter.onJobStart?.(payload))
    },
    onPlanningEnd: (payload) => {
      deliverBoth(reporter => reporter.onPlanningEnd?.(payload))
    },
    onPrepareEnd: (payload) => {
      deliverBoth(reporter => reporter.onPrepareEnd?.(payload))
    },
    onPrepareStart: (payload) => {
      deliverBoth(reporter => reporter.onPrepareStart?.(payload))
    },
    onRunEnd: (payload) => {
      deliverBoth(reporter => reporter.onRunEnd?.(payload))
      if (firstFailure)
        throw firstFailure
    },
    onUsage: (payload) => {
      deliverBoth(reporter => reporter.onUsage?.(payload))
    },
  }
}

export function resolveStatsWrite(
  stats: RunnerConfig['stats'],
  env: NodeJS.ProcessEnv | undefined,
): StatsWriteTarget | undefined {
  if (isCi(env)) {
    return undefined
  }

  const enabled = stats === false
    ? false
    : (stats === undefined || stats === true
        ? true
        : stats.enabled !== false)

  if (!enabled) {
    return undefined
  }

  const config = typeof stats === 'object'
    ? stats
    : undefined

  return { dir: config?.location ?? getStatsDir(env), retentionMonths: config?.retentionMonths }
}

export async function writeRunStats(
  target: StatsWriteTarget,
  collector: StatsCollector,
  result: RunResult,
  cwd: string,
): Promise<void> {
  const store = createJsonlStatsStore({ dir: target.dir, retentionMonths: target.retentionMonths })

  try {
    await store.record(createRunStat({
      cwd,
      durationMs: collector.durationMs(),
      ruleCounts: {
        cached: result.execution.cached,
        cancelled: result.execution.cancelled,
        completed: result.execution.completed,
        failed: result.execution.failed,
        planned: result.execution.planned,
      },
      usage: result.usage,
    }))
  }
  catch {
    // Noop: Stats persistence is non-critical.
  }
}

function normalizeReporterError(error: unknown): Error {
  if (error instanceof Error)
    return error
  return new Error(error != null
    ? String(error)
    : 'Unknown progress reporter error.')
}

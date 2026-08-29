import type { ProgressReporter, RunResult } from '@alint-js/core'

import type { RunSession, SessionTargetSelection } from '../../runtime/session'
import type { CliIo } from '../../types'
import type { LintCommandOptions } from './options'

import { AlintCachePersistenceError, AlintRunCancelledError, AlintRunError } from '@alint-js/core'

import { resolveRunnerConfig } from './runner'
import { createStatsCollector, mergeProgressReporters, resolveStatsWrite, writeRunStats } from './stats'

export type LintExecutionOptions = SessionTargetSelection & {
  cacheOnly?: boolean
  createSignal?: () => AbortSignal
  io: CliIo
  modelOverride?: string
  outputLanguage?: string
  progress?: ProgressReporter
  runnerOptions: LintCommandOptions
  session: RunSession
  signal?: AbortSignal
}

/** Runs one session while keeping CLI flags and stats behavior identical for every caller. */
export async function executeLint(options: LintExecutionOptions): Promise<RunResult> {
  const runner = resolveRunnerConfig(options.session.runner, options.runnerOptions)
  const statsTarget = resolveStatsWrite(runner?.stats, options.io.env)
  const statsCollector = statsTarget ? createStatsCollector() : undefined
  const persistStats = async (result: RunResult): Promise<void> => {
    if (statsTarget && statsCollector) {
      await writeRunStats(statsTarget, statsCollector, result, options.session.cwd)
    }
  }
  const targetSelection: SessionTargetSelection = options.targets === undefined
    ? { inputs: options.inputs }
    : { targets: options.targets }
  let result: RunResult

  try {
    result = await options.session.run({
      ...targetSelection,
      cacheOnly: options.cacheOnly,
      modelOverride: options.modelOverride,
      outputLanguage: options.outputLanguage,
      progress: mergeProgressReporters(options.progress, statsCollector?.reporter),
      runner,
      signal: options.signal ?? options.createSignal?.(),
    })
  }
  catch (error) {
    if (error instanceof AlintRunError || error instanceof AlintRunCancelledError || error instanceof AlintCachePersistenceError) {
      await persistStats(error.result)
    }

    throw error
  }

  await persistStats(result)
  return result
}

import type { RunnerConfig } from '@alint-js/core'

import type { LintCommandOptions } from './options'

/**
 * Applies this invocation's flags on top of the project's resolved runner.
 *
 * The setup/config merge itself lives in `runtime/runner.ts` because the language server needs the
 * same base without any flags; only the overrides below are CLI-shaped.
 */
export function resolveRunnerConfig(
  baseRunner: RunnerConfig | undefined,
  options: LintCommandOptions,
): RunnerConfig | undefined {
  const ruleConcurrency = parsePositiveIntegerOption(options.ruleConcurrency, '--rule-concurrency')
  const timeoutMs = parsePositiveIntegerOption(options.timeoutMs, '--timeout-ms')
  const runner = {
    ...(baseRunner ?? {}),
    cache: resolveCacheOption(baseRunner?.cache, options),
    ruleConcurrency: ruleConcurrency ?? baseRunner?.ruleConcurrency,
    // --no-stats is a hard off-switch for this run. The CI gate lives in the writer
    // (resolveStatsWrite), not here.
    stats: options.stats === false
      ? false
      : baseRunner?.stats,
    timeoutMs: timeoutMs ?? baseRunner?.timeoutMs,
  }

  return Object.values(runner).some(value => value !== undefined)
    ? runner
    : undefined
}

function parsePositiveIntegerOption(value: string | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined
  }

  const parsed = Number(value)

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`)
  }

  return parsed
}

function resolveCacheOption(
  baseCache: RunnerConfig['cache'],
  options: LintCommandOptions,
): RunnerConfig['cache'] {
  if (options.cache === false) {
    return false
  }

  if (options.cacheLocation !== undefined) {
    return typeof baseCache === 'object'
      ? { ...baseCache, location: options.cacheLocation }
      : { location: options.cacheLocation }
  }

  return baseCache
}

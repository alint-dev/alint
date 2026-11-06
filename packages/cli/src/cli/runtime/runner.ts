import type { AlintConfig, RunnerConfig } from '@alint-js/core'

import { normalizeConfig } from '@alint-js/core'

/**
 * Merges the setup config runner with the project config runner. No CLI flag is applied.
 *
 * `runner.cache` selects the cache file. The lint command and the language server must merge it
 * the same way, or the editor reads a different file and reports nothing.
 */
export function mergeRunnerConfigs(
  setupRunner: RunnerConfig | undefined,
  configRunner: RunnerConfig | undefined,
): RunnerConfig | undefined {
  const runner = {
    ...(setupRunner ?? {}),
    ...(configRunner ?? {}),
    cache: mergeCacheConfig(setupRunner?.cache, configRunner?.cache),
    // The spread alone would let an explicit undefined in the project config erase the setup value.
    ruleConcurrency: configRunner?.ruleConcurrency ?? setupRunner?.ruleConcurrency,
    stats: mergeStatsConfig(setupRunner?.stats, configRunner?.stats),
    timeoutMs: configRunner?.timeoutMs ?? setupRunner?.timeoutMs,
  }

  return Object.values(runner).some(value => value !== undefined)
    ? runner
    : undefined
}

/** The last `runner` block in the flattened config takes precedence, key by key. */
export function resolveConfigRunner(config: AlintConfig): RunnerConfig | undefined {
  return normalizeConfig(config).reduce<RunnerConfig | undefined>(
    (merged, item) => item.runner
      ? {
          ...merged,
          ...item.runner,
        }
      : merged,
    undefined,
  )
}

function mergeCacheConfig(
  setupCache: RunnerConfig['cache'],
  configCache: RunnerConfig['cache'],
): RunnerConfig['cache'] {
  if (configCache === undefined) {
    return setupCache
  }

  // A boolean switches the whole cache, so it replaces the object form instead of merging.
  if (typeof configCache === 'boolean') {
    return configCache
  }

  if (typeof setupCache === 'object') {
    return {
      ...setupCache,
      ...configCache,
    }
  }

  return configCache
}

function mergeStatsConfig(
  setupStats: RunnerConfig['stats'],
  configStats: RunnerConfig['stats'],
): RunnerConfig['stats'] {
  if (configStats === undefined) {
    return setupStats
  }

  if (typeof configStats === 'boolean') {
    return configStats
  }

  if (typeof setupStats === 'object') {
    return {
      ...setupStats,
      ...configStats,
    }
  }

  return configStats
}

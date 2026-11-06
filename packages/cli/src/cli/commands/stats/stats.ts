import type { RunnerConfig } from '@alint-js/config'

import type { StatsDimension, StatsInterval, StatsMetric, StatsStore } from '../../stats'
import type { CliIo } from '../../types'
import type { StatsCommandOptions } from './options'

import { getStatsDir, loadAlintConfig } from '@alint-js/config'
import { errorMessageFrom } from '@moeru/std'

import { resolveConfigRunner } from '../../runtime/runner'
import { createJsonlStatsStore } from '../../stats'
import { loadMergedSetupConfig } from '../config/setup-config'
import { formatStatsAggregate } from './format'
import { formatStatsTimeline } from './timeline'

const DIMENSIONS = new Set<StatsDimension>(['dir', 'model', 'operation', 'rule'])
const METRICS = new Set<StatsMetric>(['runs', 'tokens'])
const INTERVALS = new Set<StatsInterval>(['day', 'month', 'week'])

export async function runStatsCommand(options: StatsCommandOptions, io: CliIo): Promise<number> {
  try {
    const metric = parseMetric(options.metric)
    const rules = parseRules(options.rule)
    const cwd = options.here === true
      ? io.cwd
      : options.cwd
    const color = io.stdout.isTTY === true
    const exact = options.exactNumbers === true
    const store = await resolveStore(io)

    if (options.chart === true) {
      const series = await store.querySeries({
        cwd,
        interval: parseInterval(options.interval),
        rules,
        since: options.since,
      })

      io.stdout.write(options.json === true
        ? `${JSON.stringify(series, null, 2)}\n`
        : formatStatsTimeline(series, {
            color,
            columns: io.stdout.columns,
            exact,
            metric,
            rules,
            vertical: options.vertical === true,
          }))

      return 0
    }

    const aggregate = await store.query({
      by: parseDimension(options.by),
      cwd,
      rules,
      since: options.since,
    })

    io.stdout.write(options.json === true
      ? `${JSON.stringify(aggregate, null, 2)}\n`
      : formatStatsAggregate(aggregate, { color, exact, metric }))

    return 0
  }
  catch (error) {
    io.stderr.write(`${errorMessageFrom(error) ?? 'Failed to read stats.'}\n`)

    return 2
  }
}

function parseDimension(value: string | undefined): StatsDimension {
  if (value === undefined) {
    return 'model'
  }

  if (DIMENSIONS.has(value as StatsDimension)) {
    return value as StatsDimension
  }

  throw new Error(`Invalid --by "${value}": use rule, operation, model, or dir.`)
}

function parseInterval(value: string | undefined): StatsInterval | undefined {
  if (value === undefined) {
    return undefined
  }

  if (INTERVALS.has(value as StatsInterval)) {
    return value as StatsInterval
  }

  throw new Error(`Invalid --interval "${value}": use day, week, or month.`)
}

function parseMetric(value: string | undefined): StatsMetric {
  if (value === undefined) {
    return 'tokens'
  }

  if (METRICS.has(value as StatsMetric)) {
    return value as StatsMetric
  }

  throw new Error(`Invalid --metric "${value}": use tokens or runs.`)
}

function parseRules(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined
  }

  const rules = value.split(',').map(rule => rule.trim()).filter(Boolean)

  return rules.length > 0
    ? rules
    : undefined
}

async function resolveStore(io: CliIo): Promise<StatsStore> {
  const [setupConfig, config] = await Promise.all([
    loadMergedSetupConfig(io),
    loadAlintConfig(io.cwd),
  ])

  // Note(Makito): No location override via CLI options for now.
  const dir = statsLocation(resolveConfigRunner(config)?.stats)
    ?? statsLocation(setupConfig.runner?.stats)
    ?? getStatsDir(io.env)

  return createJsonlStatsStore({ dir })
}

function statsLocation(stats: RunnerConfig['stats']): string | undefined {
  return typeof stats === 'object'
    ? stats.location
    : undefined
}

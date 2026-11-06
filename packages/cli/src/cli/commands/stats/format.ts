import type { StatsAggregate, StatsDimension, StatsGroupRow, StatsMetric } from '../../stats'

import { createColors } from 'tinyrainbow'

export interface FormatStatsOptions {
  color?: boolean
  /** Show exact counts instead of the compact k/M/B formats. */
  exact?: boolean
  metric?: StatsMetric
}

export type Paint = (text: string, style: (value: string) => string) => string

export interface StatsTotals {
  totalIn: number
  totalOut: number
  totalRuns: number
  totalTok: number
}

export const colors = createColors({ force: true })

export const DIMENSION_LABEL: Record<StatsDimension, string> = {
  dir: 'directory',
  model: 'model',
  operation: 'operation',
  rule: 'rule',
}

export function formatMetric(row: StatsGroupRow, metric: StatsMetric, exact = false): string {
  return formatMetricValue(metricValue(row, metric), metric, exact)
}

export function formatMetricValue(value: number, metric: StatsMetric, exact = false): string {
  return metric === 'runs'
    ? String(value)
    : formatTokens(value, exact)
}

export function formatStatsAggregate(aggregate: StatsAggregate, options: FormatStatsOptions = {}): string {
  const paint: Paint = (text, style) => options.color === true
    ? style(text)
    : text
  const metric = options.metric ?? 'tokens'
  const exact = options.exact === true
  const lines = [
    summaryLine(aggregate, paint, exact),
    '',
  ]

  if (aggregate.rows.length === 0) {
    lines.push('No stats recorded yet.')

    return `${lines.join('\n')}\n`
  }

  const header = [
    DIMENSION_LABEL[aggregate.dimension],
    'runs',
    'input',
    'output',
    'total',
  ]
  const rows = sortRows(aggregate.rows, metric).map(row => [
    row.key,
    String(row.runs),
    formatTokens(row.inTok, exact),
    formatTokens(row.outTok, exact),
    formatTokens(row.totalTok, exact),
  ])
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map(row => row[index].length)))
  const renderRow = (cells: string[], isHeader: boolean): string =>
    cells
      .map((cell, index) => {
        const aligned = index === 0
          ? cell.padEnd(widths[index])
          : cell.padStart(widths[index])

        return isHeader
          ? paint(aligned, colors.bold)
          : aligned
      })
      .join('  ')

  lines.push(renderRow(header, true), ...rows.map(row => renderRow(row, false)))

  return `${lines.join('\n')}\n`
}

export function formatTokens(value: number, exact = false): string {
  if (exact || value < 10_000) {
    return value.toLocaleString('en-US')
  }

  if (value >= 1e9) {
    return `${(value / 1e9).toFixed(2)}B`
  }

  if (value >= 1e6) {
    return `${(value / 1e6).toFixed(2)}M`
  }

  return `${(value / 1e3).toFixed(2)}k`
}

export function metricValue(row: StatsGroupRow, metric: StatsMetric): number {
  return metric === 'runs'
    ? row.runs
    : row.totalTok
}

export function sortRows(rows: StatsGroupRow[], metric: StatsMetric): StatsGroupRow[] {
  return [...rows].sort((left, right) => metricValue(right, metric) - metricValue(left, metric))
}

export function summaryLine(totals: StatsTotals, paint: Paint, exact = false): string {
  const runLabel = totals.totalRuns === 1
    ? 'run'
    : 'runs'

  return `${totals.totalRuns} ${runLabel} — ${formatTokens(totals.totalIn, exact)} in / ${formatTokens(totals.totalOut, exact)} out / ${paint(`${formatTokens(totals.totalTok, exact)} total`, colors.cyan)}`
}

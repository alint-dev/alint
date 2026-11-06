import type { StatsBucket, StatsInterval, StatsMetric, StatsSeries } from '../../stats'
import type { FormatStatsOptions, Paint } from './format'

import { colors, formatMetric, formatMetricValue, metricValue, summaryLine } from './format'

export interface FormatTimelineOptions extends FormatStatsOptions {
  columns?: number
  rules?: string[]
  vertical?: boolean
}

interface RenderCtx {
  exact: boolean
  interval: StatsInterval
  metric: StatsMetric
  paint: Paint
}

const CHART_HEIGHT = 6
const BAR_GAP = 2
const COLUMN_STRIDE = 1 + BAR_GAP
const VERTICAL_BLOCKS = [
  ' ',
  '▁',
  '▂',
  '▃',
  '▄',
  '▅',
  '▆',
  '▇',
  '█',
]
const HORIZONTAL_BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
const FULL_BLOCK = '█'
const HORIZONTAL_BAR_MIN = 8
const HORIZONTAL_BAR_MAX = 40
const SUMMARY_GAP = 3
const SUMMARY_MAX_COLUMNS = 4
const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

export function formatStatsTimeline(series: StatsSeries, options: FormatTimelineOptions = {}): string {
  const paint: Paint = (text, style) => options.color === true
    ? style(text)
    : text
  const metric = options.metric ?? 'tokens'
  const exact = options.exact === true
  const ctx: RenderCtx = {
    exact,
    interval: series.interval,
    metric,
    paint,
  }
  const lines = [
    summaryLine(series, paint, exact),
    '',
    caption(series, metric, options.rules),
  ]

  if (series.buckets.length === 0) {
    lines.push('No stats recorded yet.')

    return `${lines.join('\n')}\n`
  }

  const values = series.buckets.map(bucket => metricValue(bucket, metric))
  const maxValue = Math.max(...values)
  const axisWidth = Math.max(formatMetricValue(maxValue, metric, exact).length, 1)
  const verticalWidth = axisWidth + 2 + series.buckets.length * COLUMN_STRIDE
  const width = options.columns ?? 80

  if (options.vertical === true && verticalWidth <= width) {
    const chart = renderVertical(series.buckets, values, maxValue, axisWidth, ctx)
    const list = summaryList(series.buckets, width, ctx)

    return `${[
      ...lines,
      ...chart,
      '',
      ...list,
    ].join('\n')}\n`
  }

  return `${[
    ...lines,
    ...renderHorizontal(series.buckets, values, maxValue, width, ctx),
  ].join('\n')}\n`
}

function axisRows(buckets: StatsBucket[], interval: StatsInterval, chartWidth: number): string[] {
  if (interval === 'month') {
    return [
      endpointAxis(buckets, chartWidth),
    ]
  }

  const days = Array.from({ length: chartWidth + 4 }).fill(' ')
  const months = Array.from({ length: chartWidth + 4 }).fill(' ')

  buckets.forEach((bucket, index) => {
    const date = new Date(bucket.startMs)
    const at = BAR_GAP + index * COLUMN_STRIDE
    const previous = index === 0
      ? undefined
      : new Date(buckets[index - 1]!.startMs)

    writeAt(days, at, String(date.getUTCDate()).padStart(2, '0'))

    if (startsNewMonth(previous, date)) {
      writeAt(months, at, MONTH_LABELS[date.getUTCMonth()]!)
    }
  })

  return [
    days.join('').replace(/\s+$/u, ''),
    months.join('').replace(/\s+$/u, ''),
  ]
}

function caption(series: StatsSeries, metric: StatsMetric, rules: string[] | undefined): string {
  const filter = rules && rules.length > 0
    ? ` — ${rules.join(', ')}`
    : ''

  return `${metric} by ${series.interval}${filter}`
}

function endpointAxis(buckets: StatsBucket[], chartWidth: number): string {
  const first = buckets[0]!.key

  if (buckets.length === 1) {
    return `${' '.repeat(BAR_GAP)}${first}`
  }

  const last = buckets.at(-1)!.key
  const lastStart = chartWidth - last.length
  const firstEnd = BAR_GAP + first.length

  return lastStart > firstEnd
    ? `${' '.repeat(BAR_GAP)}${first}${' '.repeat(lastStart - firstEnd)}${last}`
    : `${' '.repeat(BAR_GAP)}${first} … ${last}`
}

function renderHorizontal(
  buckets: StatsBucket[],
  values: number[],
  maxValue: number,
  width: number,
  ctx: RenderCtx,
): string[] {
  const labels = buckets.map(bucket => formatMetric(bucket, ctx.metric, ctx.exact))
  const keyWidth = Math.max(...buckets.map(bucket => bucket.key.length))
  const valueWidth = Math.max(...labels.map(label => label.length))
  const barWidth = Math.max(
    HORIZONTAL_BAR_MIN,
    Math.min(HORIZONTAL_BAR_MAX, width - keyWidth - valueWidth - 6),
  )

  return buckets.map((bucket, index) => {
    const bar = renderHorizontalBar(maxValue === 0
      ? 0
      : values[index]! / maxValue, barWidth)

    return `${bucket.key.padEnd(keyWidth)}  ${ctx.paint(bar, colors.cyan)}  ${labels[index]!.padStart(valueWidth)}`
  })
}

function renderHorizontalBar(fraction: number, width: number): string {
  const eighths = fraction <= 0
    ? 0
    : Math.max(1, Math.round(fraction * width * 8))
  const full = Math.floor(eighths / 8)

  return `${FULL_BLOCK.repeat(full)}${HORIZONTAL_BLOCKS[eighths % 8]}`.padEnd(width)
}

function renderVertical(
  buckets: StatsBucket[],
  values: number[],
  maxValue: number,
  axisWidth: number,
  ctx: RenderCtx,
): string[] {
  const columnAt = (index: number): number => BAR_GAP + index * COLUMN_STRIDE
  const chartWidth = columnAt(buckets.length - 1) + 1
  const eighths = values.map((value) => {
    if (value <= 0 || maxValue === 0) {
      return 0
    }

    return Math.max(1, Math.round((value / maxValue) * CHART_HEIGHT * 8))
  })
  const gutter = ' '.repeat(axisWidth)
  const lines: string[] = []

  for (let row = CHART_HEIGHT - 1; row >= 0; row -= 1) {
    const cells = Array.from({ length: chartWidth }).fill(' ')

    eighths.forEach((total, index) => {
      cells[columnAt(index)] = VERTICAL_BLOCKS[Math.max(0, Math.min(8, total - row * 8))]!
    })

    const label = row === CHART_HEIGHT - 1
      ? formatMetricValue(maxValue, ctx.metric, ctx.exact).padStart(axisWidth)
      : gutter
    const axis = row === CHART_HEIGHT - 1
      ? '┤'
      : '│'

    lines.push(`${label} ${axis}${ctx.paint(cells.join('').replace(/\s+$/u, ''), colors.cyan)}`)
  }

  const baseline = Array.from({ length: chartWidth }).fill('─')

  buckets.forEach((_, index) => {
    baseline[columnAt(index)] = '┴'
  })
  lines.push(`${'0'.padStart(axisWidth)} ┼${baseline.join('')}`)

  for (const labelRow of axisRows(buckets, ctx.interval, chartWidth)) {
    lines.push(`${gutter}  ${labelRow}`)
  }

  return lines
}

function startsNewMonth(previous: Date | undefined, date: Date): boolean {
  if (previous === undefined) {
    return true
  }

  return previous.getUTCFullYear() !== date.getUTCFullYear() || previous.getUTCMonth() !== date.getUTCMonth()
}

function summaryList(buckets: StatsBucket[], width: number, ctx: RenderCtx): string[] {
  const labels = buckets.map(bucket => formatMetric(bucket, ctx.metric, ctx.exact))
  const keyWidth = Math.max(...buckets.map(bucket => bucket.key.length))
  const valueWidth = Math.max(...labels.map(label => label.length))
  const cellWidth = keyWidth + 2 + valueWidth
  const perRow = Math.max(1, Math.min(SUMMARY_MAX_COLUMNS, Math.floor((width + SUMMARY_GAP) / (cellWidth + SUMMARY_GAP))))
  const rows: string[] = []

  for (let start = 0; start < buckets.length; start += perRow) {
    rows.push(buckets
      .slice(start, start + perRow)
      .map((bucket, offset) => `${bucket.key.padEnd(keyWidth)}  ${labels[start + offset]!.padStart(valueWidth)}`)
      .join(' '.repeat(SUMMARY_GAP)))
  }

  return rows
}

function writeAt(cells: unknown[], at: number, text: string): void {
  for (let index = 0; index < text.length && at + index < cells.length; index += 1) {
    cells[at + index] = text[index]!
  }
}

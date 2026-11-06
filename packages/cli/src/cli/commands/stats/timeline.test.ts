import type { StatsBucket, StatsInterval, StatsSeries } from '../../stats'

import { describe, expect, it } from 'vitest'

import { formatStatsTimeline } from './timeline'

function bucket(key: string, startMs: number, runs: number, totalTok: number): StatsBucket {
  return {
    inTok: totalTok,
    key,
    outTok: 0,
    runs,
    startMs,
    totalTok,
  }
}

function series(buckets: StatsBucket[], interval: StatsInterval = 'day', overrides: Partial<StatsSeries> = {}): StatsSeries {
  return {
    buckets,
    interval,
    totalIn: 0,
    totalOut: 0,
    totalRuns: buckets.reduce((sum, item) => sum + item.runs, 0),
    totalTok: buckets.reduce((sum, item) => sum + item.totalTok, 0),
    ...overrides,
  }
}

describe('formatStatsTimeline', () => {
  it('reports the empty case', () => {
    const output = formatStatsTimeline(series([]))

    expect(output).toContain('tokens by day')
    expect(output).toContain('No stats recorded yet.')
  })

  it('defaults to horizontal bars with values inline', () => {
    const output = formatStatsTimeline(
      series([
        bucket('01-10', 1, 2, 200),
        bucket('01-12', 3, 5, 1000),
      ]),
      { columns: 80, metric: 'tokens' },
    )
    const rows = output.split('\n')

    // Horizontal: no vertical axis frame; each bucket is a row with its value.
    expect(output).not.toContain('┼')
    expect(rows.some(line => line.startsWith('01-10') && line.includes('200'))).toBe(true)
    expect(rows.some(line => line.startsWith('01-12') && line.includes('1,000'))).toBe(true)
  })

  it('draws a vertical chart with --vertical', () => {
    const output = formatStatsTimeline(
      series([
        bucket('01-10', 1, 2, 200),
        bucket('01-11', 2, 0, 0),
        bucket('01-12', 3, 5, 1000),
      ]),
      { columns: 80, metric: 'tokens', vertical: true },
    )

    expect(output).toContain('┼')
    expect(output).toContain('┤')
    expect(output).toContain('█')
    expect(output).toContain('01-10')
    expect(output).toContain('01-12')
  })

  it('falls back to horizontal when --vertical does not fit', () => {
    const output = formatStatsTimeline(
      series([
        bucket('01-10', 1, 2, 200),
        bucket('01-11', 2, 3, 900),
        bucket('01-12', 3, 5, 1000),
      ]),
      { columns: 12, metric: 'tokens', vertical: true },
    )

    expect(output).not.toContain('┼')
  })

  it('lists exact per-bucket values under a vertical chart', () => {
    const output = formatStatsTimeline(
      series([
        bucket('01-10', 1, 2, 250),
        bucket('01-11', 2, 0, 0),
        bucket('01-12', 3, 5, 12345),
      ]),
      {
        columns: 80,
        exact: true,
        metric: 'tokens',
        vertical: true,
      },
    )

    // 250 is neither the max nor zero, so it is unreadable from the axis alone —
    // the summary list is what carries it.
    expect(output).toContain('250')
    expect(output).toContain('01-11')
    expect(output).toContain('12,345')
  })

  it('labels the vertical axis with a month row at month boundaries', () => {
    const output = formatStatsTimeline(
      series([
        bucket('06-30', Date.UTC(2026, 5, 30), 2, 200),
        bucket('07-01', Date.UTC(2026, 6, 1), 5, 1000),
      ], 'day'),
      { columns: 80, vertical: true },
    )

    // The month row carries abbreviations that never appear in MM-DD keys.
    expect(output).toContain('Jun')
    expect(output).toContain('Jul')
  })

  it('caps the summary list at four date columns', () => {
    const buckets = Array.from({ length: 10 }, (_, index) =>
      bucket(`01-${String(index + 1).padStart(2, '0')}`, Date.UTC(2026, 0, index + 1), 1, 5))
    const output = formatStatsTimeline(series(buckets, 'day'), { columns: 200, vertical: true })
    const fifthRow = output.split('\n').find(line => line.includes('01-05')) ?? ''

    // With a cap of 4, the fifth date opens a new row, so it never shares a line
    // with the first even though the width could fit far more.
    expect(fifthRow).not.toContain('01-01')
  })

  it('compacts large token counts by default and expands them with exact', () => {
    const big = series([
      bucket('01-10', 1, 2, 1_200_000),
    ])

    expect(formatStatsTimeline(big, { columns: 80, metric: 'tokens' })).toContain('1.20M')
    expect(formatStatsTimeline(big, { columns: 80, exact: true, metric: 'tokens' })).toContain('1,200,000')
  })

  it('plots the chosen metric and labels the caption', () => {
    expect(formatStatsTimeline(series([
      bucket('01-10', 1, 8, 5),
    ], 'week'), { metric: 'runs' }))
      .toContain('runs by week')
  })

  it('shows the rule filter in the caption', () => {
    const output = formatStatsTimeline(series([
      bucket('01-10', 1, 1, 5),
    ]), {
      rules: ['r1', 'r2'],
    })

    expect(output).toContain('tokens by day — r1, r2')
  })
})

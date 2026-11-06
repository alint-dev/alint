import type { RunStatInput } from './types'

import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createJsonlStatsStore } from './jsonl'

function input(cwd: string, overrides: Partial<RunStatInput> = {}): RunStatInput {
  return {
    cwd,
    ruleCounts: {
      cached: 0,
      cancelled: 0,
      completed: 1,
      failed: 0,
      planned: 1,
    },
    usage: {
      inTok: 100,
      outTok: 20,
      records: [
        {
          inTok: 100,
          modelId: 'gpt-4o',
          operation: 'judge',
          outTok: 20,
          providerId: 'openai',
          ruleId: 'r1',
          totalTok: 120,
        },
      ],
      totalTok: 120,
    },
    ...overrides,
  }
}

function statLine(ts: number, cwd: string, overrides: Partial<RunStatInput> = {}): string {
  return `${JSON.stringify({
    ts,
    ...input(cwd, overrides),
  })}\n`
}

function statsFileName(ts: number): string {
  const date = new Date(ts)
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')

  return `stats-${year}-${month}.jsonl`
}

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'alint-stats-'))
}

describe('createJsonlStatsStore', () => {
  it('appends one line per run into the month file', async () => {
    const dir = await tmp()
    const store = createJsonlStatsStore({ dir })

    await store.record(input('/p'))
    await store.record(input('/p'))

    const files = await readdir(dir)
    expect(files).toHaveLength(1)
    const content = await readFile(join(dir, files[0]!), 'utf8')
    expect(content.trim().split('\n')).toHaveLength(2)
  })

  it('reads runs from multiple monthly files', async () => {
    const dir = await tmp()
    const store = createJsonlStatsStore({ dir, retentionMonths: 0 })

    await writeFile(join(dir, 'stats-2026-01.jsonl'), statLine(Date.UTC(2026, 0, 10), '/jan'))
    await writeFile(join(dir, 'stats-2026-02.jsonl'), statLine(Date.UTC(2026, 1, 10), '/feb'))

    const agg = await store.query({ by: 'dir' })

    expect(agg.totalRuns).toBe(2)
    expect(agg.rows.map(row => row.key).sort()).toEqual(['/feb', '/jan'])
  })

  it('prunes files older than retentionMonths on write', async () => {
    const dir = await tmp()
    const currentTs = Date.now()
    const oldTs = new Date(currentTs)
    oldTs.setUTCFullYear(oldTs.getUTCFullYear() - 2)
    const oldFile = statsFileName(oldTs.getTime())
    await writeFile(join(dir, oldFile), statLine(oldTs.getTime(), '/p'))
    const store = createJsonlStatsStore({ dir, retentionMonths: 12 })

    await store.record(input('/p'))

    const files = await readdir(dir)
    expect(files).toHaveLength(1)
    expect(files).not.toContain(oldFile)
  })

  it('aggregates by model with run counts and totals', async () => {
    const dir = await tmp()
    const store = createJsonlStatsStore({ dir })

    await store.record(input('/p'))
    await store.record(input('/p'))
    const agg = await store.query({ by: 'model' })

    expect(agg.dimension).toBe('model')
    expect(agg.totalRuns).toBe(2)
    expect(agg.totalTok).toBe(240)
    expect(agg.rows).toHaveLength(1)
    expect(agg.rows[0].key).toBe('openai/gpt-4o')
    expect(agg.rows[0].runs).toBe(2)
    expect(agg.rows[0].totalTok).toBe(240)
  })

  it('falls back to rule id when grouping by operation on untagged records', async () => {
    const dir = await tmp()
    const store = createJsonlStatsStore({ dir })

    await store.record(input('/p', {
      usage: {
        inTok: 10,
        outTok: 2,
        records: [
          {
            inTok: 10,
            modelId: 'm',
            outTok: 2,
            providerId: 'openai',
            ruleId: 'r9',
            totalTok: 12,
          },
        ],
        totalTok: 12,
      },
    }))
    const agg = await store.query({ by: 'operation' })

    expect(agg.rows[0].key).toBe('r9')
  })

  it('filters by cwd and since', async () => {
    const dir = await tmp()
    const store = createJsonlStatsStore({ dir, retentionMonths: 0 })

    await writeFile(join(dir, 'stats-2026-01.jsonl'), [
      statLine(Date.UTC(2026, 0, 1), '/a'),
      statLine(Date.UTC(2026, 0, 20), '/b'),
    ].join(''))

    const byDir = await store.query({ by: 'dir', cwd: '/b' })
    expect(byDir.totalRuns).toBe(1)
    expect(byDir.rows[0].key).toBe('/b')

    const recent = await store.query({ since: '2026-01-15' })
    expect(recent.totalRuns).toBe(1)
  })

  it('returns an empty aggregate when the dir does not exist', async () => {
    const dir = join(await tmp(), 'nope')
    const store = createJsonlStatsStore({ dir })

    const agg = await store.query()

    expect(agg.totalRuns).toBe(0)
    expect(agg.rows).toEqual([])
  })

  it('filters the table by rule', async () => {
    const dir = await tmp()
    const store = createJsonlStatsStore({ dir })

    await store.record(input('/p', {
      usage: {
        inTok: 30,
        outTok: 6,
        records: [
          {
            inTok: 20,
            modelId: 'm',
            outTok: 4,
            providerId: 'openai',
            ruleId: 'r1',
            totalTok: 24,
          },
          {
            inTok: 10,
            modelId: 'm',
            outTok: 2,
            providerId: 'openai',
            ruleId: 'r2',
            totalTok: 12,
          },
        ],
        totalTok: 36,
      },
    }))
    const agg = await store.query({
      by: 'rule',
      rules: ['r1'],
    })

    expect(agg.rows.map(row => row.key)).toEqual(['r1'])
    expect(agg.totalTok).toBe(24)
    expect(agg.totalRuns).toBe(1)
  })

  it('buckets series runs by day and fills empty days', async () => {
    const dir = await tmp()
    const store = createJsonlStatsStore({ dir, retentionMonths: 0 })

    await writeFile(join(dir, 'stats-2026-01.jsonl'), [
      statLine(Date.UTC(2026, 0, 10), '/p'),
      statLine(Date.UTC(2026, 0, 10), '/p'),
      statLine(Date.UTC(2026, 0, 12), '/p'),
    ].join(''))
    const result = await store.querySeries({ interval: 'day' })

    expect(result.interval).toBe('day')
    expect(result.buckets.map(item => item.key)).toEqual(['01-10', '01-11', '01-12'])
    expect(result.buckets[0].runs).toBe(2)
    expect(result.buckets[1].runs).toBe(0)
    expect(result.buckets[2].runs).toBe(1)
    expect(result.totalRuns).toBe(3)
  })

  it('buckets series by week starting Monday', async () => {
    const dir = await tmp()
    const store = createJsonlStatsStore({ dir, retentionMonths: 0 })

    await writeFile(join(dir, 'stats-2026-01.jsonl'), [
      statLine(Date.UTC(2026, 0, 7), '/p'), // Wednesday -> week of Mon 01-05
      statLine(Date.UTC(2026, 0, 14), '/p'), // Wednesday -> week of Mon 01-12
    ].join(''))
    const result = await store.querySeries({ interval: 'week' })

    expect(result.buckets.map(item => item.key)).toEqual(['01-05', '01-12'])
    expect(result.buckets[0].runs).toBe(1)
    expect(result.buckets[1].runs).toBe(1)
  })

  it('buckets series by month across an empty month', async () => {
    const dir = await tmp()
    const store = createJsonlStatsStore({ dir, retentionMonths: 0 })

    await writeFile(join(dir, 'stats-2026-01.jsonl'), statLine(Date.UTC(2026, 0, 15), '/p'))
    await writeFile(join(dir, 'stats-2026-03.jsonl'), statLine(Date.UTC(2026, 2, 5), '/p'))
    const result = await store.querySeries({ interval: 'month' })

    expect(result.buckets.map(item => item.key)).toEqual(['Jan', 'Feb', 'Mar'])
    expect(result.buckets[1].runs).toBe(0)
  })

  it('auto-selects a day interval for a short range', async () => {
    const dir = await tmp()
    const store = createJsonlStatsStore({ dir, retentionMonths: 0 })

    await writeFile(join(dir, 'stats-2026-01.jsonl'), [
      statLine(Date.UTC(2026, 0, 1), '/p'),
      statLine(Date.UTC(2026, 0, 4), '/p'),
    ].join(''))

    expect((await store.querySeries({})).interval).toBe('day')
  })

  it('derives the auto interval from the --since window regardless of data spread', async () => {
    const dir = await tmp()
    const store = createJsonlStatsStore({ dir })

    // A single run "now" sits inside every window below; the window length, not
    // the (zero) data spread, decides the bucket.
    await store.record(input('/p'))

    expect((await store.querySeries({ since: '24h' })).interval).toBe('day')
    expect((await store.querySeries({ since: '7d' })).interval).toBe('day')
    expect((await store.querySeries({ since: '30d' })).interval).toBe('week')
    expect((await store.querySeries({ since: '200d' })).interval).toBe('month')
  })

  it('lets an explicit interval override the window', async () => {
    const dir = await tmp()
    const store = createJsonlStatsStore({ dir })

    await store.record(input('/p'))

    expect((await store.querySeries({ interval: 'week', since: '24h' })).interval).toBe('week')
  })

  it('filters series buckets by rule', async () => {
    const dir = await tmp()
    const store = createJsonlStatsStore({ dir, retentionMonths: 0 })

    await writeFile(join(dir, 'stats-2026-01.jsonl'), statLine(Date.UTC(2026, 0, 10), '/p', {
      usage: {
        inTok: 30,
        outTok: 6,
        records: [
          {
            inTok: 20,
            modelId: 'm',
            outTok: 4,
            providerId: 'openai',
            ruleId: 'r1',
            totalTok: 24,
          },
          {
            inTok: 10,
            modelId: 'm',
            outTok: 2,
            providerId: 'openai',
            ruleId: 'r2',
            totalTok: 12,
          },
        ],
        totalTok: 36,
      },
    }))
    const all = await store.querySeries({ interval: 'day' })
    const onlyR1 = await store.querySeries({
      interval: 'day',
      rules: ['r1'],
    })

    expect(all.totalTok).toBe(36)
    expect(onlyR1.totalTok).toBe(24)
    expect(onlyR1.buckets[0].totalTok).toBe(24)
  })

  it('returns an empty series when the dir does not exist', async () => {
    const dir = join(await tmp(), 'nope')

    const result = await createJsonlStatsStore({ dir }).querySeries()

    expect(result.buckets).toEqual([])
    expect(result.totalRuns).toBe(0)
  })
})

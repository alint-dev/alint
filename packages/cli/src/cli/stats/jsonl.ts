import type {
  RunStat,
  RunStatInput,
  StatsAggregate,
  StatsBucket,
  StatsDimension,
  StatsGroupRow,
  StatsInterval,
  StatsQuery,
  StatsSeries,
  StatsSeriesQuery,
  StatsStore,
  StatsUsageRecord,
} from './types'

import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises'

import { join } from 'pathe'

import { parseSince } from './since'

const DEFAULT_RETENTION_MONTHS = 12
const STATS_FILE_PATTERN = /^stats-(\d{4})-(\d{2})\.jsonl$/u
const DAY_MS = 86_400_000
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

export interface JsonlStatsStoreOptions {
  dir: string
  retentionMonths?: number
}

interface RunSlice {
  inTok: number
  outTok: number
  totalTok: number
  touched: boolean
  usageRecords: StatsUsageRecord[]
}

// JSONL-backed stats store: one line per run in monthly-rotated files under `options.dir`.
export function createJsonlStatsStore(options: JsonlStatsStoreOptions): StatsStore {
  const retentionMonths = options.retentionMonths ?? DEFAULT_RETENTION_MONTHS

  return {
    query: filter => query(options.dir, filter ?? {}, Date.now),
    querySeries: filter => querySeries(options.dir, filter ?? {}, Date.now),
    record: input => record(options.dir, input, Date.now(), retentionMonths),
  }
}

function accumulate(
  rows: Map<string, StatsGroupRow>,
  key: string,
  inTok: number,
  outTok: number,
  totalTok: number,
  countRun: boolean,
): StatsGroupRow {
  const row = rows.get(key) ?? {
    inTok: 0,
    key,
    outTok: 0,
    runs: 0,
    totalTok: 0,
  }

  row.inTok += inTok
  row.outTok += outTok
  row.totalTok += totalTok

  if (countRun) {
    row.runs += 1
  }

  rows.set(key, row)

  return row
}

function bucketLabel(startMs: number, interval: StatsInterval): string {
  const date = new Date(startMs)

  if (interval === 'month') {
    return MONTH_LABELS[date.getUTCMonth()]!
  }

  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')

  return `${month}-${day}`
}

function bucketStart(ts: number, interval: StatsInterval): number {
  const date = new Date(ts)

  if (interval === 'month') {
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
  }

  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())

  if (interval === 'week') {
    // Shift back to the UTC Monday opening the week (getUTCDay: 0 = Sunday).
    const backToMonday = (new Date(dayStart).getUTCDay() + 6) % 7

    return dayStart - backToMonday * DAY_MS
  }

  return dayStart
}

// Auto-select the bucket.
//
// When `--since` sets a window, the window's length drives the granularity
// (7d → day, ~1mo → week, longer → month), matching how observability dashboards
// pick a resolution from the selected range. With no lower bound, fall back to
// the spread of the data that actually exists.
function chooseInterval(since: number | undefined, nowMs: number, timestamps: number[]): StatsInterval {
  if (since !== undefined) {
    return intervalForDuration(nowMs - since)
  }

  if (timestamps.length < 2) {
    return 'day'
  }

  return intervalForDuration(Math.max(...timestamps) - Math.min(...timestamps))
}

function fillBuckets(buckets: Map<number, StatsBucket>, interval: StatsInterval): StatsBucket[] {
  if (buckets.size === 0) {
    return []
  }

  const starts = [
    ...buckets.keys(),
  ].sort((left, right) => left - right)
  const last = starts.at(-1)!
  const filled: StatsBucket[] = []

  for (let startMs = starts[0]!; startMs <= last; startMs = nextBucketStart(startMs, interval)) {
    filled.push(buckets.get(startMs)
      ?? {
        inTok: 0,
        key: bucketLabel(startMs, interval),
        outTok: 0,
        runs: 0,
        startMs,
        totalTok: 0,
      })
  }

  return filled
}

function intervalForDuration(ms: number): StatsInterval {
  const days = ms / DAY_MS

  if (days <= 21) {
    return 'day'
  }

  if (days <= 120) {
    return 'week'
  }

  return 'month'
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function monthIndexOf(ts: number): number {
  const date = new Date(ts)

  return date.getUTCFullYear() * 12 + date.getUTCMonth()
}

function nextBucketStart(startMs: number, interval: StatsInterval): number {
  if (interval === 'month') {
    const date = new Date(startMs)

    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
  }

  return startMs + (interval === 'week'
    ? 7 * DAY_MS
    : DAY_MS)
}

function parseRunLine(line: string): RunStat | undefined {
  try {
    const value = JSON.parse(line) as Partial<RunStat>

    // Skip any records not shaped like a run.
    if (typeof value.ts === 'number' && typeof value.cwd === 'string' && value.usage != null) {
      return value as RunStat
    }

    return undefined
  }
  catch {
    return undefined
  }
}

async function prune(dir: string, ts: number, retentionMonths: number): Promise<void> {
  if (retentionMonths <= 0) {
    return
  }

  // Keep the newest `retentionMonths` months inclusive and drop files strictly older.
  const cutoff = monthIndexOf(ts) - (retentionMonths - 1)
  const files = await statsFiles(dir)

  for (const { month, name } of files) {
    if (month < cutoff) {
      await rm(join(dir, name))
    }
  }
}

async function query(dir: string, filter: StatsQuery, now: () => number): Promise<StatsAggregate> {
  const dimension: StatsDimension = filter.by ?? 'model'
  const since = parseSince(filter.since, now())
  const rules = ruleSet(filter.rules)
  const runs = await readRuns(dir)
  const rows = new Map<string, StatsGroupRow>()
  let totalRuns = 0
  let totalIn = 0
  let totalOut = 0
  let totalTok = 0

  for (const run of runs) {
    if (!runInWindow(run, since, filter.cwd)) {
      continue
    }

    const slice = sliceRun(run, rules)

    // A rule filter that matches nothing in this run drops it entirely.
    if (!slice.touched) {
      continue
    }

    totalRuns += 1
    totalIn += slice.inTok
    totalOut += slice.outTok
    totalTok += slice.totalTok

    if (dimension === 'dir') {
      accumulate(rows, run.cwd, slice.inTok, slice.outTok, slice.totalTok, true)
      continue
    }

    const seenKeys = new Set<string>()

    for (const usageRecord of slice.usageRecords) {
      const key = recordKey(usageRecord, dimension)

      accumulate(rows, key, usageRecord.inTok, usageRecord.outTok, usageRecord.totalTok, !seenKeys.has(key))
      seenKeys.add(key)
    }
  }

  return {
    dimension,
    rows: [
      ...rows.values(),
    ].sort((left, right) => right.totalTok - left.totalTok),
    totalIn,
    totalOut,
    totalRuns,
    totalTok,
  }
}

async function querySeries(dir: string, filter: StatsSeriesQuery, now: () => number): Promise<StatsSeries> {
  const nowMs = now()
  const since = parseSince(filter.since, nowMs)
  const rules = ruleSet(filter.rules)
  const runs = await readRuns(dir)
  const sliced: Array<{ slice: RunSlice, ts: number }> = []

  for (const run of runs) {
    if (!runInWindow(run, since, filter.cwd)) {
      continue
    }

    const slice = sliceRun(run, rules)

    if (slice.touched) {
      sliced.push({ slice, ts: run.ts })
    }
  }

  const interval = filter.interval ?? chooseInterval(since, nowMs, sliced.map(entry => entry.ts))
  const buckets = new Map<number, StatsBucket>()
  let totalRuns = 0
  let totalIn = 0
  let totalOut = 0
  let totalTok = 0

  for (const { slice, ts } of sliced) {
    const startMs = bucketStart(ts, interval)
    const bucket = buckets.get(startMs)
      ?? {
        inTok: 0,
        key: bucketLabel(startMs, interval),
        outTok: 0,
        runs: 0,
        startMs,
        totalTok: 0,
      }

    bucket.runs += 1
    bucket.inTok += slice.inTok
    bucket.outTok += slice.outTok
    bucket.totalTok += slice.totalTok
    buckets.set(startMs, bucket)

    totalRuns += 1
    totalIn += slice.inTok
    totalOut += slice.outTok
    totalTok += slice.totalTok
  }

  return {
    buckets: fillBuckets(buckets, interval),
    interval,
    totalIn,
    totalOut,
    totalRuns,
    totalTok,
  }
}

async function readRuns(dir: string): Promise<RunStat[]> {
  const files = await statsFiles(dir)
  const runs: RunStat[] = []

  for (const { name } of files) {
    const content = await readFile(join(dir, name), 'utf8')

    for (const line of content.split('\n')) {
      if (line.trim() === '') {
        continue
      }

      const run = parseRunLine(line)

      if (run) {
        runs.push(run)
      }
    }
  }

  return runs
}

async function record(dir: string, input: RunStatInput, ts: number, retentionMonths: number): Promise<void> {
  const stat: RunStat = { ts, ...input }

  await mkdir(dir, { recursive: true })
  await appendFile(join(dir, statsFileName(ts)), `${JSON.stringify(stat)}\n`, 'utf8')
  await prune(dir, ts, retentionMonths)
}

function recordKey(record: StatsUsageRecord, dimension: StatsDimension): string {
  if (dimension === 'rule') {
    return record.ruleId
  }

  if (dimension === 'operation') {
    return record.operation ?? record.ruleId
  }

  return `${record.providerId}/${record.modelId}`
}

function ruleSet(rules: string[] | undefined): Set<string> | undefined {
  return rules && rules.length > 0
    ? new Set(rules)
    : undefined
}

function runInWindow(run: RunStat, since: number | undefined, cwd: string | undefined): boolean {
  return (since === undefined || run.ts >= since) && (cwd === undefined || run.cwd === cwd)
}

// Reduce a run to the part matching `rules`; with no filter it is the whole run.
function sliceRun(run: RunStat, rules: Set<string> | undefined): RunSlice {
  if (rules === undefined) {
    return {
      inTok: run.usage.inTok,
      outTok: run.usage.outTok,
      totalTok: run.usage.totalTok,
      touched: true,
      usageRecords: run.usage.records,
    }
  }

  const usageRecords = run.usage.records.filter(record => rules.has(record.ruleId))

  return {
    inTok: sumBy(usageRecords, record => record.inTok),
    outTok: sumBy(usageRecords, record => record.outTok),
    totalTok: sumBy(usageRecords, record => record.totalTok),
    touched: usageRecords.length > 0,
    usageRecords,
  }
}

function statsFileName(ts: number): string {
  const date = new Date(ts)
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')

  return `stats-${year}-${month}.jsonl`
}

async function statsFiles(dir: string): Promise<Array<{ month: number, name: string }>> {
  let entries: string[]

  try {
    entries = await readdir(dir)
  }
  catch (error) {
    if (isEnoent(error)) {
      return []
    }

    throw error
  }

  return entries
    .map((name) => {
      const match = STATS_FILE_PATTERN.exec(name)

      return match
        ? { month: Number(match[1]) * 12 + (Number(match[2]) - 1), name }
        : undefined
    })
    .filter((entry): entry is { month: number, name: string } => entry !== undefined)
    .sort((left, right) => left.month - right.month)
}

function sumBy<T>(items: T[], select: (item: T) => number): number {
  let total = 0

  for (const item of items) {
    total += select(item)
  }

  return total
}

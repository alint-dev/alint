import type { CliIo } from '../../types'

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { executeCli } from '../../cli'

interface TestIo extends CliIo {
  stderrText: string
  stdoutText: string
}

async function seedStats(): Promise<{ cwd: string, io: TestIo }> {
  const cwd = await mkdtemp(join(tmpdir(), 'alint-stats-cwd-'))
  const configHome = await mkdtemp(join(tmpdir(), 'alint-stats-home-'))
  const statsDir = join(configHome, 'alint', 'stats')

  await mkdir(statsDir, { recursive: true })

  const run = {
    cwd,
    ruleCounts: {
      cached: 0,
      cancelled: 0,
      completed: 1,
      failed: 0,
      planned: 1,
    },
    ts: Date.UTC(2026, 0, 10),
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
  }

  await writeFile(join(statsDir, 'stats-2026-01.jsonl'), `${JSON.stringify(run)}\n`)

  const io: TestIo = {
    cwd,
    env: { XDG_CONFIG_HOME: configHome },
    stderr: {
      write: (chunk: string) => void (io.stderrText += chunk),
    },
    stderrText: '',
    stdout: {
      write: (chunk: string) => void (io.stdoutText += chunk),
    },
    stdoutText: '',
  }

  return { cwd, io }
}

describe('alint stats command', () => {
  it('aggregates seeded runs by model as JSON', async () => {
    const { io } = await seedStats()

    const code = await executeCli(['node', 'alint', 'stats', '--json'], io)

    expect(code).toBe(0)
    const output = JSON.parse(io.stdoutText)
    expect(output.dimension).toBe('model')
    expect(output.totalRuns).toBe(1)
    expect(output.totalTok).toBe(120)
    expect(output.rows[0].key).toBe('openai/gpt-4o')
  })

  it('groups by operation', async () => {
    const { io } = await seedStats()

    const code = await executeCli([
      'node',
      'alint',
      'stats',
      '--by',
      'operation',
      '--json',
    ], io)

    expect(code).toBe(0)
    const output = JSON.parse(io.stdoutText)
    expect(output.dimension).toBe('operation')
    expect(output.rows[0].key).toBe('judge')
  })

  it('reports an invalid --by dimension', async () => {
    const { io } = await seedStats()

    const code = await executeCli([
      'node',
      'alint',
      'stats',
      '--by',
      'bogus',
    ], io)

    expect(code).toBe(2)
    expect(io.stderrText).toContain('Invalid --by "bogus"')
  })

  it('renders a horizontal usage timeline with --chart', async () => {
    const { io } = await seedStats()

    const code = await executeCli(['node', 'alint', 'stats', '--chart'], io)

    expect(code).toBe(0)
    expect(io.stdoutText).toContain('tokens by day')
    // The seeded run lands on 2026-01-10.
    expect(io.stdoutText).toContain('01-10')
    expect(io.stdoutText).toContain('█')
    // Horizontal is the default: no vertical axis frame.
    expect(io.stdoutText).not.toContain('┼')
  })

  it('draws vertical bars with --chart --vertical', async () => {
    const { io } = await seedStats()

    const code = await executeCli([
      'node',
      'alint',
      'stats',
      '--chart',
      '--vertical',
    ], io)

    expect(code).toBe(0)
    expect(io.stdoutText).toContain('┼')
  })

  it('lists the flags in stats help', async () => {
    const { io } = await seedStats()

    const code = await executeCli(['node', 'alint', 'stats', '--help'], io)

    expect(code).toBe(0)
    expect(io.stdoutText).toContain('Options:')
    expect(io.stdoutText).toContain('--chart')
    expect(io.stdoutText).toContain('--by')
    expect(io.stdoutText).toContain('--exact-numbers')
  })

  it('dumps the series as JSON with --chart --json', async () => {
    const { io } = await seedStats()

    const code = await executeCli([
      'node',
      'alint',
      'stats',
      '--chart',
      '--json',
    ], io)

    expect(code).toBe(0)
    expect(io.stdoutText).not.toContain('█')
    const output = JSON.parse(io.stdoutText)
    expect(output.interval).toBe('day')
    expect(output.buckets).toHaveLength(1)
    expect(output.buckets[0].runs).toBe(1)
  })

  it('honors --interval for the chart bucket', async () => {
    const { io } = await seedStats()

    const code = await executeCli([
      'node',
      'alint',
      'stats',
      '--chart',
      '--interval',
      'month',
      '--json',
    ], io)

    expect(code).toBe(0)
    const output = JSON.parse(io.stdoutText)
    expect(output.interval).toBe('month')
    expect(output.buckets[0].key).toBe('Jan')
  })

  it('filters the chart by rule', async () => {
    const present = await seedStats()
    const kept = await executeCli([
      'node',
      'alint',
      'stats',
      '--chart',
      '--rule',
      'r1',
      '--json',
    ], present.io)

    expect(kept).toBe(0)
    expect(JSON.parse(present.io.stdoutText).totalTok).toBe(120)

    const absent = await seedStats()
    await executeCli([
      'node',
      'alint',
      'stats',
      '--chart',
      '--rule',
      'nope',
      '--json',
    ], absent.io)

    expect(JSON.parse(absent.io.stdoutText).buckets).toHaveLength(0)
  })

  it('reports an invalid --interval', async () => {
    const { io } = await seedStats()

    const code = await executeCli([
      'node',
      'alint',
      'stats',
      '--chart',
      '--interval',
      'bogus',
    ], io)

    expect(code).toBe(2)
    expect(io.stderrText).toContain('Invalid --interval "bogus"')
  })

  it('reports an invalid --metric', async () => {
    const { io } = await seedStats()

    const code = await executeCli([
      'node',
      'alint',
      'stats',
      '--metric',
      'bogus',
    ], io)

    expect(code).toBe(2)
    expect(io.stderrText).toContain('Invalid --metric "bogus"')
  })
})

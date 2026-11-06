import type { RunUsage } from '@alint-js/core'

import { describe, expect, it } from 'vitest'

import { createRunStat } from './record'

describe('createRunStat', () => {
  it('maps run usage and pulls operation out of metadata', () => {
    const usage: RunUsage = {
      inputTokens: 150,
      outputTokens: 30,
      records: [
        {
          filePath: 'a.ts',
          inputTokens: 100,
          metadata: { operation: 'judge' },
          modelId: 'gpt-4o',
          outputTokens: 20,
          providerId: 'openai',
          ruleId: 'r1',
          totalTokens: 120,
        },
        {
          inputTokens: 50,
          modelId: 'gpt-4o',
          outputTokens: 10,
          providerId: 'openai',
          ruleId: 'r1',
          totalTokens: 60,
        },
      ],
      totalTokens: 180,
    }

    const stat = createRunStat({
      cwd: '/p',
      durationMs: 42,
      ruleCounts: {
        cached: 0,
        cancelled: 0,
        completed: 1,
        failed: 0,
        planned: 1,
      },
      usage,
    })

    expect(stat.cwd).toBe('/p')
    expect(stat.durationMs).toBe(42)
    expect(stat.usage.inTok).toBe(150)
    expect(stat.usage.outTok).toBe(30)
    expect(stat.usage.totalTok).toBe(180)
    expect(stat.usage.records[0].operation).toBe('judge')
    expect(stat.usage.records[0].filePath).toBe('a.ts')
    expect(stat.usage.records[0].inTok).toBe(100)
    expect(stat.usage.records[1].operation).toBeUndefined()
    expect(stat.usage.records[1].inTok).toBe(50)
  })

  it('defaults missing token fields to zero', () => {
    const usage: RunUsage = {
      inputTokens: 0,
      outputTokens: 0,
      records: [
        { modelId: 'm', providerId: 'p', ruleId: 'r' },
      ],
      totalTokens: 0,
    }

    const stat = createRunStat({
      cwd: '/p',
      ruleCounts: {
        cached: 0,
        cancelled: 0,
        completed: 0,
        failed: 0,
        planned: 0,
      },
      usage,
    })

    expect(stat.usage.records[0].inTok).toBe(0)
    expect(stat.usage.records[0].outTok).toBe(0)
    expect(stat.usage.records[0].totalTok).toBe(0)
  })
})

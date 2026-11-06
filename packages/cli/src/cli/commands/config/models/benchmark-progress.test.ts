import { afterEach, describe, expect, it, vi } from 'vitest'

import { createModelBenchmarkProgressDisplay } from './benchmark-progress'

afterEach(() => {
  vi.useRealTimers()
})

describe('createModelBenchmarkProgressDisplay', () => {
  it('keeps warm-up static and patches only the active speed suffix for measured samples', () => {
    vi.useFakeTimers()
    const chunks: string[] = []
    const display = createModelBenchmarkProgressDisplay({
      color: false,
      config: {
        providers: [
          {
            endpoint: 'https://example.test/v1',
            id: 'remote',
            models: [
              { id: 'model' },
            ],
            type: 'openai-compatible',
          },
        ],
        version: 1,
      },
      output: {
        isTTY: true,
        rows: 8,
        write: chunk => chunks.push(chunk),
      },
    })

    display.update({
      active: [
        {
          modelId: 'model',
          modelIndex: 0,
          phase: 'repeat',
          providerId: 'remote',
          sample: 0,
          samples: 3,
          success: { attempted: 1, completed: 0 },
          warmup: true,
        },
      ],
      modelsTotal: 1,
      results: [],
    })

    expect(chunks.join('')).toContain('warm-up')
    expect(chunks.join('')).toContain('0/1 models complete')

    const warmupWrites = chunks.length
    vi.advanceTimersByTime(160)
    expect(chunks).toHaveLength(warmupWrites)

    display.update({
      active: [
        {
          modelId: 'model',
          modelIndex: 0,
          phase: 'repeat',
          providerId: 'remote',
          sample: 1,
          samples: 3,
          success: { attempted: 2, completed: 1 },
          warmup: false,
        },
      ],
      modelsTotal: 1,
      results: [],
    })

    const samplePatch = chunks.at(-1) ?? ''
    expect(samplePatch).toContain('\u001B[K')
    expect(samplePatch).toContain('1/3')
    expect(samplePatch).not.toContain('model')
    expect(samplePatch).not.toContain('provider')

    const sampleWrites = chunks.length
    vi.advanceTimersByTime(160)
    expect(chunks.length).toBeGreaterThan(sampleWrites)
    expect(chunks.slice(sampleWrites).every(chunk => !chunk.includes('model'))).toBe(true)

    display.finish()
    expect(chunks.at(-1)).toContain('\r\u001B[K')
  })
})

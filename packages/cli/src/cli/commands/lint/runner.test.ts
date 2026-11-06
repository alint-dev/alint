import { describe, expect, it } from 'vitest'

import { resolveRunnerConfig } from './runner'

describe('resolveRunnerConfig', () => {
  it('puts CLI flags above the project runner', () => {
    expect(resolveRunnerConfig(
      { ruleConcurrency: 4, timeoutMs: 200 },
      { format: 'stylish', ruleConcurrency: '6' },
    )).toEqual({ ruleConcurrency: 6, timeoutMs: 200 })
  })

  it('keeps the project runner when no flag overrides it', () => {
    expect(resolveRunnerConfig(
      { ruleConcurrency: 2, timeoutMs: 100 },
      { format: 'stylish' },
    )).toEqual({ ruleConcurrency: 2, timeoutMs: 100 })
  })

  it('resolves to undefined when nothing configures a runner', () => {
    expect(resolveRunnerConfig(undefined, { format: 'stylish' })).toBeUndefined()
  })

  it('treats --no-cache as a hard off-switch', () => {
    expect(resolveRunnerConfig(
      {
        cache: { location: '.alintcache' },
      },
      { cache: false, format: 'stylish' },
    )?.cache).toBe(false)
  })

  it('layers --cache-location onto the project cache config', () => {
    expect(resolveRunnerConfig(
      {
        cache: { enabled: true, location: '.alintcache' },
      },
      { cacheLocation: '/tmp/alint', format: 'stylish' },
    )?.cache).toEqual({ enabled: true, location: '/tmp/alint' })
  })

  it('treats --no-stats as a hard off-switch', () => {
    expect(resolveRunnerConfig(
      {
        stats: { location: '/stats' },
      },
      { format: 'stylish', stats: false },
    )?.stats).toBe(false)
  })

  it('validates concurrency and timeout runner options as positive integers', () => {
    expect(() => resolveRunnerConfig(
      undefined,
      { format: 'stylish', ruleConcurrency: '0' },
    )).toThrow('--rule-concurrency must be a positive integer.')

    expect(() => resolveRunnerConfig(
      undefined,
      { format: 'stylish', timeoutMs: '1.5' },
    )).toThrow('--timeout-ms must be a positive integer.')
  })
})

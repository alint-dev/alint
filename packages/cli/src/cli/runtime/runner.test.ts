import { describe, expect, it } from 'vitest'

import { mergeRunnerConfigs, resolveConfigRunner } from './runner'

describe('mergeRunnerConfigs', () => {
  it('lets project config override setup agent retries', () => {
    expect(mergeRunnerConfigs({ agentRetries: 1 }, { agentRetries: 4 })?.agentRetries).toBe(4)
  })

  it('preserves zero agent retries from project config', () => {
    expect(mergeRunnerConfigs({ agentRetries: 1 }, { agentRetries: 0 })?.agentRetries).toBe(0)
  })

  it('lets project config override setup concurrency and timeout', () => {
    expect(mergeRunnerConfigs(
      { ruleConcurrency: 2, timeoutMs: 100 },
      { ruleConcurrency: 4, timeoutMs: 200 },
    )).toEqual({
      cache: undefined,
      ruleConcurrency: 4,
      stats: undefined,
      timeoutMs: 200,
    })
  })

  it('merges the cache object instead of replacing it', () => {
    // The cache location decides which file a run reads, so a project that only overrides
    // `enabled` must keep the setup file's location.
    expect(mergeRunnerConfigs(
      {
        cache: { enabled: true, location: '.alintcache' },
      },
      {
        cache: { enabled: false },
      },
    )?.cache).toEqual({ enabled: false, location: '.alintcache' })
  })

  it('lets a boolean cache switch replace the object form', () => {
    expect(mergeRunnerConfigs({
      cache: { location: '.alintcache' },
    }, { cache: false })?.cache).toBe(false)
  })

  it('keeps the setup value when project config says nothing', () => {
    expect(mergeRunnerConfigs({ ruleConcurrency: 2, timeoutMs: 100 }, undefined)).toEqual({
      cache: undefined,
      ruleConcurrency: 2,
      stats: undefined,
      timeoutMs: 100,
    })
  })

  it('resolves to undefined when neither side configures a runner', () => {
    expect(mergeRunnerConfigs(undefined, undefined)).toBeUndefined()
  })
})

describe('resolveConfigRunner', () => {
  it('lets the last runner block win key by key', () => {
    expect(resolveConfigRunner([
      {
        runner: { ruleConcurrency: 2, timeoutMs: 100 },
      },
      {
        runner: { timeoutMs: 200 },
      },
    ])).toEqual({ ruleConcurrency: 2, timeoutMs: 200 })
  })

  it('resolves to undefined when no config item declares a runner', () => {
    expect(resolveConfigRunner([
      {
        files: ['**/*.ts'],
      },
    ])).toBeUndefined()
  })
})

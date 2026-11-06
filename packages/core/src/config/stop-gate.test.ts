import { describe, expect, it } from 'vitest'

import { defaultStopGateConfig, maximumStopGateTimeoutMs, resolveStopGateConfig } from './stop-gate'

describe('stop gate config', () => {
  it('uses repository defaults without explicit overrides', () => {
    expect(resolveStopGateConfig([], '/repo')).toEqual(defaultStopGateConfig)
  })

  it('merges explicit global fields in flat config order', () => {
    expect(resolveStopGateConfig([
      {
        integrations: {
          stopGate: { enabled: true },
        },
      },
      {
        integrations: {
          stopGate: { target: 'all' },
        },
      },
      {
        integrations: {
          stopGate: { timeoutMs: 30_000 },
        },
      },
      {
        integrations: {
          stopGate: { target: 'dirty-files' },
        },
      },
    ], '/repo')).toEqual({
      enabled: true,
      target: 'dirty-files',
      timeoutMs: 30_000,
    })
  })

  it('requires an explicit repository activation', () => {
    expect(resolveStopGateConfig([
      {
        integrations: {
          stopGate: { target: 'all', timeoutMs: 30_000 },
        },
      },
    ], '/repo')).toEqual({
      enabled: false,
      target: 'all',
      timeoutMs: 30_000,
    })
  })

  it('rejects a non-boolean activation value', () => {
    expect(() => resolveStopGateConfig([
      {
        integrations: {
          stopGate: { enabled: 'yes' as never },
        },
      },
    ], '/repo')).toThrow('integrations.stopGate.enabled must be a boolean.')
  })

  it('rejects stop gate config from a scoped item', () => {
    expect(() => resolveStopGateConfig([
      {
        files: ['src/**'],
        integrations: {
          stopGate: { target: 'all' },
        },
      },
    ], '/repo')).toThrow(
      'integrations.stopGate must be declared in a global config item without files, directories, or ignores.',
    )
  })

  it.each([0, maximumStopGateTimeoutMs + 1])('rejects executable timeout %s at runtime', (timeoutMs) => {
    expect(() => resolveStopGateConfig([
      {
        integrations: {
          stopGate: { timeoutMs },
        },
      },
    ], '/repo')).toThrow(`integrations.stopGate.timeoutMs must be an integer from 1 to ${maximumStopGateTimeoutMs}.`)
  })

  it('accepts the maximum executable timeout', () => {
    expect(resolveStopGateConfig([
      {
        integrations: {
          stopGate: { timeoutMs: maximumStopGateTimeoutMs },
        },
      },
    ], '/repo').timeoutMs).toBe(maximumStopGateTimeoutMs)
  })
})

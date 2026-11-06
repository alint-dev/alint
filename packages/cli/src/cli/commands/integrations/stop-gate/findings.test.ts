import type { Diagnostic } from '@alint-js/core'

import { describe, expect, it } from 'vitest'

import { fingerprintDiagnostics } from './findings'

describe('stop gate findings fingerprint', () => {
  it('ignores diagnostic order and execution metadata', () => {
    const first = diagnostic({
      cached: false,
      evidence: { reason: 'first' },
      message: 'First finding',
      model: { providerId: 'provider-a', resolvedId: 'model-a' },
    })
    const second = diagnostic({
      filePath: 'second.ts',
      message: 'Second finding',
      severity: 'warn',
    })

    expect(fingerprintDiagnostics([first, second])).toBe(fingerprintDiagnostics([
      { ...second, cached: true },
      {
        ...first,
        cached: true,
        model: { providerId: 'provider-b', requested: 'large', resolvedId: 'model-b' },
      },
    ]))
  })

  it('includes semantic diagnostic fields and evidence', () => {
    const base = diagnostic()
    const fingerprint = fingerprintDiagnostics([base])
    const changes: Diagnostic[] = [
      {
        ...base,
        evidence: { reason: 'different' },
      },
      { ...base, filePath: 'different.ts' },
      {
        ...base,
        loc: {
          start: { column: 2, line: 1 },
        },
      },
      { ...base, message: 'Different finding' },
      { ...base, ruleId: 'test/different' },
      { ...base, severity: 'warn' },
    ]

    for (const changed of changes) {
      expect(fingerprintDiagnostics([changed])).not.toBe(fingerprint)
    }
  })

  it('preserves duplicate diagnostics', () => {
    const finding = diagnostic()

    expect(fingerprintDiagnostics([finding, finding])).not.toBe(fingerprintDiagnostics([finding]))
  })
})

function diagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    filePath: 'input.ts',
    loc: {
      end: { column: 4, line: 1 },
      start: { column: 1, line: 1 },
    },
    message: 'Test finding',
    ruleId: 'test/finding',
    severity: 'error',
    ...overrides,
  }
}

import { describe, expect, it } from 'vitest'

import { acceptedVerificationDecisions } from './verifier'

describe('acceptedVerificationDecisions', () => {
  it('accepts only direct references with no semantic boundary and safe substitution', () => {
    const base = {
      confidence: 'high' as const,
      initializer: 'identifier' as const,
      line: 1,
      message: 'decision',
      safeSubstitution: true,
      suggestion: 'Use the source directly.',
    }

    expect(acceptedVerificationDecisions([
      { ...base, boundary: 'none' },
      { ...base, boundary: 'snapshot-or-restoration', line: 2 },
      {
        ...base,
        boundary: 'none',
        initializer: 'indexed-or-dynamic',
        line: 3,
      },
      {
        ...base,
        boundary: 'none',
        initializer: 'computed-or-constructed',
        line: 4,
      },
      {
        ...base,
        boundary: 'none',
        line: 5,
        safeSubstitution: false,
      },
    ])).toEqual([
      {
        confidence: 'high',
        line: 1,
        message: 'decision',
        suggestion: 'Use the source directly.',
      },
    ])
  })
})

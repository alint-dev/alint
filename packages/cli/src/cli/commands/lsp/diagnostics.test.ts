import type { Diagnostic } from '@alint-js/core'

import { describe, expect, it } from 'vitest'

import { toLspDiagnostic, WHOLE_LINE } from './diagnostics'

const base: Diagnostic = {
  filePath: '/repo/src/date.ts',
  message: 'helper is duplicated',
  ruleId: 'js/no-duplicated-helper',
  severity: 'warn',
}

describe('toLspDiagnostic', () => {
  it('converts a 1-based line to 0-based and leaves the column alone', () => {
    const result = toLspDiagnostic({
      ...base,
      loc: {
        end: { column: 12, line: 4 },
        start: { column: 2, line: 4 },
      },
    })

    expect(result.range.start).toEqual({ character: 2, line: 3 })
    expect(result.range.end).toEqual({ character: 12, line: 3 })
  })

  it('ends at the whole-line sentinel when loc.end is missing', () => {
    const result = toLspDiagnostic({
      ...base,
      loc: {
        start: { column: 4, line: 2 },
      },
    })

    expect(result.range.start).toEqual({ character: 0, line: 1 })
    expect(result.range.end).toEqual({ character: WHOLE_LINE, line: 1 })
  })

  it('keeps the sentinel inside the LSP uinteger range', () => {
    // LSP positions are `uinteger`. A client can reject a value above 2^31-1.
    expect(Number.isInteger(WHOLE_LINE)).toBe(true)
    expect(WHOLE_LINE).toBeGreaterThan(0)
    expect(WHOLE_LINE).toBeLessThanOrEqual(2 ** 31 - 1)
  })

  it('anchors a file-level finding at line 0', () => {
    const result = toLspDiagnostic(base)

    expect(result.range.start).toEqual({ character: 0, line: 0 })
    expect(result.range.end).toEqual({ character: 0, line: 0 })
  })

  it('maps severity and carries the rule id as the code', () => {
    expect(toLspDiagnostic(base).severity).toBe(2)
    expect(toLspDiagnostic({ ...base, severity: 'error' }).severity).toBe(1)
    expect(toLspDiagnostic(base).code).toBe('js/no-duplicated-helper')
    expect(toLspDiagnostic(base).source).toBe('alint')
    expect(toLspDiagnostic(base).message).toBe('helper is duplicated')
  })

  it('never returns a negative line for a line-1 finding', () => {
    const result = toLspDiagnostic({
      ...base,
      loc: {
        start: { column: 0, line: 1 },
      },
    })

    expect(result.range.start.line).toBe(0)
  })

  it('keeps a multi-line range spanning both lines', () => {
    const result = toLspDiagnostic({
      ...base,
      loc: {
        end: { column: 1, line: 9 },
        start: { column: 0, line: 4 },
      },
    })

    expect(result.range.start).toEqual({ character: 0, line: 3 })
    expect(result.range.end).toEqual({ character: 1, line: 8 })
  })
})

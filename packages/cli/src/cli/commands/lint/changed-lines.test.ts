import type { RunResult } from '@alint-js/core'

import { describe, expect, it } from 'vitest'

import { filterResultToChangedLines } from './changed-lines'

describe('dirty result filtering', () => {
  it('keeps locationless diagnostics and locations that intersect changed lines', () => {
    const result = runResult([
      diagnostic('unchanged', 1),
      diagnostic('changed', 2),
      diagnostic('crosses changed line', 1, 2),
      diagnostic('locationless'),
      diagnostic('other file', 2, undefined, '/repo/other.ts'),
    ])

    const filtered = filterResultToChangedLines(result, {
      changedLines: new Map([
        [
          'input.ts',
          [
            { endLine: 2, startLine: 2 },
          ],
        ],
      ]),
      cwd: '/repo',
    })

    expect(filtered.diagnostics.map(diagnostic => diagnostic.message)).toEqual([
      'changed',
      'crosses changed line',
      'locationless',
    ])
    expect(filtered.execution).toBe(result.execution)
    expect(filtered.usage).toBe(result.usage)
  })
})

function diagnostic(message: string, startLine?: number, endLine?: number, filePath = '/repo/input.ts') {
  return {
    filePath,
    loc: startLine === undefined
      ? undefined
      : {
          end: endLine === undefined
            ? undefined
            : { column: 0, line: endLine },
          start: { column: 0, line: startLine },
        },
    message,
    ruleId: 'test/rule',
    severity: 'warn' as const,
  }
}

function runResult(diagnostics: RunResult['diagnostics']): RunResult {
  return {
    diagnostics,
    execution: {
      cached: 0,
      cancelled: 0,
      completed: 1,
      failed: 0,
      planned: 1,
      queued: 0,
      running: 0,
      skipped: 0,
    },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      records: [],
      totalTokens: 0,
    },
  }
}

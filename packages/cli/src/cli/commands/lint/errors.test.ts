import type { AlintRunFailure, RunResult } from '@alint-js/core'

import { AlintRunCancelledError, AlintRunError } from '@alint-js/core'
import { describe, expect, it } from 'vitest'

import { formatCancelledError, formatRunError } from './errors'

const EMPTY_RESULT: RunResult = {
  diagnostics: [],
  execution: {
    cached: 0,
    cancelled: 0,
    completed: 0,
    failed: 0,
    planned: 0,
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

type AlintRuleFailure = Extract<AlintRunFailure, { job: unknown }>

function failure(
  index: number,
  kind: AlintRuleFailure['kind'],
  planPath: string,
  targetKind: AlintRuleFailure['job']['target']['kind'],
  ruleId: string,
  message: string,
  targetName?: string,
): AlintRuleFailure {
  return {
    causes: [],
    job: {
      id: `job-${index}`,
      index,
      inputPath: planPath,
      ruleId,
      target: { identity: `target-${index}`, kind: targetKind, name: targetName },
    },
    kind,
    message,
  }
}

describe('formatRunError', () => {
  const failures = [
    failure(0, 'handler', 'src/a.ts', 'function', 'rule/a', 'boom', 'parse'),
    failure(1, 'timeout', 'src/b.ts', 'file', 'rule/b', 'Rule execution timed out after 100ms.'),
    failure(2, 'cache-replay', '.', 'project', 'rule/c', 'invalid cached diagnostic'),
  ]

  it('groups rule failures by rule and keeps targets in planned order', () => {
    const error = new AlintRunError('3 rule executions failed', EMPTY_RESULT, { failures })

    expect(formatRunError(error, false)).toBe([
      'error 3 rule executions failed',
      '',
      'Failed Rules 3',
      '',
      'FAIL rule/a 1 target',
      '  src/a.ts > function parse',
      '    [handler] boom',
      '',
      'FAIL rule/b 1 target',
      '  src/b.ts > file',
      '    [timeout] Rule execution timed out after 100ms.',
      '',
      'FAIL rule/c 1 target',
      '  . > project',
      '    [cache-replay] invalid cached diagnostic',
      '',
    ].join('\n'))
  })

  it('counts failed rule groups and preserves core failure order', () => {
    const error = new AlintRunError('2 rule executions failed', EMPTY_RESULT, {
      failures: [
        failure(2, 'handler', 'src/later.ts', 'file', 'rule/a', 'later target failed'),
        failure(1, 'handler', 'src/earlier.ts', 'file', 'rule/a', 'earlier target failed'),
      ],
    })

    expect(formatRunError(error, false)).toBe([
      'error 2 rule executions failed',
      '',
      'Failed Rules 1',
      '',
      'FAIL rule/a 2 targets',
      '  src/later.ts > file',
      '    [handler] later target failed',
      '  src/earlier.ts > file',
      '    [handler] earlier target failed',
      '',
    ].join('\n'))
  })

  it('renders FAIL as a red-background label when color is enabled', () => {
    const error = new AlintRunError('1 rule execution failed.', EMPTY_RESULT, {
      failures: failures.slice(0, 1),
    })
    const output = formatRunError(error, true)

    expect(output).toContain('\u001B[41m\u001B[1m FAIL \u001B[22m\u001B[49m rule/a 1 target')
    expect(output).toContain('src/a.ts > function parse')
    expect(output).toContain('[handler] boom')
  })

  it('formats file failures before rule failures without admission-index sorting', () => {
    const mixed: AlintRunFailure[] = [
      {
        file: { index: 0, path: 'src/read.ts' },
        kind: 'read',
        message: 'cannot read',
      },
      {
        file: { index: 1, path: 'src/extract.ts' },
        kind: 'extract',
        message: 'cannot parse',
      },
      failure(9, 'handler', 'src/later.ts', 'file', 'rule/a', 'later failed'),
      failure(2, 'timeout', 'src/earlier.ts', 'function', 'rule/a', 'earlier timed out', 'parse'),
    ]
    const error = new AlintRunError('4 alint executions failed.', EMPTY_RESULT, { failures: mixed })

    expect(formatRunError(error, false)).toBe([
      'error 4 alint executions failed.',
      '',
      'Failed Files 2',
      '',
      'FAIL src/read.ts',
      '  [read] cannot read',
      '',
      'FAIL src/extract.ts',
      '  [extract] cannot parse',
      '',
      'Failed Rules 1',
      '',
      'FAIL rule/a 2 targets',
      '  src/later.ts > file',
      '    [handler] later failed',
      '  src/earlier.ts > function parse',
      '    [timeout] earlier timed out',
      '',
    ].join('\n'))
  })
})

describe('formatCancelledError', () => {
  it('formats cancellation as an execution error', () => {
    expect(formatCancelledError(new AlintRunCancelledError(EMPTY_RESULT), false)).toBe('error Alint run cancelled.\n')
  })
})

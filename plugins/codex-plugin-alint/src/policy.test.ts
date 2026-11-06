import { describe, expect, it } from 'vitest'

import { applyResult, lintLimitDecision } from './policy'
import { emptyState } from './state'

describe('stop gate policy', () => {
  it('blocks only the first warning-only lint round', () => {
    const first = applyResult(emptyState(), warningEnvelope(), new Date('2026-01-01T00:00:00.000Z'))
    const second = applyResult(first.state, warningEnvelope(), new Date('2026-01-01T00:01:00.000Z'))

    expect(first.state.lintRounds).toBe(1)
    expect(first.decision.decision).toBe('block')
    expect(first.decision.reason).toBe('alint-plugin: 0 error(s), 1 warning(s). Review the report at "/tmp/report.json" carefully. Act only on findings that are valid, valuable, and relevant to the current uncommitted changes. Do not make opportunistic changes merely to silence findings, such as deleting code, ignoring files, disabling rules, or changing the alint configuration. If you determine that none of reports are valid or valuable, just do nothing, next time the gate will allowing this turn to finish.')
    expect(second.state.lintRounds).toBe(2)
    expect(second.decision.decision).toBeUndefined()
    expect(second.decision.systemMessage).toBe('alint-plugin: The same 0 error(s) and 1 warning(s) remain unchanged from the previous automatic lint. Stop Gate is allowing this turn to finish. The report remains at "/tmp/report.json".')
  })

  it('allows the second consecutive occurrence of identical errors', () => {
    const first = applyResult(emptyState(), errorEnvelope(hash('a')))
    const second = applyResult(first.state, errorEnvelope(hash('a')))

    expect(first.decision.decision).toBe('block')
    expect(second.state.lintRounds).toBe(2)
    expect(second.decision.decision).toBeUndefined()
    expect(second.decision.systemMessage).toBe('alint-plugin: The same 1 error(s) and 0 warning(s) remain unchanged from the previous automatic lint. Stop Gate is allowing this turn to finish. The report remains at "/tmp/report.json".')
  })

  it('requires two consecutive occurrences after the findings change', () => {
    const first = applyResult(emptyState(), errorEnvelope(hash('a')))
    const changed = applyResult(first.state, errorEnvelope(hash('b')))
    const repeated = applyResult(changed.state, errorEnvelope(hash('b')))

    expect(first.decision.decision).toBe('block')
    expect(changed.decision.decision).toBe('block')
    expect(repeated.decision.decision).toBeUndefined()
    expect(repeated.decision.systemMessage).toContain('remain unchanged from the previous automatic lint')
  })

  it('allows errors on the ninth successful lint round and stops running afterward', () => {
    let state = emptyState()
    let decision

    for (let round = 1; round <= 9; round += 1) {
      const applied = applyResult(state, errorEnvelope(String(round).repeat(64)))
      state = applied.state
      decision = applied.decision
    }

    expect(state.lintRounds).toBe(9)
    expect(decision?.decision).toBeUndefined()
    expect(decision?.systemMessage).toBe('alint-plugin: 1 error(s), 0 warning(s). Review the report at "/tmp/report.json" carefully. Act only on findings that are valid, valuable, and relevant to the current uncommitted changes. Do not make opportunistic changes merely to silence findings, such as deleting code, ignoring files, disabling rules, or changing the alint configuration. If you determine that none of reports are valid or valuable, just do nothing, next time the gate will allowing this turn to finish.')
    expect(lintLimitDecision(state).systemMessage).toContain('/tmp/report.json')
  })

  it('explains when the lint limit is reached without a final report', () => {
    const state = {
      ...emptyState(),
      lintRounds: 9,
    }

    expect(lintLimitDecision(state).systemMessage).toBe('alint-plugin: Stop Gate reached the maximum of 9 successful lint rounds for this session. The latest lint completed with no findings, so no report was written.')
  })

  it('tracks runtime failures independently and resets them after a lint', () => {
    const firstFailure = applyResult(emptyState(), runtimeEnvelope())
    const secondFailure = applyResult(firstFailure.state, runtimeEnvelope())
    const linted = applyResult(secondFailure.state, warningEnvelope())

    expect(firstFailure.decision.decision).toBe('block')
    expect(firstFailure.decision.reason).toBe([
      'alint-plugin: Runtime error: missing provider',
      'Do not attempt to fix it yourself. Explain the error to the user and suggest how to fix it.',
    ].join('\n'))
    expect(firstFailure.state.lintRounds).toBe(0)
    expect(firstFailure.state.runtimeFailures).toBe(1)
    expect(secondFailure.decision.decision).toBeUndefined()
    expect(secondFailure.decision.systemMessage).toBe(firstFailure.decision.reason)
    expect(secondFailure.state.runtimeFailures).toBe(2)
    expect(linted.state.lintRounds).toBe(1)
    expect(linted.state.runtimeFailures).toBe(0)
  })

  it('directs Codex to read a runtime error report before suggesting a fix', () => {
    const failed = applyResult(emptyState(), runtimeEnvelope('/tmp/failure-report.json'))

    expect(failed.decision.decision).toBe('block')
    expect(failed.decision.reason).toBe([
      'alint-plugin: Runtime error: 7 rule executions failed.',
      'Do not attempt to fix it yourself. Read the error details at "/tmp/failure-report.json", then explain to the user how to fix the failures.',
    ].join('\n'))
  })

  it('breaks findings continuity after a runtime failure', () => {
    const first = applyResult(emptyState(), errorEnvelope(hash('a')))
    const failed = applyResult(first.state, runtimeEnvelope())
    const afterFailure = applyResult(failed.state, errorEnvelope(hash('a')))

    expect(failed.state.lastFindings).toBeUndefined()
    expect(afterFailure.decision.decision).toBe('block')
  })

  it('breaks findings continuity when there are no dirty files', () => {
    const first = applyResult(emptyState(), errorEnvelope(hash('a')))
    const noDirtyFiles = applyResult(first.state, {
      errorCount: 0,
      schemaVersion: 2 as const,
      status: 'no-dirty-files' as const,
      warningCount: 0,
    })
    const afterNoDirtyFiles = applyResult(noDirtyFiles.state, errorEnvelope(hash('a')))

    expect(noDirtyFiles.state.lastFindings).toBeUndefined()
    expect(afterNoDirtyFiles.decision.decision).toBe('block')
  })

  it('does not count inactive or no-dirty-file results as lint rounds', () => {
    const inactive = applyResult(emptyState(), {
      errorCount: 0,
      schemaVersion: 2,
      status: 'inactive',
      warningCount: 0,
    })
    const noDirtyFiles = applyResult(inactive.state, {
      errorCount: 0,
      schemaVersion: 2,
      status: 'no-dirty-files',
      warningCount: 0,
    })

    expect(noDirtyFiles.state.lintRounds).toBe(0)
    expect(noDirtyFiles.decision).toEqual({})
  })

  it('clears prior session findings when the repository disables Stop Gate', () => {
    const linted = applyResult(emptyState(), warningEnvelope())
    const inactive = applyResult(linted.state, {
      errorCount: 0,
      schemaVersion: 2,
      status: 'inactive',
      warningCount: 0,
    })

    expect(inactive.state.lastFindings).toBeUndefined()
    expect(inactive.state.lintRounds).toBe(0)
    expect(inactive.state.runtimeFailures).toBe(0)
  })
})

function errorEnvelope(findingsHash = 'a'.repeat(64)) {
  return {
    errorCount: 1,
    findingsHash,
    reportPath: '/tmp/report.json',
    schemaVersion: 2 as const,
    status: 'errors' as const,
    warningCount: 0,
  }
}

function hash(character: string): string {
  return character.repeat(64)
}

function runtimeEnvelope(reportPath?: string) {
  return {
    errorCount: 0,
    message: reportPath === undefined
      ? 'missing provider'
      : '7 rule executions failed.',
    ...(reportPath === undefined
      ? {}
      : { reportPath }),
    schemaVersion: 2 as const,
    status: 'runtime-error' as const,
    warningCount: 0,
  }
}

function warningEnvelope() {
  return {
    errorCount: 0,
    findingsHash: 'b'.repeat(64),
    reportPath: '/tmp/report.json',
    schemaVersion: 2 as const,
    status: 'warnings' as const,
    warningCount: 1,
  }
}

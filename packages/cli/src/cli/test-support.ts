import type { Diagnostic, RunResult } from '@alint-js/core'

/**
 * A run result with the given diagnostics and no execution counts. Test-only; no build entry
 * imports it.
 *
 * Tests that replace `runAlint` need a whole `RunResult`, and `ExecutionCounts` has eight required
 * fields that almost no test asserts on.
 */
export function runResultWith(diagnostics: Diagnostic[] = []): RunResult {
  return {
    diagnostics,
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
}

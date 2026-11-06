import type { AlintRuleFailure, Diagnostic, InferenceUsageRecord, ProgressJobRef } from '../types'

export function snapshotDiagnostic(diagnostic: Diagnostic): Diagnostic {
  const snapshot = { ...diagnostic }
  if (diagnostic.loc) {
    snapshot.loc = {
      ...(diagnostic.loc.end
        ? {
            end: { ...diagnostic.loc.end },
          }
        : {}),
      start: { ...diagnostic.loc.start },
    }
  }
  if (diagnostic.model)
    snapshot.model = { ...diagnostic.model }

  // evidence is intentionally retained as the rule-owned public output payload.
  return snapshot
}

export function snapshotDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.map(snapshotDiagnostic)
}

export function snapshotFailure(failure: AlintRuleFailure): AlintRuleFailure {
  return {
    causes: failure.causes.map(cause => ({ ...cause })),
    job: snapshotProgressJobRef(failure.job),
    kind: failure.kind,
    message: failure.message,
  }
}

export function snapshotProgressJobRef(job: ProgressJobRef): ProgressJobRef {
  return {
    id: job.id,
    index: job.index,
    inputPath: job.inputPath,
    ruleId: job.ruleId,
    target: {
      identity: job.target.identity,
      kind: job.target.kind,
      name: job.target.name,
    },
  }
}

export function snapshotUsage(record: InferenceUsageRecord): InferenceUsageRecord {
  // metadata is intentionally retained as the rule-owned public output payload.
  return { ...record }
}

export function snapshotUsageRecords(records: InferenceUsageRecord[]): InferenceUsageRecord[] {
  return records.map(snapshotUsage)
}

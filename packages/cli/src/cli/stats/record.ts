import type { InferenceUsageRecord, RunUsage } from '@alint-js/core'

import type { RunRuleCounts, RunStatInput, StatsUsageRecord } from './types'

export interface CreateRunStatInput {
  cwd: string
  durationMs?: number
  ruleCounts: RunRuleCounts
  usage: RunUsage
}

export function createRunStat(input: CreateRunStatInput): RunStatInput {
  return {
    cwd: input.cwd,
    durationMs: input.durationMs,
    ruleCounts: input.ruleCounts,
    usage: {
      inTok: input.usage.inputTokens,
      outTok: input.usage.outputTokens,
      records: input.usage.records.map(toStatsUsageRecord),
      totalTok: input.usage.totalTokens,
    },
  }
}

function readOperation(metadata: unknown): string | undefined {
  if (typeof metadata !== 'object' || metadata === null || !('operation' in metadata)) {
    return undefined
  }

  const operation = (metadata as { operation?: unknown }).operation

  return typeof operation === 'string'
    ? operation
    : undefined
}

function toStatsUsageRecord(record: InferenceUsageRecord): StatsUsageRecord {
  return {
    filePath: record.filePath,
    inTok: record.inputTokens ?? 0,
    modelId: record.modelId,
    operation: readOperation(record.metadata),
    outTok: record.outputTokens ?? 0,
    providerId: record.providerId,
    ruleId: record.ruleId,
    totalTok: record.totalTokens ?? 0,
  }
}

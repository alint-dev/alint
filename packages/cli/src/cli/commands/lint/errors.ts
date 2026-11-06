import type { AlintRunCancelledError, AlintRunError, AlintRunFailure } from '@alint-js/core'

import { createColors } from 'tinyrainbow'

const colors = createColors({ force: true })

type AlintFileFailure = Extract<AlintRunFailure, { file: unknown }>
type AlintRuleFailure = Extract<AlintRunFailure, { job: unknown }>

export function formatCancelledError(error: AlintRunCancelledError, color: boolean): string {
  const label = color
    ? colors.red('error')
    : 'error'
  return `${label} ${error.message}\n`
}

export function formatRunError(error: AlintRunError, color: boolean): string {
  const label = color
    ? colors.red('error')
    : 'error'
  const fileFailures = error.failures.filter((failure): failure is AlintFileFailure => 'file' in failure)
  const ruleFailures = error.failures.filter((failure): failure is AlintRuleFailure => 'job' in failure)
  const groups = groupFailuresByRule(ruleFailures)
  const lines = [
    `${label} ${error.message}`,
    '',
    ...(fileFailures.length > 0
      ? [
          `Failed Files ${fileFailures.length}`,
          '',
          ...formatFileFailures(fileFailures, color),
        ]
      : []),
    ...(groups.length > 0
      ? [
          `Failed Rules ${groups.length}`,
          '',
          ...formatFailureGroups(groups, color),
        ]
      : []),
  ]

  return lines.join('\n')
}

function formatFailureGroups(groups: Array<[string, AlintRuleFailure[]]>, color: boolean): string[] {
  const lines: string[] = []
  for (const [ruleId, group] of groups) {
    const failLabel = color
      ? colors.bgRed(colors.bold(' FAIL '))
      : 'FAIL'
    const targetLabel = group.length === 1
      ? 'target'
      : 'targets'
    lines.push(`${failLabel} ${ruleId} ${group.length} ${targetLabel}`)
    for (const failure of group) {
      lines.push(`  ${formatTarget(failure)}`)
      lines.push(`    [${failure.kind}] ${failure.message}`)
      for (const cause of failure.causes) {
        const code = cause.code === undefined
          ? ''
          : `[${cause.code}] `
        lines.push(`      Caused by: ${code}${cause.message}`)
      }
    }
    lines.push('')
  }
  return lines
}

function formatFileFailures(failures: AlintFileFailure[], color: boolean): string[] {
  const lines: string[] = []
  for (const failure of failures) {
    const failLabel = color
      ? colors.bgRed(colors.bold(' FAIL '))
      : 'FAIL'
    lines.push(`${failLabel} ${failure.file.path}`)
    lines.push(`  [${failure.kind}] ${failure.message}`)
    lines.push('')
  }
  return lines
}

function formatTarget(failure: AlintRuleFailure): string {
  const target = failure.job.target.name
    ? `${failure.job.target.kind} ${failure.job.target.name}`
    : failure.job.target.kind

  return `${failure.job.inputPath} > ${target}`
}

function groupFailuresByRule(failures: AlintRuleFailure[]): Array<[string, AlintRuleFailure[]]> {
  const groups = new Map<string, AlintRuleFailure[]>()
  for (const failure of failures) {
    const group = groups.get(failure.job.ruleId) ?? []
    group.push(failure)
    groups.set(failure.job.ruleId, group)
  }

  return [...groups]
}

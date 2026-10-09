import type { Diagnostic, RunResult } from '@alint-js/core'

import { isAbsolute, relative } from 'pathe'

import { isRecord } from '../../output-inspect/run-result'

export interface Annotation {
  annotation_level: 'failure' | 'warning'
  end_line: number
  message: string
  path: string
  start_line: number
  title: string
}

export type Conclusion = 'failure' | 'neutral' | 'success'

export interface Finding {
  line: number
  message: string
  path: string
  ruleId: string
  severity: Diagnostic['severity']
  suggestion?: string
}

export interface SummaryContext {
  repository: string
  runUrl?: string
  serverUrl: string
  sha: string
  usage: RunResult['usage']
}

/** Identifies the summary comment so that later runs rewrite it instead of adding another one. */
export const summaryMarker = '<!-- alint-summary -->'

// GitHub rejects a comment or a check summary above 65536 characters.
// One row is a few hundred characters, so this cap keeps the table far below the limit.
const maxSummaryRows = 100

export function formatSummary(findings: readonly Finding[], context: SummaryContext): string {
  const icon = toConclusion(findings) === 'failure' ? '❌' : findings.length > 0 ? '⚠️' : '✅'
  const shortSha = context.sha.slice(0, 7)
  const lines = [summaryMarker, `### ${icon} alint · ${formatTitle(findings)}`, '']

  if (findings.length === 0) {
    lines.push(`Checked the changes at \`${shortSha}\`.`)
  }
  else {
    lines.push('| | Location | Rule | Finding |', '| --- | --- | --- | --- |')

    for (const finding of findings.slice(0, maxSummaryRows)) {
      const link = `${context.serverUrl}/${context.repository}/blob/${context.sha}/${encodeURI(finding.path)}#L${finding.line}`
      const detail = finding.suggestion === undefined
        ? escapeCell(finding.message)
        : `${escapeCell(finding.message)}<br><sub>💡 ${escapeCell(finding.suggestion)}</sub>`

      lines.push(`| ${finding.severity === 'error' ? '❌' : '⚠️'} | [\`${finding.path}:${finding.line}\`](${link}) | \`${finding.ruleId}\` | ${detail} |`)
    }

    if (findings.length > maxSummaryRows) {
      lines.push('', `${findings.length - maxSummaryRows} more findings are in the check annotations.`)
    }
  }

  const footer = [
    `Commit \`${shortSha}\``,
    context.runUrl === undefined ? undefined : `[run](${context.runUrl})`,
    `${context.usage.totalTokens.toLocaleString('en-US')} tokens`,
  ].filter(part => part !== undefined)

  lines.push('', `<sub>${footer.join(' · ')}</sub>`)

  return lines.join('\n')
}

export function formatTitle(findings: readonly Finding[]): string {
  if (findings.length === 0) {
    return 'No findings'
  }

  const errors = findings.filter(finding => finding.severity === 'error').length
  const warnings = findings.length - errors

  return [
    errors > 0 ? pluralize(errors, 'error') : undefined,
    warnings > 0 ? pluralize(warnings, 'warning') : undefined,
  ].filter(part => part !== undefined).join(', ')
}

export function toAnnotations(findings: readonly Finding[]): Annotation[] {
  return findings.map(finding => ({
    annotation_level: finding.severity === 'error' ? 'failure' : 'warning',
    end_line: finding.line,
    message: finding.suggestion === undefined ? finding.message : `${finding.message}\n\n${finding.suggestion}`,
    path: finding.path,
    start_line: finding.line,
    title: finding.ruleId,
  }))
}

export function toConclusion(findings: readonly Finding[]): Conclusion {
  if (findings.some(finding => finding.severity === 'error')) {
    return 'failure'
  }

  return findings.length > 0 ? 'neutral' : 'success'
}

/** Converts diagnostics to findings with repository-relative paths. Errors come first. */
export function toFindings(diagnostics: readonly Diagnostic[], cwd: string): Finding[] {
  return diagnostics
    .map((diagnostic): Finding => ({
      // A diagnostic without a location is about the whole file. An annotation needs a line.
      line: diagnostic.loc?.start.line ?? 1,
      message: diagnostic.message.trim(),
      path: (isAbsolute(diagnostic.filePath) ? relative(cwd, diagnostic.filePath) : diagnostic.filePath).replaceAll('\\', '/'),
      ruleId: diagnostic.ruleId,
      severity: diagnostic.severity,
      suggestion: suggestionFrom(diagnostic.evidence),
    }))
    .sort((a, b) =>
      Number(b.severity === 'error') - Number(a.severity === 'error')
      || a.path.localeCompare(b.path)
      || a.line - b.line,
    )
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll(/\s*\n\s*/gu, ' ')
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

// Declarative rules and `@alint-js/plugin-js` rules put the remediation text in `evidence.suggestion`.
function suggestionFrom(evidence: unknown): string | undefined {
  if (!isRecord(evidence) || typeof evidence.suggestion !== 'string') {
    return undefined
  }

  return evidence.suggestion.trim() || undefined
}

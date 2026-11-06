import type { Diagnostic, RunResult } from '@alint-js/core'

import { createColors } from 'tinyrainbow'

const colors = createColors({ force: true })

export interface StylishReporterOptions {
  color?: boolean
}

export function formatStylish(input: Diagnostic[] | RunResult, options: StylishReporterOptions = {}): string {
  const diagnostics = Array.isArray(input)
    ? input
    : input.diagnostics
  const result = Array.isArray(input)
    ? undefined
    : input
  const style = createStyle(options.color === true)

  if (diagnostics.length === 0) {
    return result?.execution?.cached
      ? `${formatSummary(diagnostics, result, style)}\n`
      : ''
  }

  const diagnosticsByFile = new Map<string, Diagnostic[]>()

  for (const diagnostic of diagnostics) {
    const fileDiagnostics = diagnosticsByFile.get(diagnostic.filePath)

    if (fileDiagnostics) {
      fileDiagnostics.push(diagnostic)
      continue
    }

    diagnosticsByFile.set(diagnostic.filePath, [diagnostic])
  }

  const lines: string[] = []

  for (const [filePath, fileDiagnostics] of diagnosticsByFile) {
    lines.push(style.file(filePath))

    for (const diagnostic of fileDiagnostics) {
      const line = diagnostic.loc?.start.line ?? 0
      const column = diagnostic.loc?.start.column ?? 0
      const severity = diagnostic.severity === 'warn'
        ? style.warning('warning')
        : style.error('error')

      lines.push(`  ${style.location(`${line}:${column}`)}  ${severity}  ${diagnostic.message}  ${style.ruleId(diagnostic.ruleId)}`)
    }

    lines.push('')
  }

  lines.push('', formatSummary(diagnostics, result, style))

  return `${lines.join('\n')}\n`
}

function countCachedDiagnostics(diagnostics: Diagnostic[], severity: Diagnostic['severity']): number {
  return diagnostics.filter(diagnostic => diagnostic.severity === severity && diagnostic.cached === true).length
}

function countDiagnostics(diagnostics: Diagnostic[], severity: Diagnostic['severity']): number {
  return diagnostics.filter(diagnostic => diagnostic.severity === severity).length
}

function createStyle(color: boolean) {
  if (!color) {
    return {
      error: identity,
      file: identity,
      location: identity,
      ruleId: identity,
      summaryToken: identity,
      warning: identity,
    }
  }

  return {
    error: colors.red,
    file: colors.underline,
    location: colors.dim,
    ruleId: colors.dim,
    summaryToken: colors.cyan,
    warning: colors.yellow,
  }
}

function formatDiagnosticCount(total: number, cached: number, label: string): string {
  return `${total} ${label}${cached > 0
    ? ` (${cached} cached)`
    : ''}`
}

function formatExecutionSummary(execution: RunResult['execution'] | undefined): string | undefined {
  if (!execution || execution.cached === 0) {
    return undefined
  }

  return `${execution.cached}/${execution.planned} cached`
}

function formatSummary(
  diagnostics: Diagnostic[],
  result: RunResult | undefined,
  style: ReturnType<typeof createStyle>,
): string {
  const warnCount = countDiagnostics(diagnostics, 'warn')
  const errorCount = countDiagnostics(diagnostics, 'error')
  const cachedWarnCount = countCachedDiagnostics(diagnostics, 'warn')
  const cachedErrorCount = countCachedDiagnostics(diagnostics, 'error')
  const tokens = result === undefined
    ? undefined
    : formatTokenSummary(result)
  const problemSummary = [
    style.warning(formatDiagnosticCount(warnCount, cachedWarnCount, 'warn')),
    style.error(formatDiagnosticCount(errorCount, cachedErrorCount, 'error')),
  ].join(' / ')

  if (tokens === undefined) {
    return problemSummary
  }

  const execution = formatExecutionSummary(result?.execution)

  return [
    problemSummary,
    style.summaryToken(tokens),
    execution,
  ]
    .filter((segment): segment is string => segment !== undefined)
    .join(' | ')
}

function formatTokenSummary(result: RunResult): string {
  const liveTokens = result.usage.totalTokens.toLocaleString('en-US')
  const cachedTokens = result.usage.cached?.totalTokens ?? 0

  return `${liveTokens} tokens${cachedTokens > 0
    ? ` (${cachedTokens.toLocaleString('en-US')} cached)`
    : ''}`
}

function identity(value: string): string {
  return value
}

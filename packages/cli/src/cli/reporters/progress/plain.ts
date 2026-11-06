import type {
  Diagnostic,
  JobStartPayload,
  ProgressReporter,
  RunEndPayload,
} from '@alint-js/core'

export interface PlainProgressReporterOptions {
  write: (chunk: string) => void
}

export function createPlainProgressReporter(options: PlainProgressReporterOptions): ProgressReporter {
  const writeLine = (line: string) => options.write(`${line}\n`)

  return {
    onJobRetry: () => {},
    onJobStart: (payload: JobStartPayload) => {
      const target = payload.job.target.name
        ? `${payload.job.target.kind} ${payload.job.target.name}`
        : payload.job.target.kind

      writeLine(`scan ${payload.job.inputPath} > ${target} > ${payload.job.ruleId}`)
    },
    onPrepareEnd: ({ filesTotal }) => writeLine(`alint prepared: ${filesTotal} files`),
    onPrepareStart: () => writeLine('alint preparing'),
    onRunEnd: (payload: RunEndPayload) => {
      const warnCount = countDiagnostics(payload.diagnostics, 'warn')
      const errorCount = countDiagnostics(payload.diagnostics, 'error')
      const state = payload.execution.failed > 0
        ? 'failed'
        : 'finished'
      const { cached, cancelled, completed, failed, skipped } = payload.execution

      writeLine(`alint ${state}: ${warnCount} warn, ${errorCount} error, ${payload.usage.totalTokens} tokens, ${completed} completed, ${cached} cached, ${failed} failed, ${cancelled} cancelled, ${skipped} skipped`)
    },
  }
}

function countDiagnostics(diagnostics: Diagnostic[], severity: Diagnostic['severity']): number {
  return diagnostics.filter(diagnostic => diagnostic.severity === severity).length
}

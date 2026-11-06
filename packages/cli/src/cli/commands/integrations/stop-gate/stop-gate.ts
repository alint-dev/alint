import type { CliIo } from '../../../types'

import { loadAlintConfigWithMetadata } from '@alint-js/config'
import { AlintRunCancelledError, resolveStopGateConfig } from '@alint-js/core'
import { errorMessageFrom } from '@moeru/std'

import { findGitRoot } from '../../../git'
import { defineCommand } from '../../command'
import { writeEnvelope } from './envelope'
import { fingerprintDiagnostics } from './findings'
import { removeStopGateReport, StopGateReportTooLargeError, writeStopGateReport } from './report'
import { runStopGateLint } from './run'

interface StopGateCommandOptions {
  sessionId?: string
}

export const stopGate = defineCommand({
  action: (context, options: StopGateCommandOptions) => runStopGateCommand(options, context.io),
  description: 'Run the repository Stop Gate integration',
  exactArguments: true,
  name: 'stop-gate',
  options: [
    { description: 'Codex session id', flags: '--session-id <id>' },
  ],
})

async function runStopGateCommand(
  options: StopGateCommandOptions,
  io: CliIo,
): Promise<number> {
  if (!options.sessionId) {
    io.stderr.write('Stop Gate requires --session-id.\n')
    return 2
  }

  try {
    const cwd = await findGitRoot(io.cwd)
    const loaded = await loadAlintConfigWithMetadata(cwd)

    if (loaded.configFile === undefined) {
      writeEnvelope(chunk => io.stdout.write(chunk), {
        errorCount: 0,
        schemaVersion: 2,
        status: 'inactive',
        warningCount: 0,
      })
      return 0
    }

    const stopGate = resolveStopGateConfig(loaded.config, cwd)

    if (!stopGate.enabled) {
      await removeStopGateReport(options.sessionId)
      writeEnvelope(chunk => io.stdout.write(chunk), {
        errorCount: 0,
        schemaVersion: 2,
        status: 'inactive',
        warningCount: 0,
      })
      return 0
    }

    const lint = await runStopGateLint({
      config: loaded.config,
      cwd,
      io,
      stopGate,
    })

    if (lint === undefined) {
      await removeStopGateReport(options.sessionId)
      writeEnvelope(chunk => io.stdout.write(chunk), {
        errorCount: 0,
        schemaVersion: 2,
        status: 'no-dirty-files',
        warningCount: 0,
      })
      return 0
    }

    if (lint.error !== undefined) {
      const reportPath = await writeStopGateReport(options.sessionId, {
        cwd,
        diagnostics: lint.result.diagnostics,
        execution: lint.result.execution,
        failure: {
          details: lint.error.failures,
          message: lint.error.message,
        },
        files: lint.files,
        schemaVersion: 1,
        target: stopGate.target,
        usage: lint.result.usage,
      })
      writeEnvelope(chunk => io.stdout.write(chunk), {
        errorCount: 0,
        message: lint.error.message,
        reportPath,
        schemaVersion: 2,
        status: 'runtime-error',
        warningCount: 0,
      })
      return 1
    }

    const errorCount = lint.result.diagnostics.filter(diagnostic => diagnostic.severity === 'error').length
    const warningCount = lint.result.diagnostics.length - errorCount

    if (errorCount === 0 && warningCount === 0) {
      await removeStopGateReport(options.sessionId)
      writeEnvelope(chunk => io.stdout.write(chunk), {
        errorCount,
        schemaVersion: 2,
        status: 'clean',
        warningCount,
      })
      return 0
    }

    const reportPath = await writeStopGateReport(options.sessionId, {
      cwd,
      diagnostics: lint.result.diagnostics,
      execution: lint.result.execution,
      files: lint.files,
      schemaVersion: 1,
      target: stopGate.target,
      usage: lint.result.usage,
    })
    writeEnvelope(chunk => io.stdout.write(chunk), {
      errorCount,
      findingsHash: fingerprintDiagnostics(lint.result.diagnostics),
      reportPath,
      schemaVersion: 2,
      status: errorCount > 0
        ? 'errors'
        : 'warnings',
      warningCount,
    })
    return 0
  }
  catch (error) {
    const detail = error instanceof StopGateReportTooLargeError
      ? error.message
      : error instanceof AlintRunCancelledError
        ? 'Stop Gate timed out before lint completed.'
        : errorMessageFrom(error) ?? 'unknown error'
    writeEnvelope(chunk => io.stdout.write(chunk), {
      errorCount: 0,
      message: detail,
      schemaVersion: 2,
      status: 'runtime-error',
      warningCount: 0,
    })
    return 1
  }
}

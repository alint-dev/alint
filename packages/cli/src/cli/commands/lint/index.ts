import type { AlintConfig, RunResult } from '@alint-js/core'

import type { ChangedLineRange } from '../../git'
import type { ReporterName } from '../../reporters'
import type { SessionTargetSelection } from '../../runtime/session'
import type { CliIo, CliWritable } from '../../types'
import type { LintTargets } from './discovery'
import type { LintCommandOptions } from './options'

import { stat } from 'node:fs/promises'

import { loadAlintConfig } from '@alint-js/config'
import { AlintCachePersistenceError, AlintRunCancelledError, AlintRunError } from '@alint-js/core'
import { isNodeErrorCode } from '@alint-js/utils/node'
import { errorMessageFrom } from '@moeru/std'
import { resolve } from 'pathe'

import { findGitRoot } from '../../git'
import { formatDiagnostics } from '../../reporters'
import { createCliProgressReporter } from '../../reporters/progress'
import { createRunSession } from '../../runtime/session'
import { defineCommand } from '../command'
import { filterResultToChangedLines } from './changed-lines'
import { findDirtyLintTargets, NoFilesFoundError } from './discovery'
import { formatCancelledError, formatRunError } from './errors'
import { executeLint } from './execution'
import { resolveRuleFilter } from './rule-filter'

export const lint = defineCommand({
  action: (context, files: string[] = [], options: LintCommandOptions) =>
    runLintCommand(
      files,
      {
        ...options,
        outputLanguage: options.lang ?? context.globalOptions.outputLanguage,
      },
      context.io,
      context.interceptConsoleOutput,
      context.signal,
    ),
  alias: ['!'],
  arguments: '[...files]',
  default: true,
  description: 'Run alint',
  name: 'lint',
  options: [
    { description: 'Lint only staged, unstaged, and untracked files', flags: '--dirty' },
  ],
})

async function assertConfigExists(cwd: string, configPath: string): Promise<void> {
  const resolvedConfigPath = resolve(cwd, configPath)

  try {
    const stats = await stat(resolvedConfigPath)

    if (!stats.isFile()) {
      throw new Error(`Config file "${configPath}" is not a file.`)
    }
  }
  catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      throw new Error(`Config file "${configPath}" does not exist.`)
    }

    throw error
  }
}

async function runLintCommand(
  files: string[],
  options: LintCommandOptions,
  io: CliIo,
  interceptConsoleOutput: (stdout: CliWritable) => () => void,
  signal: AbortSignal | undefined,
): Promise<number> {
  if (options.dirty && files.length > 0) {
    io.stderr.write('The --dirty option does not accept file arguments.\n')
    return 2
  }

  const cwd = options.dirty ? await findGitRoot(io.cwd) : io.cwd
  const runIo = cwd === io.cwd ? io : { ...io, cwd }

  if (options.config) {
    await assertConfigExists(cwd, options.config)
  }

  let changedLines: ReadonlyMap<string, readonly ChangedLineRange[]> | undefined
  let config: AlintConfig | undefined
  let targets: LintTargets | undefined

  if (options.dirty) {
    config = await loadAlintConfig(cwd, options.config)
    const dirtyTargets = await findDirtyLintTargets(config, cwd)
    changedLines = dirtyTargets.changedLines
    targets = dirtyTargets

    // Do not initialize model adapters when the repository has nothing to lint.
    if (targets.files.length === 0) {
      return 0
    }
  }

  const session = await createRunSession(runIo, config === undefined
    ? { configPath: options.config }
    : { config })

  try {
    const progress = shouldEnableProgress(options, runIo)
      ? createCliProgressReporter({
          color: runIo.stderr.isTTY === true,
          columns: runIo.stderr.columns ?? 80,
          cwd,
          isTty: runIo.stderr.isTTY === true,
          rows: runIo.stderr.rows,
          write: chunk => runIo.stderr.write(chunk),
        })
      : undefined
    const restoreProgressConsole = progress
      ? interceptConsoleOutput({ write: progress.write })
      : undefined
    const visibleResult = (runResult: RunResult): RunResult => changedLines === undefined
      ? runResult
      : filterResultToChangedLines(runResult, { changedLines, cwd })
    const writeResult = (runResult: RunResult): void => {
      runIo.stdout.write(formatDiagnostics(options.format as ReporterName, visibleResult(runResult), {
        color: runIo.stdout.isTTY === true,
      }))
    }
    const targetSelection: SessionTargetSelection = targets === undefined
      ? { inputs: files }
      : { targets }
    let result: RunResult

    try {
      result = await executeLint({
        ...targetSelection,
        cacheOnly: options.cacheOnly,
        io: runIo,
        modelOverride: options.model,
        outputLanguage: options.outputLanguage,
        progress: progress?.reporter,
        ruleFilter: resolveRuleFilter(options.rule),
        runnerOptions: options,
        session,
        signal,
      })
    }
    catch (error) {
      if (error instanceof NoFilesFoundError) {
        runIo.stderr.write(`${error.message}\n`)
        return 2
      }

      if (error instanceof AlintCachePersistenceError) {
        writeResult(error.result)
        const message = errorMessageFrom(error.cause) ?? error.message
        runIo.stderr.write(`Cache persistence failed: ${message}\n`)
        return 1
      }

      if (error instanceof AlintRunError) {
        writeResult(error.result)
        runIo.stderr.write(formatRunError(error, runIo.stderr.isTTY === true))
        return 2
      }

      if (error instanceof AlintRunCancelledError) {
        writeResult(error.result)
        runIo.stderr.write(formatCancelledError(error, runIo.stderr.isTTY === true))
        return 2
      }

      throw error
    }
    finally {
      restoreProgressConsole?.()
      progress?.dispose()
    }

    writeResult(result)
    return visibleResult(result).diagnostics.some(diagnostic => diagnostic.severity === 'error') ? 1 : 0
  }
  finally {
    await session.shutdown()
  }
}

function shouldEnableProgress(options: LintCommandOptions, io: CliIo): boolean {
  if (options.progress !== undefined)
    return options.progress

  return options.format === 'stylish' && io.stderr.isTTY === true
}

import type { RunResult } from '@alint-js/core'

import type { ReporterName } from '../../reporters'
import type { CliIo } from '../../types'

import { readFile } from 'node:fs/promises'

import { errorMessageFrom } from '@moeru/std'
import { resolve } from 'pathe'

import { formatDiagnostics } from '../../reporters'
import { defineCommand } from '../command'

interface OutputInspectOptions {
  format: ReporterName
}

export const inspect = defineCommand({
  action: (context, file: string, options: OutputInspectOptions) =>
    inspectOutputFile(context.io, file, options),
  arguments: '<file>',
  description: 'Inspect saved alint JSON output',
  examples: [
    [
      '# Pretty-print saved JSON output',
      'alint output inspect alint-output.json',
    ].join('\n'),
    [
      '# Validate and reprint normalized JSON',
      'alint output inspect alint-output.json --format json',
    ].join('\n'),
    [
      '# Save a run as JSON, then inspect it later',
      'alint --format json src > alint-output.json',
      'alint output inspect alint-output.json',
    ].join('\n'),
  ],
  help: [
    'Read a saved alint JSON run result and render it with a reporter.',
    'Defaults to the human-friendly stylish reporter, which groups diagnostics by file and prints the same summary style as a normal alint run. Use `--format json` to validate the file and reprint normalized JSON.',
  ].join('\n\n'),
  name: 'inspect',
  options: [
    {
      config: { default: 'stylish' },
      description: 'Reporter used to render the parsed run result. One of: stylish, json',
      flags: '-f, --format <format>',
    },
  ],
})

async function inspectOutputFile(
  io: CliIo,
  file: string,
  options: OutputInspectOptions,
): Promise<number> {
  const filePath = resolve(io.cwd, file)
  let text: string

  try {
    text = await readFile(filePath, 'utf8')
  }
  catch (error) {
    io.stderr.write(`Could not read output file "${file}": ${errorMessageFrom(error)}\n`)
    return 2
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  }
  catch (error) {
    io.stderr.write(`Could not parse output file "${file}": ${errorMessageFrom(error)}\n`)
    return 2
  }

  if (!isRunResult(parsed)) {
    io.stderr.write(`Invalid alint output "${file}": expected a run result with diagnostics and usage.\n`)
    return 2
  }

  try {
    io.stdout.write(formatDiagnostics(options.format, parsed, {
      color: io.stdout.isTTY === true,
    }))
  }
  catch (error) {
    io.stderr.write(`${errorMessageFrom(error)}\n`)
    return 2
  }

  return parsed.diagnostics.some(diagnostic => diagnostic.severity === 'error')
    ? 1
    : 0
}

function isDiagnostic(value: unknown): boolean {
  if (!isRecord(value))
    return false

  if (
    typeof value.filePath !== 'string'
    || typeof value.message !== 'string'
    || typeof value.ruleId !== 'string'
    || (value.severity !== 'warn' && value.severity !== 'error')
  ) {
    return false
  }

  if (value.loc === undefined)
    return true

  if (!isRecord(value.loc))
    return false

  if (value.loc.start === undefined)
    return true

  if (!isRecord(value.loc.start))
    return false

  return (
    (value.loc.start.line === undefined || typeof value.loc.start.line === 'number')
    && (value.loc.start.column === undefined || typeof value.loc.start.column === 'number')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRunResult(value: unknown): value is RunResult {
  if (!isRecord(value))
    return false

  if (!Array.isArray(value.diagnostics) || !value.diagnostics.every(isDiagnostic))
    return false

  return isUsage(value.usage)
}

function isUsage(value: unknown): boolean {
  return isRecord(value)
    && typeof value.inputTokens === 'number'
    && typeof value.outputTokens === 'number'
    && Array.isArray(value.records)
    && typeof value.totalTokens === 'number'
}

import type { RunResult } from '@alint-js/core'

import type { CliIo } from '../../types'

import { readFile } from 'node:fs/promises'

import { errorMessageFrom } from '@moeru/std'
import { resolve } from 'pathe'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads saved `alint --format json` output. Reports the failure on stderr and returns `undefined`. */
export async function readRunResult(io: CliIo, file: string): Promise<RunResult | undefined> {
  const filePath = resolve(io.cwd, file)
  let text: string

  try {
    text = await readFile(filePath, 'utf8')
  }
  catch (error) {
    io.stderr.write(`Could not read output file "${file}": ${errorMessageFrom(error)}\n`)
    return undefined
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  }
  catch (error) {
    io.stderr.write(`Could not parse output file "${file}": ${errorMessageFrom(error)}\n`)
    return undefined
  }

  if (!isRunResult(parsed)) {
    io.stderr.write(`Invalid alint output "${file}": expected a run result with diagnostics and usage.\n`)
    return undefined
  }

  return parsed
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

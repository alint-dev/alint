import process from 'node:process'

import { Buffer } from 'node:buffer'
import { chmodSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { errorMessageFrom } from '@moeru/std'

const budgetBytes = 10 * 1024 * 1024
const directory = join(tmpdir(), 'alint-stop-gate', 'fatal')
const terminalPunctuation = /[.!?]$/u
const truncationMarker = '\nNOTICE: fatal diagnostic truncated to fit the 10 MiB budget.\n'

export interface FatalDiagnosticResult {
  cleanupError?: string
  path?: string
  writeError?: string
}

export function reportFatalFailure(context: string, error: unknown): void {
  const detail = errorMessageFrom(error) ?? 'unknown error'
  const diagnostic = writeFatalDiagnostic(context, detail)
  const failureDetail = `${context}: ${detail}`
  const failure = `alint-plugin: Stop Gate hook runtime error. ${failureDetail}${terminalPunctuation.test(failureDetail)
    ? ''
    : '.'}`
  const writeError = diagnostic.writeError ?? 'unknown error'
  const guidance = diagnostic.path === undefined
    ? `The error diagnostic could not be saved: ${writeError}${terminalPunctuation.test(writeError)
      ? ''
      : '.'} Explain this failure to the user.`
    : `Read the error details at "${diagnostic.path}", then explain to the user how to fix the hook failure.${diagnostic.cleanupError === undefined
      ? ''
      : ` Old diagnostic cleanup also failed: ${diagnostic.cleanupError}${terminalPunctuation.test(diagnostic.cleanupError)
        ? ''
        : '.'}`}`

  writeSync(
    process.stderr.fd,
    `${failure}\n${guidance}\n`,
  )
  process.exitCode = 1
}

export function writeFatalDiagnostic(context: string, detail: string): FatalDiagnosticResult {
  const timestamp = new Date().toISOString()
  const fileName = `${timestamp.replaceAll(':', '-').replaceAll('.', '-')}-${process.pid}.log`
  const path = join(directory, fileName)

  try {
    // A malformed stdin payload can omit a trustworthy session id. The timestamp and process id
    // make a safe filename. The diagnostic does not store the raw hook input, which can contain secrets.
    mkdirSync(directory, { mode: 0o700, recursive: true })
    writeFileSync(path, diagnosticContent(timestamp, context, detail), {
      flag: 'wx',
      mode: 0o644,
    })
    chmodSync(path, 0o644)
  }
  catch (error) {
    return { writeError: errorMessageFrom(error) ?? 'unknown error' }
  }

  try {
    enforceBudget()
    return { path }
  }
  catch (error) {
    return {
      cleanupError: errorMessageFrom(error) ?? 'unknown error',
      path,
    }
  }
}

function diagnosticContent(timestamp: string, context: string, detail: string): Buffer {
  const content = Buffer.from(`timestamp: ${timestamp}\ncontext: ${context}\ndetail: ${detail}\n`)

  if (content.byteLength <= budgetBytes) {
    return content
  }

  const marker = Buffer.from(truncationMarker)
  return Buffer.concat([
    content.subarray(0, budgetBytes - marker.byteLength),
    marker,
  ])
}

function enforceBudget(): void {
  const diagnostics = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.log'))
    .map((entry) => {
      const path = join(directory, entry.name)
      const stats = statSync(path)
      return { mtimeMs: stats.mtimeMs, path, size: stats.size }
    })

  let total = diagnostics.reduce((sum, diagnostic) => sum + diagnostic.size, 0)

  // Fatal diagnostics have no session cleanup. Keep the newest evidence and limit the total size.
  for (const diagnostic of diagnostics.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
    if (total <= budgetBytes) {
      break
    }

    unlinkSync(diagnostic.path)
    total -= diagnostic.size
  }
}

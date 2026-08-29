#!/usr/bin/env node

import process from 'node:process'

import { executeCli } from '../cli'
import { bindInterruptSignal } from '../cli/runtime/interrupt'

const interrupt = bindInterruptSignal(process)

void executeCli(process.argv, {
  cwd: process.cwd(),
  stderr: process.stderr,
  stdin: process.stdin,
  stdout: process.stdout,
}, {
  signal: interrupt.signal,
}).then((exitCode) => {
  process.exitCode = exitCode
}).catch((error) => {
  process.stderr.write(`${formatError(error)}\n`)
  process.exitCode = 2
}).finally(() => {
  interrupt.dispose()
})

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

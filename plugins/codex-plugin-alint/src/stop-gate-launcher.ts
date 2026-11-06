#!/usr/bin/env node

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { writeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { errorMessageFrom } from '@moeru/std'

import { reportFatalFailure } from './fatal-diagnostic'

const stderrExcerptLimitBytes = 4 * 1024
const stderrTruncationMarker = '\n... child stderr truncated ...\n'
const childFatalPrefix = 'alint-plugin: Stop Gate hook runtime error.'

void run().catch((error) => {
  reportFatalFailure('Stop Gate launcher failed before starting its child process', error)
})

function createStderrExcerpt(): { append: (chunk: Buffer) => void, text: () => string } {
  const markerBytes = Buffer.byteLength(stderrTruncationMarker)
  const excerptBytes = stderrExcerptLimitBytes - markerBytes
  const headLimit = Math.ceil(excerptBytes / 2)
  const tailLimit = Math.floor(excerptBytes / 2)
  let head = Buffer.alloc(0)
  let tail = Buffer.alloc(0)
  let totalBytes = 0

  return {
    append(chunk) {
      totalBytes += chunk.byteLength
      let remaining = chunk

      if (head.byteLength < headLimit) {
        const headBytes = Math.min(headLimit - head.byteLength, remaining.byteLength)
        head = Buffer.concat([
          head,
          remaining.subarray(0, headBytes),
        ])
        remaining = remaining.subarray(headBytes)
      }

      if (remaining.byteLength > 0) {
        const nextTail = Buffer.concat([tail, remaining])
        tail = nextTail.subarray(Math.max(0, nextTail.byteLength - tailLimit))
      }
    },
    text() {
      if (totalBytes <= stderrExcerptLimitBytes) {
        return Buffer.concat([head, tail]).toString('utf8')
      }

      // The rolling byte windows can split a UTF-8 code point at either boundary. Remove only the
      // replacement characters introduced by those cuts; replacement characters inside stderr stay.
      const headText = head.toString('utf8').replace(/\uFFFD+$/u, '')
      const tailText = tail.toString('utf8').replace(/^\uFFFD+/u, '')
      return `${headText}${stderrTruncationMarker}${tailText}`
    },
  }
}

async function run(): Promise<void> {
  const hook = fileURLToPath(new URL('./stop-gate.mjs', import.meta.url))
  const child = spawn(process.execPath, [hook], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['inherit', 'inherit', 'pipe'],
  })
  const stderr = createStderrExcerpt()
  let forwardingError: string | undefined
  let spawnError: string | undefined

  child.stderr.on('data', (chunk: Buffer) => {
    stderr.append(chunk)

    try {
      writeSync(process.stderr.fd, chunk)
    }
    catch (error) {
      forwardingError ??= errorMessageFrom(error) ?? 'unknown error'
    }
  })

  const result = await new Promise<{ code: null | number, signal: NodeJS.Signals | null }>((resolve) => {
    child.once('error', (error) => {
      spawnError = errorMessageFrom(error) ?? 'unknown error'
    })
    child.once('close', (code, signal) => resolve({ code, signal }))
  })

  if (result.code === 0) {
    return
  }

  process.exitCode = 1
  const stderrText = stderr.text().trim()

  // The child runtime already persisted and explained failures it could observe. Avoid creating a
  // second diagnostic for the same failure; the launcher owns only the outer process boundary.
  if (stderrText.startsWith(childFatalPrefix)) {
    return
  }

  const details = [
    `exit code: ${result.code ?? 'none'}`,
    `signal: ${result.signal ?? 'none'}`,
    ...(spawnError === undefined
      ? []
      : [`spawn error: ${spawnError}`]),
    ...(forwardingError === undefined
      ? []
      : [`stderr forwarding error: ${forwardingError}`]),
    `stderr:\n${stderrText.length === 0
      ? '(none)'
      : stderrText}`,
  ]

  reportFatalFailure(
    'Stop Gate child process exited before returning a hook decision',
    new Error(details.join('\n')),
  )
}

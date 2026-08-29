import process from 'node:process'

// @ts-expect-error - stub/template file
import bindingPath from '__ALINT_OXC_BINDING__' with { type: 'file' }

import { errorMessageFrom } from '@moeru/std'

process.env.NAPI_RS_NATIVE_LIBRARY_PATH = bindingPath

// @ts-expect-error - stub/template file
const { executeCli } = await import('__ALINT_CLI_ENTRY__')
const controller = new AbortController()

/**
 * Aborts active binary CLI work when the process receives its first interrupt signal.
 *
 * Triggering workflow:
 *
 * `process.once('SIGINT' | 'SIGTERM')`
 *   -> `handleInterrupt`
 *     -> `AbortController.abort()`
 *       -> `executeCli` runtime signal
 *
 * Upstream:
 * - `process.once` dispatches `SIGINT` or `SIGTERM` to this handler.
 *
 * Downstream:
 * - Aborts the signal passed to `executeCli`, which the lint command passes to `runAlint`.
 */
function handleInterrupt(): void {
  controller.abort()
}

process.once('SIGINT', handleInterrupt)
process.once('SIGTERM', handleInterrupt)

void executeCli(process.argv, {
  cwd: process.cwd(),
  stderr: process.stderr,
  stdout: process.stdout,
}, {
  signal: controller.signal,
}).then((exitCode: number) => {
  process.exitCode = exitCode
}).catch((error: unknown) => {
  process.stderr.write(`${errorMessageFrom(error)}\n`)
  process.exitCode = 2
}).finally(() => {
  process.off('SIGINT', handleInterrupt)
  process.off('SIGTERM', handleInterrupt)
})

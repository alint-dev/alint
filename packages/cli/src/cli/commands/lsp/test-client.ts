import type {
  ClientCapabilities,
  InitializeParams,
  InitializeResult,
  PublishDiagnosticsParams,
  ResponseMessage,
} from 'vscode-languageserver'

import type { CliIo } from '../../types'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { PassThrough } from 'node:stream'

/**
 * One message from the connection. A server sends responses and notifications on one stream, so
 * this type includes both, and a test reads the field it expects.
 */
export interface JsonRpcMessage {
  // `ResponseErrorLiteral` is declared but not exported, so reach it through the exported message.
  error?: ResponseMessage['error']
  id?: number
  method?: string
  params?: PublishDiagnosticsParams
  result?: InitializeResult
}

export interface TestClient {
  io: CliIo
  receive: () => Promise<JsonRpcMessage>
  send: (message: object) => void
  stderrText: () => string
  stdoutText: () => string
}

const headerSeparator = '\r\n\r\n'

/**
 * Framed JSON-RPC client over an in-memory stream pair. No build entry imports it.
 *
 * NOTICE: do not end or destroy the stream given to the server. `createConnection` adds `end` and
 * `close` listeners that call `process.exit`, which stops the test worker.
 * `packages/cli/node_modules/vscode-languageserver/lib/node/main.js:219-229`
 */
export function createTestClient(env?: NodeJS.ProcessEnv, cwd = process.cwd()): TestClient {
  const clientToServer = new PassThrough()
  const queue: JsonRpcMessage[] = []
  const waiters: Array<(message: JsonRpcMessage) => void> = []
  let pending = Buffer.alloc(0)
  let stderrText = ''
  let stdoutText = ''

  const deliver = (): void => {
    while (true) {
      const headerEnd = pending.indexOf(headerSeparator)

      if (headerEnd === -1) {
        return
      }

      const header = pending.subarray(0, headerEnd).toString('ascii')
      const contentLength = Number(/content-length: *(\d+)/i.exec(header)?.[1])

      if (!Number.isInteger(contentLength)) {
        throw new TypeError(`Server wrote a frame without a Content-Length header: ${header}`)
      }

      const bodyStart = headerEnd + headerSeparator.length

      if (pending.length < bodyStart + contentLength) {
        return
      }

      const message = JSON.parse(
        pending.subarray(bodyStart, bodyStart + contentLength).toString('utf8'),
      ) as JsonRpcMessage
      pending = pending.subarray(bodyStart + contentLength)

      const waiter = waiters.shift()

      if (waiter) {
        waiter(message)
        continue
      }

      queue.push(message)
    }
  }

  return {
    io: {
      cwd,
      env,
      stderr: {
        write: (chunk) => {
          stderrText += chunk
          return true
        },
      },
      stdin: clientToServer,
      stdout: {
        write: (chunk) => {
          stdoutText += chunk
          pending = Buffer.concat([pending, Buffer.from(chunk, 'utf8')])
          deliver()
          return true
        },
      },
    },
    receive: () => new Promise<JsonRpcMessage>((resolve) => {
      const next = queue.shift()

      if (next) {
        resolve(next)
        return
      }

      waiters.push(resolve)
    }),
    send: (message) => {
      const body = JSON.stringify({ jsonrpc: '2.0', ...message })
      clientToServer.write(`Content-Length: ${Buffer.byteLength(body)}${headerSeparator}${body}`)
    },
    stderrText: () => stderrText,
    stdoutText: () => stdoutText,
  }
}

export function initializeParams(
  folderUris: string[] = [],
  capabilities: ClientCapabilities = {},
): InitializeParams {
  return {
    capabilities,
    // A number makes the server poll `process.kill(pid, 0)` every three seconds. LSP permits null
    // for a client that is not a separate process.
    processId: null,
    rootUri: null,
    workspaceFolders: folderUris.map(uri => ({ name: 'fixture', uri })),
  }
}

import type { CliIo } from './types'

import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

describe('cliIo', () => {
  it('carries a readable stream through stdin', async () => {
    // `alint lsp` reads framed JSON-RPC from this field. The type must accept a real stream, not
    // only a TTY flag. This test fails at `tsc`, not at run time.
    const stream = new PassThrough()
    const io: CliIo = {
      cwd: '/tmp',
      stderr: {
        write: () => true,
      },
      stdin: stream,
      stdout: {
        write: () => true,
      },
    }
    io.stdin?.setEncoding('utf8')

    const received = new Promise<string>((resolve) => {
      io.stdin?.once('data', (chunk: string) => resolve(chunk))
    })

    stream.write('Content-Length: 2\r\n\r\n{}')

    await expect(received).resolves.toBe('Content-Length: 2\r\n\r\n{}')
  })
})

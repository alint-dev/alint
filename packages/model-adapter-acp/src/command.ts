import type { Buffer } from 'node:buffer'
import type { ChildProcess } from 'node:child_process'

import type { GatewayModel } from './gateway'

import { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

import { ndJsonStream } from '@agentclientprotocol/sdk'
import { x } from 'tinyexec'

export interface CommandModelOptions {
  args?: string[]
  command: string
  cwd: string
  env?: NodeJS.ProcessEnv
  id: string
  name: string
  onStderr?: (text: string) => void
}

/** Creates a gateway model whose ACP connection is one CLI process per OpenAI request. */
export function createCommandModel(options: CommandModelOptions): GatewayModel {
  return {
    id: options.id,
    name: options.name,
    openConnection: () => openCommandConnection(options),
  }
}

/**
 * Releases the stdio observers and process owned by one command connection.
 *
 * Triggering workflow:
 *
 * {@link createGateway}
 *   -> `GatewayModelConnection.dispose`
 *     -> {@link disposeCommandConnection}
 *
 * Upstream:
 * - {@link openCommandConnection}
 *
 * Downstream:
 * - {@link stopProcess}
 */
async function disposeCommandConnection(
  child: ChildProcess,
  handleStderr: (chunk: Buffer | string) => void,
  terminate: () => boolean,
): Promise<void> {
  child.stderr?.off('data', handleStderr)
  child.stdin?.end()
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }

  const closed = waitForClose(child)
  terminate()
  if (await Promise.race([
    closed.then(() => true),
    delay(1_000, false),
  ])) {
    return
  }

  child.kill('SIGKILL')
  await closed
}

async function openCommandConnection(options: CommandModelOptions) {
  const execution = x(options.command, options.args ?? [], {
    nodeOptions: {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
    nodePath: false,
  })

  const child = execution.process

  if (!child?.stdin || !child.stdout || !child.stderr) {
    execution.kill()
    throw new Error(`ACP command "${options.command}" did not expose stdin, stdout, and stderr pipes.`)
  }

  const handleStderr: (chunk: Buffer | string) => void = (chunk) => {
    options.onStderr?.(chunk.toString())
  }

  child.stderr.on('data', handleStderr)

  // NOTICE: ACP's official client example also connects a spawned process by adapting its
  // stdio to Web streams before calling ndJsonStream.
  // `https://github.com/agentclientprotocol/typescript-sdk/blob/fa32570936b42bf4f3aef175c6e926860914b638/src/examples/client.ts#L105-L119`
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  )

  return {
    dispose: () => disposeCommandConnection(child, handleStderr, execution.kill.bind(execution)),
    kind: 'stream' as const,
    stream,
  }
}

function waitForClose(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }

    child.once('close', () => resolve())
  })
}

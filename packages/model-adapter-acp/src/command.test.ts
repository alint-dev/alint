import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createCommandModel, startGateway } from './index'

describe('aCP command gateway', () => {
  // https://github.com/moeru-ai/alint/actions/runs/33186281219/job/98899997470?pr=87
  it('serves a tinyexec-started ACP command and waits for cleanup on shutdown', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-acp-command-'))
    const processCwd = await realpath(cwd)
    const agentPath = join(cwd, 'agent.mjs')
    const stoppedPath = join(cwd, 'stopped.txt')
    const sdkUrl = import.meta.resolve('@agentclientprotocol/sdk')

    await writeFile(agentPath, `
import { writeFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from ${JSON.stringify(sdkUrl)}

process.on('exit', () => writeFileSync(${JSON.stringify(stoppedPath)}, 'stopped'))
// Keep cleanup active long enough for gateway shutdown to observe and await it.
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 100))

agent({ name: 'command-agent' })
  .onRequest(methods.agent.initialize, () => ({
    agentCapabilities: { loadSession: false },
    protocolVersion: PROTOCOL_VERSION,
  }))
  .onRequest(methods.agent.session.new, () => ({ sessionId: crypto.randomUUID() }))
  .onRequest(methods.agent.session.prompt, async ({ client, params }) => {
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        content: { text: process.cwd() + ':' + process.env.ALINT_AGENT_PROFILE, type: 'text' },
        sessionUpdate: 'agent_message_chunk',
      },
    })
    return { stopReason: 'end_turn' }
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
`, 'utf8')

    const gateway = await startGateway({
      cwd,
      models: [createCommandModel({
        args: [agentPath],
        command: process.execPath,
        cwd,
        env: { ALINT_AGENT_PROFILE: 'review' },
        id: 'command-reviewer',
        name: 'Command Reviewer',
      })],
    })

    try {
      const response = await fetch(new URL('chat/completions', gateway.endpoint), {
        body: JSON.stringify({
          messages: [{ content: 'Review.', role: 'user' }],
          model: 'command-reviewer',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        choices: [{ message: { content: `${processCwd}:review` } }],
      })
    }
    finally {
      await gateway.shutdown()
    }

    // ROOT CAUSE:
    //
    // The test previously recorded only SIGTERM, but the ACP stream can end the command through
    // stdin EOF first. The exit hook observes both graceful paths and still rejects SIGKILL.
    await expect(readFile(stoppedPath, 'utf8')).resolves.toBe('stopped')
  })

  it.skipIf(!process.env.ALINT_ACP_E2E_COMMAND)('connects to a configured real ACP coding-agent CLI', async () => {
    const command = process.env.ALINT_ACP_E2E_COMMAND

    if (!command) {
      throw new Error('ALINT_ACP_E2E_COMMAND is required for this integration test.')
    }

    const args = parseIntegrationArgs(process.env.ALINT_ACP_E2E_ARGS_JSON)
    const gateway = await startGateway({
      models: [createCommandModel({
        args,
        command,
        cwd: process.cwd(),
        env: process.env,
        id: 'real-agent',
        name: 'Real ACP Agent',
      })],
    })

    try {
      const response = await fetch(new URL('chat/completions', gateway.endpoint), {
        body: JSON.stringify({
          messages: [{
            content: 'Reply with exactly ALINT_ACP_OK. Do not call tools or modify files.',
            role: 'user',
          }],
          model: 'real-agent',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal: AbortSignal.timeout(120_000),
      })

      expect(response.status).toBe(200)
      expect(JSON.stringify(await response.json())).toContain('ALINT_ACP_OK')
    }
    finally {
      await gateway.shutdown()
    }
  }, 130_000)
})

function parseIntegrationArgs(value: string | undefined): string[] {
  if (value === undefined) {
    return []
  }

  const parsed: unknown = JSON.parse(value)

  if (!Array.isArray(parsed) || !parsed.every(argument => typeof argument === 'string')) {
    throw new TypeError('ALINT_ACP_E2E_ARGS_JSON must be a JSON array of strings.')
  }

  return parsed
}

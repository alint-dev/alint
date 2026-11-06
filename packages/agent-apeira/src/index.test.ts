import type { ResolvedModel } from '@alint-js/core'
import type { AgentRequest, AgentTool } from '@alint-js/core/agent'
import type { RunnerContext } from 'apeira'

import { RetryableAgentError } from '@alint-js/core/agent'
import { describe, expect, it } from 'vitest'

import { createApeiraAdapter, toRunnerTools } from './index'

function createRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    instructions: 'system prompt',
    model: fakeModel(),
    prompt: 'find duplicate helpers',
    tools: [],
    ...overrides,
  }
}

function fakeModel(): ResolvedModel {
  return {
    aliases: [],
    capabilities: [],
    id: 'test-model',
    name: 'Test Model',
    params: {},
    provider: {
      endpoint: 'http://localhost:11434/v1',
      headers: {},
      id: 'test-provider',
      type: 'openai-compatible',
    },
  }
}

describe('apeira adapter', () => {
  it.each([0, -1, 1.5])('rejects an invalid maximum step count: %s', (maxSteps) => {
    expect(() => createApeiraAdapter({ maxSteps })).toThrow(TypeError)
  })

  it('returns the final assistant message as the answer', async () => {
    const adapter = createApeiraAdapter({
      createRunner: () => async () => ({
        output: [
          { content: 'dup of clamp()', role: 'assistant', type: 'message' },
        ],
        toolCalls: [],
        usage: undefined,
      }),
    })

    const result = await adapter({
      instructions: 'system prompt',
      model: fakeModel(),
      prompt: 'find duplicate helpers',
      tools: [],
    })

    expect(result.answer).toBe('dup of clamp()')
  })

  it('maps the runner usage onto the result', async () => {
    const adapter = createApeiraAdapter({
      createRunner: () => async () => ({
        output: [
          { content: 'done', role: 'assistant', type: 'message' },
        ],
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }),
    })

    const result = await adapter({
      instructions: 'system prompt',
      model: fakeModel(),
      prompt: 'find duplicate helpers',
      tools: [],
    })

    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
  })

  it('passes instructions, prompt, and translated tools to the runner', async () => {
    let captured: RunnerContext | undefined
    const controller = new AbortController()

    const grepTool: AgentTool = {
      description: 'search the repo',
      execute: () => 'matches',
      name: 'grep',
      parameters: { properties: {}, type: 'object' },
    }

    const adapter = createApeiraAdapter({
      createRunner: () => async (context) => {
        captured = context
        return {
          output: [
            { content: 'ok', role: 'assistant', type: 'message' },
          ],
          toolCalls: [],
          usage: undefined,
        }
      },
    })

    await adapter({
      instructions: 'be careful',
      model: fakeModel(),
      prompt: 'find duplicates',
      signal: controller.signal,
      tools: [grepTool],
    })

    expect(captured?.abortSignal).toBe(controller.signal)
    expect(captured?.instructions).toBe('be careful')
    expect(JSON.stringify(captured?.input)).toContain('find duplicates')
    expect(captured?.tools.map(tool => tool.function.name)).toEqual(['grep'])
  })

  it.each([408, 429, 500, 503, 599])(
    'marks a pre-tool HTTP %s failure as safe to replay',
    async (statusCode) => {
      const providerError = Object.assign(new Error('provider failed'), { statusCode })
      const adapter = createApeiraAdapter({
        createRunner: () => async () => {
          throw providerError
        },
      })

      try {
        await adapter(createRequest())
        expect.fail('expected the adapter to reject')
      }
      catch (error) {
        expect(error).toBeInstanceOf(RetryableAgentError)
        expect((error as RetryableAgentError).cause).toBe(providerError)
      }
    },
  )

  it('preserves an unsupported wrapped transport failure', async () => {
    const transportError = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })
    const providerError = new TypeError('fetch failed', { cause: transportError })
    const adapter = createApeiraAdapter({
      createRunner: () => async () => {
        throw providerError
      },
    })

    await expect(adapter(createRequest())).rejects.toBe(providerError)
  })

  it('preserves an outer HTTP failure when its cause is an AbortError', async () => {
    const abortError = new Error('aborted')
    abortError.name = 'AbortError'
    const providerError = Object.assign(new Error('provider failed', { cause: abortError }), { statusCode: 500 })
    const adapter = createApeiraAdapter({
      createRunner: () => async () => {
        throw providerError
      },
    })

    await expect(adapter(createRequest())).rejects.toBe(providerError)
  })

  it.each([400, 401, 403])('preserves a non-retryable HTTP %s failure', async (statusCode) => {
    const providerError = Object.assign(new Error('request rejected'), { statusCode })
    const adapter = createApeiraAdapter({
      createRunner: () => async () => {
        throw providerError
      },
    })

    await expect(adapter(createRequest())).rejects.toBe(providerError)
  })

  it('preserves a retry-shaped failure after a tool starts', async () => {
    const providerError = Object.assign(new Error('provider failed'), { statusCode: 500 })
    let toolCalls = 0
    const adapter = createApeiraAdapter({
      createRunner: () => async (context) => {
        await context.tools[0].execute({}, { messages: [], toolCallId: 'call-1' })
        throw providerError
      },
    })

    await expect(adapter(createRequest({
      tools: [
        {
          description: 'record a finding',
          execute: () => {
            toolCalls += 1
            return 'recorded'
          },
          name: 'report_finding',
          parameters: { properties: {}, type: 'object' },
        },
      ],
    }))).rejects.toBe(providerError)
    expect(toolCalls).toBe(1)
  })

  it('preserves a retry-shaped failure thrown by tool execution', async () => {
    const toolError = Object.assign(new Error('tool transport failed'), { statusCode: 500 })
    const adapter = createApeiraAdapter({
      createRunner: () => async (context) => {
        await context.tools[0].execute({}, { messages: [], toolCallId: 'call-1' })
        throw new Error('unreachable')
      },
    })

    await expect(adapter(createRequest({
      tools: [
        {
          description: 'query a service',
          execute: () => {
            throw toolError
          },
          name: 'query_service',
          parameters: { properties: {}, type: 'object' },
        },
      ],
    }))).rejects.toBe(toolError)
  })

  it('forwards the caller signal to the runner context', async () => {
    const controller = new AbortController()
    let capturedSignal: AbortSignal | undefined
    const adapter = createApeiraAdapter({
      createRunner: () => async (context) => {
        capturedSignal = context.abortSignal
        return {
          output: [
            { content: 'ok', role: 'assistant', type: 'message' },
          ],
          toolCalls: [],
          usage: undefined,
        }
      },
    })

    await adapter(createRequest({ signal: controller.signal }))

    expect(capturedSignal).toBe(controller.signal)
  })

  it('preserves a retry-shaped failure when the caller signal is already aborted', async () => {
    const controller = new AbortController()
    const providerError = Object.assign(new Error('provider failed'), { statusCode: 500 })
    controller.abort(new Error('stop'))
    const adapter = createApeiraAdapter({
      createRunner: () => async () => {
        throw providerError
      },
    })

    await expect(adapter(createRequest({ signal: controller.signal }))).rejects.toBe(providerError)
  })
})

describe('apeira tool translation', () => {
  it('runs the underlying AgentTool.execute and returns its result', async () => {
    const calls: unknown[] = []
    const agentTool: AgentTool = {
      description: 'search the repo',
      execute: (input) => {
        calls.push(input)

        return 'matches'
      },
      name: 'grep',
      parameters: { properties: {}, type: 'object' },
    }

    const [runnerTool] = toRunnerTools([agentTool])

    expect(runnerTool.function.name).toBe('grep')

    const result = await runnerTool.execute({ query: 'clamp' }, { messages: [], toolCallId: 'call-1' })

    expect(calls).toEqual([
      { query: 'clamp' },
    ])
    expect(result).toBe('matches')
  })

  it('coerces an undefined tool result to an empty string', async () => {
    const agentTool: AgentTool = {
      description: 'record a finding',
      execute: () => undefined,
      name: 'report_finding',
      parameters: { properties: {}, type: 'object' },
    }

    const [runnerTool] = toRunnerTools([agentTool])
    const result = await runnerTool.execute({}, { messages: [], toolCallId: 'call-1' })

    expect(result).toBe('')
  })
})

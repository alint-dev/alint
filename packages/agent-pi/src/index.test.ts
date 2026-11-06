import type { ResolvedModel } from '@alint-js/core'
import type { AgentRequest, AgentTool } from '@alint-js/core/agent'

import { RetryableAgentError } from '@alint-js/core/agent'
import { describe, expect, it } from 'vitest'

import { apiKeyFromModel, createPiAdapter, extractPiText, toPiTools } from './index'

function fakeModel(headers: Record<string, string>): ResolvedModel {
  return {
    aliases: [],
    capabilities: [],
    id: 'gpt-4o-mini',
    name: 'gpt-4o-mini',
    params: {},
    provider: {
      endpoint: 'https://api.openai.com/v1',
      headers,
      id: 'openai',
      type: 'openai-compatible',
    },
  }
}

function fakeRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    instructions: 'Review the code.',
    model: fakeModel({}),
    prompt: 'Find bugs.',
    tools: [],
    ...overrides,
  }
}

describe('pi adapter', () => {
  it('returns the final assistant text', async () => {
    const adapter = createPiAdapter({
      run: async () => [
        { content: 'first', role: 'assistant' },
        {
          content: [
            { text: 'final', type: 'text' },
          ],
          role: 'assistant',
        },
      ],
    })

    await expect(adapter(fakeRequest())).resolves.toEqual({ answer: 'final', usage: undefined })
  })

  it('marks an assistant error before tools as safe to retry', async () => {
    const adapter = createPiAdapter({
      run: async () => [
        { errorMessage: 'provider failed', role: 'assistant', stopReason: 'error' },
      ],
    })

    const error = await adapter(fakeRequest()).catch(error => error)

    expect(error).toBeInstanceOf(RetryableAgentError)
    expect(error.cause).toBeInstanceOf(Error)
    expect(error.cause.message).toBe('provider failed')
  })

  it('marks an aborted assistant result before tools as safe to retry', async () => {
    const controller = new AbortController()
    const adapter = createPiAdapter({
      run: async () => [
        { errorMessage: 'request aborted', role: 'assistant', stopReason: 'aborted' },
      ],
    })

    const error = await adapter(fakeRequest({ signal: controller.signal })).catch(error => error)

    expect(error).toBeInstanceOf(RetryableAgentError)
    expect(error.cause).toBeInstanceOf(Error)
    expect(error.cause.message).toBe('request aborted')
  })

  it('preserves an assistant error after a tool starts', async () => {
    let toolCalls = 0
    const adapter = createPiAdapter({
      run: async (request) => {
        await request.tools[0].execute({ query: 'retry' })
        return [
          { errorMessage: 'provider failed', role: 'assistant', stopReason: 'error' },
        ]
      },
    })

    const error = await adapter(fakeRequest({
      tools: [
        {
          description: 'Search the repository.',
          execute: () => {
            toolCalls += 1
            return 'matches'
          },
          name: 'search',
          parameters: { type: 'object' },
        },
      ],
    })).catch(error => error)

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(RetryableAgentError)
    expect(error.message).toBe('provider failed')
    expect(toolCalls).toBe(1)
  })

  it('marks a thrown error before tools as safe to retry', async () => {
    const cause = new Error('connection closed')
    const adapter = createPiAdapter({
      run: async () => { throw cause },
    })

    const error = await adapter(fakeRequest()).catch(error => error)

    expect(error).toBeInstanceOf(RetryableAgentError)
    expect(error.cause).toBe(cause)
  })

  it('preserves a pre-aborted request without invoking pi', async () => {
    const reason = new Error('cancelled')
    const controller = new AbortController()
    let calls = 0
    controller.abort(reason)
    const adapter = createPiAdapter({
      run: async () => {
        calls += 1
        return []
      },
    })

    await expect(adapter(fakeRequest({ signal: controller.signal }))).rejects.toBe(reason)
    expect(calls).toBe(0)
  })
})

describe('pi adapter helpers', () => {
  it('joins the text parts of an assistant message', () => {
    const text = extractPiText({
      content: [
        { text: 'clampValue ', type: 'text' },
        { text: 'duplicates clamp', type: 'text' },
      ],
      role: 'assistant',
    })

    expect(text).toBe('clampValue duplicates clamp')
  })

  it('translates an AgentTool into a pi tool that wraps the result as text content', async () => {
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

    const [piTool] = toPiTools([agentTool])

    expect(piTool.name).toBe('grep')

    const result = await piTool.execute('call-1', { query: 'clamp' })

    expect(calls).toEqual([
      { query: 'clamp' },
    ])
    expect(result.content).toEqual([
      { text: 'matches', type: 'text' },
    ])
  })
})

describe('apiKeyFromModel', () => {
  it('extracts the bearer token from the provider Authorization header', () => {
    expect(apiKeyFromModel(fakeModel({ Authorization: 'Bearer sk-test-123' }))).toBe('sk-test-123')
  })

  it('falls back to a placeholder when there is no auth header', () => {
    expect(apiKeyFromModel(fakeModel({}))).toBe('unused')
  })
})

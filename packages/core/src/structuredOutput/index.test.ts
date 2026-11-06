import type { Buffer } from 'node:buffer'
import type { AddressInfo } from 'node:net'

import type { ResolvedModel } from '../models/types'

import { createServer } from 'node:http'

import { array, description, number, object, optional, picklist, pipe, string } from 'valibot'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { formatOutputLanguageInstruction, formatSourceWithLineNumbers, generateStructured, InvalidStructuredOutputError, toolParametersFromSchema } from './index'

const findingSchema = object({
  line: number(),
  message: string(),
  severity: picklist(['warn', 'error']),
})

const responseSchema = pipe(
  object({
    findings: array(findingSchema),
  }),
  description('Report findings for this file.'),
)

/** `delayMs` holds the response open so a test can cancel a request that is still in flight. */
interface QueuedResponse { body: unknown, delayMs?: number, status?: number }

interface RecordedRequest {
  body: Record<string, unknown>
  url: string
}

let baseURL: string
let close: () => Promise<void>
let requests: RecordedRequest[]
let responses: QueuedResponse[]

beforeEach(async () => {
  requests = []
  responses = []

  const pendingTimers = new Set<ReturnType<typeof setTimeout>>()

  const server = createServer((request, response) => {
    let payload = ''
    request.on('data', (chunk: Buffer) => {
      payload += chunk.toString()
    })
    request.on('end', () => {
      requests.push({
        body: JSON.parse(payload) as Record<string, unknown>,
        url: request.url ?? '',
      })

      const next = responses.shift() ?? { body: {}, status: 500 }
      const send = (): void => {
        // A cancelled client destroys the socket, so a delayed reply can arrive with nothing
        // left to write to.
        if (response.destroyed) {
          return
        }

        response.writeHead(next.status ?? 200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(next.body))
      }

      if (next.delayMs === undefined) {
        send()
        return
      }

      const timer = setTimeout(() => {
        pendingTimers.delete(timer)
        send()
      }, next.delayMs)

      pendingTimers.add(timer)
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  close = async () => {
    for (const timer of pendingTimers) {
      clearTimeout(timer)
    }

    pendingTimers.clear()

    return new Promise((resolve, reject) => server.close(error => error
      ? reject(error)
      : resolve()))
  }
})

afterEach(async () => {
  await close()
})

function createOptions() {
  return {
    createMessages: (retryFeedback?: string) => [
      { content: 'You are a judge.', role: 'system' as const },
      ...(retryFeedback
        ? [
            { content: retryFeedback, role: 'user' as const },
          ]
        : []),
      { content: 'Review this file.', role: 'user' as const },
    ],
    model: createResolvedModel(),
    operation: 'test-judge',
    retryDelay: () => 0,
    schema: responseSchema,
  }
}

function createResolvedModel(): ResolvedModel {
  return {
    aliases: [],
    capabilities: ['tool-call'],
    id: 'test-model',
    name: 'test-model',
    params: {},
    provider: {
      endpoint: baseURL,
      headers: {},
      id: 'test-provider',
      type: 'openai-compatible',
    },
  }
}

function textCompletion(finishReason: string): unknown {
  return {
    choices: [
      {
        finish_reason: finishReason,
        message: {
          content: 'not a tool call',
          role: 'assistant',
        },
      },
    ],
    usage: { completion_tokens: 3, prompt_tokens: 7, total_tokens: 10 },
  }
}

function toolCallCompletion(args: unknown): unknown {
  return {
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: null,
          role: 'assistant',
          tool_calls: [
            {
              function: {
                arguments: typeof args === 'string'
                  ? args
                  : JSON.stringify(args),
                name: 'reportFindings',
              },
              id: 'call_1',
              type: 'function',
            },
          ],
        },
      },
    ],
    usage: { completion_tokens: 5, prompt_tokens: 11, total_tokens: 16 },
  }
}

const validPayload = {
  findings: [
    { line: 3, message: 'Split this function.', severity: 'warn' },
  ],
}

describe('generateStructured', () => {
  it('returns the parsed structured result from a forced tool call', async () => {
    responses.push({
      body: toolCallCompletion(validPayload),
    })

    const result = await generateStructured(createOptions())

    expect(result).toEqual(validPayload)
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/v1/chat/completions')
  })

  // Regression test for https://github.com/moeru-ai/alint/issues/75
  it('consumes a pending tool call that xsAI does not execute (Issue #75)', async () => {
    // xsAI beta.8 checks stopWhen before executing tools, so the forced `reportFindings`
    // call comes back as a pending `toolCalls` entry with empty `toolResults`. The
    // arguments still are the structured output and must be consumed without a follow-up
    // request.
    responses.push({
      body: toolCallCompletion(validPayload),
    })

    const result = await generateStructured(createOptions())

    expect(result).toEqual(validPayload)
    expect(requests).toHaveLength(1)
  })

  describe('signal', () => {
    it('does not call the model when the signal is already aborted', async () => {
      responses.push({
        body: toolCallCompletion(validPayload),
      })

      const controller = new AbortController()
      controller.abort()

      await expect(generateStructured({
        ...createOptions(),
        signal: controller.signal,
      }))
        .rejects
        .toMatchObject({ name: 'AbortError' })
      expect(requests).toHaveLength(0)
    })

    it('cancels a pending retry backoff instead of firing another model call', async () => {
      // A 503 is retriable, so without an abortable backoff the retry would wake up after the
      // delay and spend another call on a run the caller already cancelled.
      responses.push({ body: {}, status: 503 })

      const controller = new AbortController()
      const pending = generateStructured({
        ...createOptions(),
        retryDelay: () => 10_000,
        signal: controller.signal,
      })

      // Let the first call fail and the backoff start before cancelling.
      await vi.waitFor(() => expect(requests).toHaveLength(1))
      controller.abort()

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      expect(requests).toHaveLength(1)
    })

    it('forwards the signal to the model call so an in-flight request is cancelled', async () => {
      // The server holds the reply open. Without `abortSignal` reaching the HTTP call, this
      // request would run to completion and return findings for a run the caller cancelled.
      responses.push({
        body: toolCallCompletion(validPayload),
        delayMs: 10_000,
      })

      const controller = new AbortController()
      const pending = generateStructured({
        ...createOptions(),
        signal: controller.signal,
      })

      await vi.waitFor(() => expect(requests).toHaveLength(1))
      controller.abort()

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    })
  })

  it('forces a single tool call with the normalized schema as parameters', async () => {
    responses.push({
      body: toolCallCompletion(validPayload),
    })

    await generateStructured(createOptions())

    const body = requests[0].body
    expect(body.model).toBe('test-model')
    expect(body.temperature).toBe(0)
    expect(body.parallel_tool_calls).toBe(false)
    expect(body.tool_choice).toEqual({
      function: { name: 'reportFindings' },
      type: 'function',
    })

    const tools = body.tools as [{ function: { description: string, name: string, parameters: Record<string, unknown>, strict: boolean } }]
    expect(tools).toHaveLength(1)
    expect(tools[0].function.name).toBe('reportFindings')
    expect(tools[0].function.strict).toBe(true)
    expect(tools[0].function.description).toBe('Report findings for this file.')
    expect(tools[0].function.parameters.additionalProperties).toBe(false)
    expect(tools[0].function.parameters.required).toEqual(['findings'])
  })

  it('records usage for each attempt with the operation metadata', async () => {
    responses.push({
      body: toolCallCompletion(validPayload),
    })
    const records: unknown[] = []

    await generateStructured({
      ...createOptions(),
      metering: {
        recordUsage: record => records.push(record),
      },
    })

    expect(records).toEqual([
      {
        inputTokens: 11,
        metadata: { operation: 'test-judge' },
        modelId: 'test-model',
        outputTokens: 5,
        providerId: 'test-provider',
        totalTokens: 16,
      },
    ])
  })

  it('retries with validation feedback after an invalid tool payload', async () => {
    responses.push({
      body: toolCallCompletion({
        findings: [
          { line: 'three' },
        ],
      }),
    })
    responses.push({
      body: toolCallCompletion(validPayload),
    })

    const result = await generateStructured(createOptions())

    expect(result).toEqual(validPayload)
    expect(requests).toHaveLength(2)

    const retryMessages = requests[1].body.messages as { content: string, role: string }[]
    expect(retryMessages[1].role).toBe('user')
    expect(retryMessages[1].content).toContain('Your previous tool call could not be validated.')
    expect(retryMessages[1].content).toContain('Validation error:')
    expect(retryMessages[1].content).toContain('Call reportFindings again with arguments that exactly match the tool schema.')
  })

  it('retries when the tool call arguments are not valid JSON', async () => {
    responses.push({
      body: toolCallCompletion('{ not json'),
    })
    responses.push({
      body: toolCallCompletion(validPayload),
    })

    const result = await generateStructured(createOptions())

    expect(result).toEqual(validPayload)
    expect(requests).toHaveLength(2)

    const retryMessages = requests[1].body.messages as { content: string, role: string }[]
    expect(retryMessages[1].content).toContain('Tool call failed before validation:')
  })

  it('retries when the forced tool call is missing from the response', async () => {
    responses.push({
      body: textCompletion('stop'),
    })
    responses.push({
      body: toolCallCompletion(validPayload),
    })

    const result = await generateStructured(createOptions())

    expect(result).toEqual(validPayload)
    expect(requests).toHaveLength(2)

    const retryMessages = requests[1].body.messages as { content: string, role: string }[]
    expect(retryMessages[1].content).toContain('Missing reportFindings tool result')
  })

  it('retries when the model response is truncated by length', async () => {
    responses.push({
      body: textCompletion('length'),
    })
    responses.push({
      body: toolCallCompletion(validPayload),
    })

    const result = await generateStructured(createOptions())

    expect(result).toEqual(validPayload)
    expect(requests).toHaveLength(2)
  })

  it('throws InvalidStructuredOutputError once attempts are exhausted', async () => {
    responses.push({
      body: toolCallCompletion({
        findings: [{}],
      }),
    })
    responses.push({
      body: toolCallCompletion({
        findings: [{}],
      }),
    })

    await expect(generateStructured({
      ...createOptions(),
      maxAttempts: 2,
    }))
      .rejects
      .toThrow(InvalidStructuredOutputError)
    expect(requests).toHaveLength(2)
  })

  it('does not retry when the model finishes with content_filter', async () => {
    responses.push({
      body: textCompletion('content_filter'),
    })

    await expect(generateStructured(createOptions()))
      .rejects
      .toThrow(InvalidStructuredOutputError)
    expect(requests).toHaveLength(1)
  })

  it.each([408, 429, 500, 599])('retries transient HTTP status %i', async (status) => {
    responses.push({
      body: { error: 'retry me' },
      status,
    })
    responses.push({
      body: toolCallCompletion(validPayload),
    })

    const result = await generateStructured(createOptions())

    expect(result).toEqual(validPayload)
    expect(requests).toHaveLength(2)
    expect(requests[1].body.messages).toEqual(requests[0].body.messages)
  })

  it('propagates other HTTP errors without retrying', async () => {
    responses.push({
      body: { error: 'forbidden' },
      status: 403,
    })

    await expect(generateStructured(createOptions())).rejects.toThrow()
    expect(requests).toHaveLength(1)
  })
})

describe('formatSourceWithLineNumbers', () => {
  it('prefixes every line with its 1-based line number', () => {
    expect(formatSourceWithLineNumbers('alpha\nbeta\n')).toBe('1 | alpha\n2 | beta\n3 | ')
  })
})

describe('formatOutputLanguageInstruction', () => {
  it('returns the instruction for a configured language', () => {
    expect(formatOutputLanguageInstruction('Portuguese'))
      .toBe('Write all human-readable finding messages and suggestions in this language: Portuguese.')
  })

  it('returns undefined when no language is configured', () => {
    expect(formatOutputLanguageInstruction(undefined)).toBeUndefined()
  })
})

describe('toolParametersFromSchema', () => {
  const schemaWithOptional = object({
    findings: array(object({
      line: number(),
      related: optional(array(string())),
    })),
  })

  it('normalizes nested object schemas for strict function calling', () => {
    const parameters = toolParametersFromSchema(schemaWithOptional)

    expect(parameters.$schema).toBeUndefined()
    expect(parameters.additionalProperties).toBe(false)

    const findings = parameters.properties?.findings
    if (typeof findings !== 'object' || Array.isArray(findings.items) || typeof findings.items !== 'object') {
      throw new TypeError('Expected findings.items to be an object schema')
    }
    expect(findings.items.additionalProperties).toBe(false)
  })

  it('marks every property as required, including optional ones', () => {
    const parameters = toolParametersFromSchema(schemaWithOptional)

    expect(parameters.required).toEqual(['findings'])

    const findings = parameters.properties?.findings
    if (typeof findings !== 'object' || Array.isArray(findings.items) || typeof findings.items !== 'object') {
      throw new TypeError('Expected findings.items to be an object schema')
    }
    expect(findings.items.required).toEqual(['line', 'related'])
  })
})

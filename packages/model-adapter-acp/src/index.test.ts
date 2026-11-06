import type {
  AgentApp,
  ContentBlock,
  McpServer,
  PromptResponse,
  StopReason,
  Usage,
} from '@agentclientprotocol/sdk/unstable'

import { agent, methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk/unstable'
import { defineConfig, definePlugin, defineRule, runAlint } from '@alint-js/core'
import { generateStructured } from '@alint-js/core/structured-output'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { serve } from 'h3/node'
import { array, description, literal, nullable, number, object, optional, parse, picklist, pipe, string } from 'valibot'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createGateway } from './index'

const completionChunkSchema = object({
  choices: array(object({
    delta: object({
      content: optional(string()),
      tool_calls: optional(array(object({
        function: object({
          arguments: string(),
          name: string(),
        }),
        id: string(),
        index: number(),
        type: literal('function'),
      }))),
    }),
    finish_reason: optional(nullable(string())),
  })),
})

const findingResponseSchema = pipe(
  object({
    findings: array(object({
      line: number(),
      message: string(),
      severity: picklist(['warn', 'error']),
    })),
  }),
  description('Report findings for this file.'),
)

describe('aCP OpenAI gateway', () => {
  const servers: Array<{ close: () => Promise<void> }> = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.close()))
  })

  it('returns an ACP agent message as an OpenAI chat completion', async () => {
    const prompts: ContentBlock[][] = []
    const app = createGateway({
      models: [
        {
          id: 'reviewer',
          name: 'Review Agent',
          openConnection: () => ({
            agent: textAgent('Looks good.', prompts),
            kind: 'agent-app',
          }),
        },
      ],
    })
    const server = await serve(app, { hostname: '127.0.0.1', port: 0, silent: true }).ready()
    servers.push({
      close: () => server.close(true),
    })

    const response = await fetch(new URL('/v1/chat/completions', server.url), {
      body: JSON.stringify({
        messages: [
          { content: 'Act as a strict reviewer.', role: 'system' },
          { content: 'Review this file.', role: 'user' },
        ],
        model: 'reviewer',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      choices: [
        {
          finish_reason: 'stop',
          index: 0,
          message: { content: 'Looks good.', role: 'assistant' },
        },
      ],
      model: 'reviewer',
      object: 'chat.completion',
    })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toHaveLength(1)
    expect(prompts[0][0]).toMatchObject({ type: 'text' })
    expect(JSON.stringify(prompts[0][0])).toContain('Act as a strict reviewer.')
    expect(JSON.stringify(prompts[0][0])).toContain('Review this file.')
  })

  it('forwards unknown OpenAI and provider extension fields to the ACP session', async () => {
    const sessionRequests: Array<Record<string, unknown>> = []
    const app = createGateway({
      models: [
        {
          id: 'reviewer',
          name: 'Review Agent',
          openConnection: () => ({
            agent: forwardingAgent(sessionRequests),
            kind: 'agent-app',
          }),
        },
      ],
    })
    const server = await serve(app, { hostname: '127.0.0.1', port: 0, silent: true }).ready()
    servers.push({
      close: () => server.close(true),
    })

    const response = await fetch(new URL('/v1/chat/completions', server.url), {
      body: JSON.stringify({
        extra_args: { reasoning_effort: 'high' },
        max_tokens: 1_024,
        messages: [
          { content: 'Review this file.', role: 'user' },
        ],
        model: 'reviewer',
        top_p: 0.9,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      choices: [
        {
          message: { content: 'Accepted.' },
        },
      ],
    })
    expect(sessionRequests).toHaveLength(1)
    expect(sessionRequests[0]).toMatchObject({
      _meta: {
        extra_args: { reasoning_effort: 'high' },
        max_tokens: 1_024,
        top_p: 0.9,
      },
    })
  })

  it('lists configured ACP agents as OpenAI models', async () => {
    const app = createGateway({
      models: [
        {
          id: 'reviewer',
          name: 'Review Agent',
          openConnection: () => ({
            agent: textAgent('unused', []),
            kind: 'agent-app',
          }),
        },
      ],
    })
    const server = await serve(app, { hostname: '127.0.0.1', port: 0, silent: true }).ready()
    servers.push({
      close: () => server.close(true),
    })

    const response = await fetch(new URL('/v1/models', server.url))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: [
        {
          created: 0,
          id: 'reviewer',
          object: 'model',
          owned_by: 'Review Agent',
        },
      ],
      object: 'list',
    })
  })

  it('streams ACP text and usage as OpenAI SSE chunks', async () => {
    const app = createGateway({
      models: [
        {
          id: 'reviewer',
          name: 'Review Agent',
          openConnection: () => ({
            agent: textAgent('Streaming text.', [], {
              inputTokens: 12,
              outputTokens: 3,
              totalTokens: 15,
            }),
            kind: 'agent-app',
          }),
        },
      ],
    })
    const server = await serve(app, { hostname: '127.0.0.1', port: 0, silent: true }).ready()
    servers.push({
      close: () => server.close(true),
    })

    const response = await fetch(new URL('/v1/chat/completions', server.url), {
      body: JSON.stringify({
        messages: [
          { content: 'Stream a review.', role: 'user' },
        ],
        model: 'reviewer',
        stream: true,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(body).toContain('"content":"Streaming text."')
    expect(body).toContain('"prompt_tokens":12')
    expect(body).toContain('data: [DONE]')
  })

  it.each([
    { continuationStream: false, initialStream: false },
    { continuationStream: true, initialStream: false },
    { continuationStream: false, initialStream: true },
  ])('resumes an ACP MCP call from $initialStream streaming to $continuationStream streaming', async ({
    continuationStream,
    initialStream,
  }) => {
    const prompts: ContentBlock[][] = []
    const verifyStrictSchema = !initialStream && !continuationStream
    const app = createGateway({
      models: [
        {
          id: 'tool-user',
          name: 'Tool User',
          openConnection: () => ({
            agent: toolAgent({ prompts, verifyStrictSchema }),
            kind: 'agent-app',
          }),
        },
      ],
    })
    const server = await serve(app, { hostname: '127.0.0.1', port: 0, silent: true }).ready()
    servers.push({
      close: () => server.close(true),
    })
    const messages = [
      { content: 'Find duplicated helpers.', role: 'user' },
    ]
    const tools = [
      {
        function: {
          description: 'Search repository text.',
          name: 'search',
          parameters: {
            additionalProperties: false,
            properties: {
              query: { type: 'string' },
            },
            required: ['query'],
            type: 'object',
          },
          strict: true,
        },
        type: 'function',
      },
    ]

    const firstResponse = await fetch(new URL('/v1/chat/completions', server.url), {
      body: JSON.stringify({
        messages,
        model: 'tool-user',
        stream: initialStream,
        tool_choice: 'required',
        tools,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const first = await parseCompletionResponse(firstResponse, initialStream)
    const toolCall = first.toolCalls[0]

    expect(firstResponse.status).toBe(200)
    expect(JSON.stringify(prompts[0])).toContain('request-scoped MCP tools')
    expect(JSON.stringify(prompts[0])).toContain('search')
    if (!toolCall) {
      throw new Error('Expected a tool call.')
    }
    expect(toolCall.function).toEqual({ arguments: '{"query":"clamp"}', name: 'search' })
    expect(first.finishReasons).toContain('tool_calls')

    const secondResponse = await fetch(new URL('/v1/chat/completions', server.url), {
      body: JSON.stringify({
        messages: [
          ...messages,
          {
            content: null,
            role: 'assistant',
            tool_calls: [toolCall],
          },
          { content: 'src/a.ts\nsrc/b.ts', role: 'tool', tool_call_id: toolCall.id },
        ],
        model: 'tool-user',
        stream: continuationStream,
        tool_choice: 'required',
        tools,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const second = await parseCompletionResponse(secondResponse, continuationStream)

    expect(secondResponse.status).toBe(200)
    expect(second.content).toBe('Found: src/a.ts\nsrc/b.ts')
    expect(second.finishReasons).toContain('stop')
  })

  it('allows ACP permission requests that identify an OpenAI request tool', async () => {
    const app = createGateway({
      models: [
        {
          id: 'permission-agent',
          name: 'Permission Agent',
          openConnection: () => ({
            agent: permissionAgent(true),
            kind: 'agent-app',
          }),
        },
      ],
    })
    const server = await serve(app, { hostname: '127.0.0.1', port: 0, silent: true }).ready()
    servers.push({
      close: () => server.close(true),
    })

    const completion = await postCompletion(server.url!, {
      messages: [
        { content: 'Use the request tool.', role: 'user' },
      ],
      model: 'permission-agent',
    })

    expect(completion.choices[0].message.content).toBe('selected:allow_once')
  })

  it('denies ACP permission requests for agent side effects', async () => {
    const app = createGateway({
      models: [
        {
          id: 'permission-agent',
          name: 'Permission Agent',
          openConnection: () => ({
            agent: permissionAgent(false),
            kind: 'agent-app',
          }),
        },
      ],
    })
    const server = await serve(app, { hostname: '127.0.0.1', port: 0, silent: true }).ready()
    servers.push({
      close: () => server.close(true),
    })

    const completion = await postCompletion(server.url!, {
      messages: [
        { content: 'Change a file.', role: 'user' },
      ],
      model: 'permission-agent',
    })

    expect(completion.choices[0].message.content).toBe('cancelled')
  })

  it('cancels an abandoned ACP turn after the continuation TTL', async () => {
    const cancelled = vi.fn()
    const app = createGateway({
      continuationTtlMs: 20,
      models: [
        {
          id: 'tool-user',
          name: 'Tool User',
          openConnection: () => ({
            agent: toolAgent({ cancelled }),
            kind: 'agent-app',
          }),
        },
      ],
    })
    const server = await serve(app, { hostname: '127.0.0.1', port: 0, silent: true }).ready()
    servers.push({
      close: () => server.close(true),
    })

    const first = await postCompletion(server.url!, {
      messages: [
        { content: 'Search and wait.', role: 'user' },
      ],
      model: 'tool-user',
      tools: [
        {
          function: {
            name: 'search',
            parameters: {
              properties: {
                query: { type: 'string' },
              },
              type: 'object',
            },
          },
          type: 'function',
        },
      ],
    })

    expect(first.choices[0].finish_reason).toBe('tool_calls')
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce())

    const toolCall = first.choices[0].message.tool_calls[0]
    const response = await fetch(new URL('/v1/chat/completions', server.url), {
      body: JSON.stringify({
        messages: [
          { content: 'Search and wait.', role: 'user' },
          {
            content: null,
            role: 'assistant',
            tool_calls: [toolCall],
          },
          { content: 'too late', role: 'tool', tool_call_id: toolCall.id },
        ],
        model: 'tool-user',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { message: `Unknown tool call: ${toolCall.id}` },
    })
  })

  it('rejects a tool result whose history does not match the pending turn', async () => {
    const app = createGateway({
      models: [
        {
          id: 'tool-user',
          name: 'Tool User',
          openConnection: () => ({
            agent: toolAgent(),
            kind: 'agent-app',
          }),
        },
        {
          id: 'other-agent',
          name: 'Other Agent',
          openConnection: () => ({
            agent: textAgent('wrong agent', []),
            kind: 'agent-app',
          }),
        },
      ],
    })
    const server = await serve(app, { hostname: '127.0.0.1', port: 0, silent: true }).ready()
    servers.push({
      close: () => server.close(true),
    })
    const original = [
      { content: 'Find duplicated helpers.', role: 'user' },
    ]
    const tools = [
      {
        function: {
          name: 'search',
          parameters: {
            properties: {
              query: { type: 'string' },
            },
            type: 'object',
          },
        },
        type: 'function',
      },
    ]
    const first = await postCompletion(server.url!, { messages: original, model: 'tool-user', tools })
    const toolCall = first.choices[0].message.tool_calls[0]
    const resultMessage = { content: 'src/a.ts', role: 'tool', tool_call_id: toolCall.id }

    const mismatched = await fetch(new URL('/v1/chat/completions', server.url), {
      body: JSON.stringify({
        messages: [
          ...original,
          {
            content: null,
            role: 'assistant',
            tool_calls: [toolCall],
          },
          resultMessage,
        ],
        model: 'other-agent',
        tools,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect(mismatched.status).toBe(400)

    const resumed = await postCompletion(server.url!, {
      messages: [
        ...original,
        {
          content: null,
          role: 'assistant',
          tool_calls: [toolCall],
        },
        resultMessage,
      ],
      model: 'tool-user',
      tools,
    })

    expect(resumed.choices[0].message.content).toBe('Found: src/a.ts')
  })

  it.each([
    { tool_choice: 'sometimes' },
    { parallel_tool_calls: true },
  ])('rejects unsupported OpenAI request options: %j', async (unsupported) => {
    const app = createGateway({
      models: [
        {
          id: 'reviewer',
          name: 'Review Agent',
          openConnection: () => ({
            agent: textAgent('unused', []),
            kind: 'agent-app',
          }),
        },
      ],
    })
    const server = await serve(app, { hostname: '127.0.0.1', port: 0, silent: true }).ready()
    servers.push({
      close: () => server.close(true),
    })

    const response = await fetch(new URL('/v1/chat/completions', server.url), {
      body: JSON.stringify({
        ...unsupported,
        messages: [
          { content: 'Review.', role: 'user' },
        ],
        model: 'reviewer',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { type: 'invalid_request_error' },
    })
  })

  it('maps an ACP-cancelled prompt to an OpenAI provider error', async () => {
    const app = createGateway({
      models: [
        {
          id: 'reviewer',
          name: 'Review Agent',
          openConnection: () => ({
            agent: textAgent('', [], undefined, 'cancelled'),
            kind: 'agent-app',
          }),
        },
      ],
    })
    const server = await serve(app, { hostname: '127.0.0.1', port: 0, silent: true }).ready()
    servers.push({
      close: () => server.close(true),
    })

    const response = await fetch(new URL('/v1/chat/completions', server.url), {
      body: JSON.stringify({
        messages: [
          { content: 'Review.', role: 'user' },
        ],
        model: 'reviewer',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: { type: 'server_error' },
    })
  })

  it.each([
    { stream: false },
    { stream: true },
  ])('discards text from a rejected required-tool attempt when streaming=$stream', async ({ stream }) => {
    const app = createGateway({
      models: [
        {
          id: 'tool-user',
          name: 'Tool User',
          openConnection: () => ({
            agent: toolAgent({ skipFirstToolCall: true, textBeforeToolCall: 'Calling search.' }),
            kind: 'agent-app',
          }),
        },
      ],
    })
    const server = await serve(app, { hostname: '127.0.0.1', port: 0, silent: true }).ready()
    servers.push({
      close: () => server.close(true),
    })

    const response = await fetch(new URL('/v1/chat/completions', server.url), {
      body: JSON.stringify({
        messages: [
          { content: 'Use search.', role: 'user' },
        ],
        model: 'tool-user',
        stream,
        tool_choice: 'required',
        tools: [
          {
            function: {
              name: 'search',
              parameters: {
                properties: {
                  query: { type: 'string' },
                },
                type: 'object',
              },
            },
            type: 'function',
          },
        ],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const completion = await parseCompletionResponse(response, stream)

    expect(response.status).toBe(200)
    expect(completion.content).toBe('Calling search.')
    expect(completion.finishReasons).toContain('tool_calls')
    expect(completion.toolCalls[0].function.name).toBe('search')
  })

  it('cancels the ACP prompt when the HTTP request is aborted', async () => {
    const cancelled = vi.fn()
    const prompted = vi.fn()
    const app = createGateway({
      models: [
        {
          id: 'waiting',
          name: 'Waiting Agent',
          openConnection: () => ({
            agent: blockingAgent(prompted, cancelled),
            kind: 'agent-app',
          }),
        },
      ],
    })
    const server = await serve(app, { hostname: '127.0.0.1', port: 0, silent: true }).ready()
    servers.push({
      close: () => server.close(true),
    })
    const controller = new AbortController()
    const pending = fetch(new URL('/v1/chat/completions', server.url), {
      body: JSON.stringify({
        messages: [
          { content: 'Wait.', role: 'user' },
        ],
        model: 'waiting',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: controller.signal,
    })

    await vi.waitFor(() => expect(prompted).toHaveBeenCalledOnce())
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce())
  })
})

describe('alint ACP gateway end to end', () => {
  it('runs an alint rule through model resolution, HTTP, ACP, and the MCP tool bridge', async () => {
    const packageRoot = new URL('..', import.meta.url).pathname
    const diagnostics: string[] = []
    const app = createGateway({
      continuationTtlMs: 5_000,
      models: [
        {
          id: 'acp-reviewer',
          name: 'ACP Reviewer',
          openConnection: () => ({
            agent: structuredAgent(),
            kind: 'agent-app',
          }),
        },
      ],
      onCompatibilityDiagnostic: diagnostic => diagnostics.push(diagnostic.field),
    })
    const server = await serve(app, { hostname: '127.0.0.1', port: 0, silent: true }).ready()
    const rule = defineRule({
      create: ctx => ({
        async onTargetFile(target) {
          const source = await ctx.src.readFile(target.file)
          const result = await generateStructured({
            createMessages: () => [
              { content: 'Review the source and report findings.', role: 'system' },
              { content: source.text, role: 'user' },
            ],
            model: await ctx.model(),
            operation: 'acp-gateway-e2e',
            retryDelay: () => 0,
            schema: findingResponseSchema,
          })

          for (const finding of result.findings) {
            ctx.report({ message: finding.message })
          }
        },
      }),
      languages: 'any',
    })

    try {
      const result = await runAlint({
        config: defineConfig([
          {
            files: ['**/*.ts'],
            language: 'typescript',
            plugins: {
              e2e: definePlugin({
                rules: { review: rule },
              }),
            },
            rules: { 'e2e/review': 'warn' },
          },
        ]),
        cwd: packageRoot,
        files: ['src/index.ts'],
        projectTargets: false,
        runner: { cache: false },
        setupConfig: {
          providers: [
            {
              endpoint: new URL('/v1/', server.url).href,
              id: 'acp',
              models: [
                {
                  aliases: ['default'],
                  capabilities: ['tool-call'],
                  id: 'acp-reviewer',
                  name: 'ACP Reviewer',
                  size: 'small',
                },
              ],
              type: 'openai-compatible',
            },
          ],
          version: 1,
        },
      })

      expect(result.diagnostics).toMatchObject([
        {
          message: 'Split this function.',
          model: {
            providerId: 'acp',
            resolvedId: 'acp-reviewer',
          },
          ruleId: 'e2e/review',
          severity: 'warn',
        },
      ])
      expect(result.execution).toMatchObject({
        completed: 1,
        failed: 0,
        planned: 1,
      })
      expect(diagnostics).toEqual(['temperature', 'usage'])
    }
    finally {
      await app.shutdown()
      await server.close(true)
    }
  })
})

interface TestCompletion {
  choices: Array<{
    finish_reason: string
    message: {
      content?: null | string
      tool_calls: Array<{
        function: { arguments: string, name: string }
        id: string
        type: 'function'
      }>
    }
  }>
}

interface ToolAgentOptions {
  cancelled?: () => void
  prompts?: ContentBlock[][]
  skipFirstToolCall?: boolean
  textBeforeToolCall?: string
  verifyStrictSchema?: boolean
}

function blockingAgent(prompted: () => void, cancelled: () => void): AgentApp {
  let finish: ((response: PromptResponse) => void) | undefined

  return agent({ name: 'blocking-agent' })
    .onRequest(methods.agent.initialize, () => ({
      agentCapabilities: { loadSession: false },
      protocolVersion: PROTOCOL_VERSION,
    }))
    .onRequest(methods.agent.session.new, () => ({
      sessionId: crypto.randomUUID(),
    }))
    .onRequest(methods.agent.session.prompt, () => {
      prompted()
      return new Promise<PromptResponse>((resolve) => {
        finish = resolve
      })
    })
    .onNotification(methods.agent.session.cancel, () => {
      cancelled()
      finish?.({ stopReason: 'cancelled' })
    })
}

function forwardingAgent(sessionRequests: Array<Record<string, unknown>>): AgentApp {
  return agent({ name: 'forwarding-agent' })
    .onRequest(methods.agent.initialize, () => ({
      agentCapabilities: { loadSession: false },
      protocolVersion: PROTOCOL_VERSION,
    }))
    .onRequest(methods.agent.session.new, ({ params }) => {
      sessionRequests.push({ ...params })
      return {
        sessionId: crypto.randomUUID(),
      }
    })
    .onRequest(methods.agent.session.prompt, async ({ client, params }) => {
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          content: { text: 'Accepted.', type: 'text' },
          sessionUpdate: 'agent_message_chunk',
        },
      })
      return { stopReason: 'end_turn' }
    })
}

async function parseCompletionResponse(response: Response, stream: boolean) {
  if (stream) {
    const chunks = parseCompletionStream(await response.text())

    return {
      content: chunks.flatMap(chunk => chunk.choices.map(choice => choice.delta.content ?? '')).join(''),
      finishReasons: chunks.flatMap(chunk => chunk.choices.map(choice => choice.finish_reason)),
      toolCalls: chunks.flatMap(chunk => chunk.choices.flatMap(choice => choice.delta.tool_calls ?? [])),
    }
  }

  const completion = await response.json() as TestCompletion

  return {
    content: completion.choices.map(choice => choice.message.content ?? '').join(''),
    finishReasons: completion.choices.map(choice => choice.finish_reason),
    toolCalls: completion.choices.flatMap(choice => choice.message.tool_calls ?? []),
  }
}

function parseCompletionStream(body: string) {
  return body
    .split('\n')
    .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => parse(completionChunkSchema, JSON.parse(line.slice('data: '.length))))
}

function permissionAgent(requestTool: boolean): AgentApp {
  return agent({ name: 'permission-agent' })
    .onRequest(methods.agent.initialize, () => ({
      agentCapabilities: { loadSession: false },
      protocolVersion: PROTOCOL_VERSION,
    }))
    .onRequest(methods.agent.session.new, () => ({
      sessionId: crypto.randomUUID(),
    }))
    .onRequest(methods.agent.session.prompt, async ({ client, params }) => {
      const response = await client.request(methods.client.session.requestPermission, {
        ...(requestTool
          ? {
              _meta: { is_mcp_tool_approval: true },
            }
          : {}),
        options: [
          { kind: 'allow_once', name: 'Allow', optionId: 'allow_once' },
          { kind: 'reject_once', name: 'Reject', optionId: 'reject_once' },
        ],
        sessionId: params.sessionId,
        toolCall: {
          kind: 'execute',
          status: 'pending',
          toolCallId: 'permission-call',
        },
      })
      const text = response.outcome.outcome === 'selected'
        ? `selected:${response.outcome.optionId}`
        : response.outcome.outcome

      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          content: { text, type: 'text' },
          sessionUpdate: 'agent_message_chunk',
        },
      })
      return { stopReason: 'end_turn' }
    })
}

async function postCompletion(baseURL: string, body: unknown): Promise<TestCompletion> {
  const response = await fetch(new URL('/v1/chat/completions', baseURL), {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    signal: AbortSignal.timeout(2_000),
  })

  expect(response.status).toBe(200)
  return response.json() as Promise<TestCompletion>
}

function structuredAgent(): AgentApp {
  let mcpServer: McpServer | undefined

  return agent({ name: 'structured-agent' })
    .onRequest(methods.agent.initialize, () => ({
      agentCapabilities: {
        loadSession: false,
        mcpCapabilities: { http: true },
      },
      protocolVersion: PROTOCOL_VERSION,
    }))
    .onRequest(methods.agent.session.new, ({ params }) => {
      mcpServer = params.mcpServers[0]
      return {
        sessionId: crypto.randomUUID(),
      }
    })
    .onRequest(methods.agent.session.prompt, async () => {
      if (!mcpServer || !('type' in mcpServer) || mcpServer.type !== 'http') {
        throw new Error('Expected alint request tools over MCP HTTP.')
      }

      const mcp = new Client({ name: 'structured-agent', version: '1.0.0' })
      const headers = Object.fromEntries(mcpServer.headers.map(header => [header.name, header.value]))

      await mcp.connect(new StreamableHTTPClientTransport(new URL(mcpServer.url), {
        requestInit: { headers },
      }))

      try {
        const tools = await mcp.listTools()
        const reportTool = tools.tools.find(tool => tool.name === 'reportFindings')

        if (!reportTool) {
          throw new Error('Expected alint reportFindings tool.')
        }

        await mcp.callTool({
          arguments: {
            findings: [
              {
                line: 1,
                message: 'Split this function.',
                severity: 'warn',
              },
            ],
          },
          name: reportTool.name,
        })

        return { stopReason: 'end_turn' }
      }
      catch {
        return { stopReason: 'cancelled' }
      }
      finally {
        await mcp.close()
      }
    })
}

function textAgent(
  text: string,
  prompts: ContentBlock[][],
  usage?: Usage,
  stopReason: StopReason = 'end_turn',
): AgentApp {
  return agent({ name: 'test-agent' })
    .onRequest(methods.agent.initialize, () => ({
      agentCapabilities: { loadSession: false },
      protocolVersion: PROTOCOL_VERSION,
    }))
    .onRequest(methods.agent.session.new, () => ({
      sessionId: crypto.randomUUID(),
    }))
    .onRequest(methods.agent.session.prompt, async ({ client, params }) => {
      prompts.push(params.prompt)
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          content: { text, type: 'text' },
          sessionUpdate: 'agent_message_chunk',
        },
      })
      return { stopReason, usage }
    })
}

function toolAgent(options: ToolAgentOptions = {}): AgentApp {
  const {
    cancelled = () => {},
    prompts = [],
    skipFirstToolCall = false,
    textBeforeToolCall,
    verifyStrictSchema = false,
  } = options
  let mcpServer: McpServer | undefined
  let promptCount = 0

  return agent({ name: 'tool-agent' })
    .onRequest(methods.agent.initialize, () => ({
      agentCapabilities: {
        loadSession: false,
        mcpCapabilities: { http: true },
      },
      protocolVersion: PROTOCOL_VERSION,
    }))
    .onRequest(methods.agent.session.new, ({ params }) => {
      mcpServer = params.mcpServers[0]
      return {
        sessionId: crypto.randomUUID(),
      }
    })
    .onNotification(methods.agent.session.cancel, () => cancelled())
    .onRequest(methods.agent.session.prompt, async ({ client, params }) => {
      promptCount += 1
      prompts.push(params.prompt)

      if (skipFirstToolCall && promptCount === 1) {
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            content: { text: 'Ignored response.', type: 'text' },
            sessionUpdate: 'agent_message_chunk',
          },
        })
        return { stopReason: 'end_turn' }
      }

      if (!mcpServer || !('type' in mcpServer) || mcpServer.type !== 'http') {
        throw new Error('Expected an HTTP MCP server.')
      }

      const mcp = new Client({ name: 'test-agent', version: '1.0.0' })
      const headers = Object.fromEntries(mcpServer.headers.map(header => [header.name, header.value]))
      await mcp.connect(new StreamableHTTPClientTransport(new URL(mcpServer.url), {
        requestInit: { headers },
      }))

      const listed = await mcp.listTools()
      expect(listed.tools.map(tool => tool.name)).toEqual(['search'])
      if (verifyStrictSchema) {
        expect(listed.tools[0].inputSchema.type).toBe('object')
        expect(listed.tools[0].inputSchema.properties).toEqual({
          query: { type: 'string' },
        })
        expect(listed.tools[0].inputSchema.required).toEqual(['query'])
        expect(listed.tools[0].inputSchema.additionalProperties).toBe(false)
      }
      if (textBeforeToolCall) {
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            content: { text: textBeforeToolCall, type: 'text' },
            sessionUpdate: 'agent_message_chunk',
          },
        })
      }
      const result = await mcp.callTool({
        arguments: { query: 'clamp' },
        name: 'search',
      })
      const content = Array.isArray(result.content)
        ? result.content[0]
        : undefined
      const text = content && typeof content === 'object' && 'type' in content && content.type === 'text' && 'text' in content
        ? String(content.text)
        : 'missing result'

      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          content: { text: `Found: ${text}`, type: 'text' },
          sessionUpdate: 'agent_message_chunk',
        },
      })
      await mcp.close()
      return { stopReason: 'end_turn' }
    })
}

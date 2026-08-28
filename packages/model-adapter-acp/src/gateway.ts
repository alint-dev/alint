import type {
  AgentApp,
  ClientApp,
  ClientContext,
  StopReason,
  Stream,
  Usage,
} from '@agentclientprotocol/sdk'

import type { OpenAIFunctionTool, PendingToolCall } from './tool-bridge'

import process from 'node:process'

import { client, methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { defineEventHandler, getRouterParam, H3 } from 'h3'
import { serve } from 'h3/node'
import { array, boolean, literal, looseObject, number, object, optional, record, safeParse, string, union, unknown } from 'valibot'

import { ToolBridge } from './tool-bridge'

export interface CompatibilityDiagnostic {
  field: string
  message: string
  value: unknown
}

export type GatewayApp = H3 & {
  shutdown: () => Promise<void>
}

export interface GatewayModel {
  id: string
  name: string
  openConnection: () => GatewayModelConnection | Promise<GatewayModelConnection>
}

export type GatewayModelConnection
  = | { agent: AgentApp, kind: 'agent-app' }
    | { dispose?: () => Promise<void> | void, kind: 'stream', stream: Stream }

export interface GatewayOptions {
  continuationTtlMs?: number
  cwd?: string
  mcpBaseUrl?: string
  models: GatewayModel[]
  onCompatibilityDiagnostic?: (diagnostic: CompatibilityDiagnostic) => void
}

export interface GatewayServer {
  endpoint: string
  shutdown: () => Promise<void>
}

type BufferedCompletionOutput = Exclude<CompletionOutput, { type: 'text-delta' }> & { text: string }

interface ChatCompletionRequest {
  extensions: Record<string, unknown>
  messages: unknown[]
  model: string
  stream: boolean
  temperature?: number
  toolChoice?: ToolChoice
  tools: OpenAIFunctionTool[]
}

type CompletionOutput
  = | { call: PendingToolCall, type: 'tool-call' }
    | { stopReason: StopReason, type: 'completion', usage?: null | Usage }
    | { text: string, type: 'text-delta' }

type ToolChoice
  = | 'auto'
    | 'none'
    | 'required'
    | { function: { name: string }, type: 'function' }

interface ToolResultMessage {
  content: string
  toolCallId: string
}

const zeroUsage: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
}

const openAIFunctionToolSchema = object({
  function: object({
    description: optional(string()),
    name: string(),
    parameters: optional(record(string(), unknown())),
    strict: optional(boolean()),
  }),
  type: literal('function'),
})

const chatCompletionRequestSchema = looseObject({
  messages: array(unknown()),
  model: string(),
  parallel_tool_calls: optional(literal(false), false),
  stream: optional(boolean(), false),
  stream_options: optional(unknown()),
  temperature: optional(number()),
  tool_choice: optional(union([
    literal('auto'),
    literal('none'),
    literal('required'),
    object({
      function: object({ name: string() }),
      type: literal('function'),
    }),
  ])),
  tools: optional(array(openAIFunctionToolSchema), []),
})

interface CompletionTurnOptions {
  bridges: Map<string, ToolBridge>
  continuationTtlMs: number
  cwd: string
  model: GatewayModel
  onFinished: (turn: CompletionTurn, pendingCallIds: string[]) => void
  onPending: (call: PendingToolCall, turn: CompletionTurn) => void
  origin: string
  request: ChatCompletionRequest
  tools: OpenAIFunctionTool[]
}

class PromiseQueue<T> {
  #failed = false
  #failure: unknown
  #items: T[] = []
  #reject: ((reason: unknown) => void) | undefined
  #removeAbortListener: (() => void) | undefined
  #resolve: ((item: T) => void) | undefined

  fail(reason: unknown): void {
    this.#failed = true
    this.#failure = reason

    if (this.#reject) {
      const reject = this.#reject
      this.#clearWaiter()
      reject(reason)
    }
  }

  next(signal?: AbortSignal): Promise<T> {
    const item = this.#items.shift()

    if (item) {
      return Promise.resolve(item)
    }

    if (this.#failed) {
      return Promise.reject(this.#failure)
    }

    if (signal?.aborted) {
      return Promise.reject(signal.reason)
    }

    return new Promise<T>((resolve, reject) => {
      this.#resolve = resolve
      this.#reject = reject

      if (signal) {
        const abort = () => {
          this.#clearWaiter()
          reject(signal.reason)
        }
        signal.addEventListener('abort', abort, { once: true })
        this.#removeAbortListener = () => signal.removeEventListener('abort', abort)
      }
    })
  }

  push(item: T): void {
    if (this.#resolve) {
      const resolve = this.#resolve
      this.#clearWaiter()
      resolve(item)
      return
    }

    this.#items.push(item)
  }

  #clearWaiter(): void {
    this.#removeAbortListener?.()
    this.#removeAbortListener = undefined
    this.#reject = undefined
    this.#resolve = undefined
  }
}

class CompletionTurn {
  get modelId(): string {
    return this.#options.model.id
  }

  #bridge: ToolBridge | undefined
  #cancelled: Error | undefined
  #cancelSession: (() => Promise<void>) | undefined
  #connection: GatewayModelConnection | undefined
  #connectionDisposePromise: Promise<void> | undefined
  // Required-tool attempts buffer text until a tool call validates the attempt.
  // A call flushes these chunks before its output; a rejected attempt discards them.
  #deferredText: string[] | undefined
  #finished = false
  #options: CompletionTurnOptions
  #outputs = new PromiseQueue<CompletionOutput>()
  #pendingCalls = new Map<string, PendingToolCall>()
  #timer: ReturnType<typeof setTimeout> | undefined

  #toolCallCount = 0

  constructor(options: CompletionTurnOptions) {
    this.#options = options

    if (options.tools.length > 0) {
      this.#bridge = new ToolBridge(options.tools, (call) => {
        this.#toolCallCount += 1
        this.#pendingCalls.set(call.id, call)
        options.onPending(call, this)
        this.#flushDeferredText()
        this.#outputs.push({ call, type: 'tool-call' })
      })
      options.bridges.set(this.#bridge.id, this.#bridge)
    }
  }

  armContinuation(callId: string): void {
    if (!this.#pendingCalls.has(callId) || this.#timer) {
      return
    }

    this.#timer = setTimeout(() => {
      void this.cancel(new Error(`Tool call ${callId} expired.`))
    }, this.#options.continuationTtlMs)
    this.#timer.unref?.()
  }

  async cancel(reason: Error): Promise<void> {
    if (this.#cancelled) {
      return
    }

    this.#cancelled = reason
    this.#outputs.fail(reason)
    void this.#cancelSession?.().catch(() => {})
    await this.#bridge?.close(reason)
    await this.#disposeConnection()
    this.#finish()
  }

  async nextOutput(signal?: AbortSignal): Promise<CompletionOutput> {
    try {
      return await this.#outputs.next(signal)
    }
    catch (error) {
      if (signal?.aborted) {
        await this.cancel(new Error('The OpenAI request was aborted.'))
      }

      throw error
    }
  }

  resume(request: ChatCompletionRequest, result: ToolResultMessage): boolean {
    if (!this.#matchesContinuation(request, result.toolCallId)) {
      return false
    }

    const resumed = this.#bridge?.resolve(result.toolCallId, result.content) ?? false

    if (resumed && this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }

    if (resumed) {
      this.#pendingCalls.delete(result.toolCallId)
    }

    return resumed
  }

  start(): void {
    void this.#run().catch(error => this.#outputs.fail(error))
  }

  #assertActive(): void {
    if (this.#cancelled) {
      throw this.#cancelled
    }
  }

  async #disposeConnection(): Promise<void> {
    const connection = this.#connection
    if (connection?.kind !== 'stream') {
      return
    }

    // Cancellation and normal completion can request disposal at the same time. Both paths must
    // await the same work before the gateway removes this turn from its active set.
    this.#connectionDisposePromise ??= Promise.resolve().then(() => connection.dispose?.())
    await this.#connectionDisposePromise
  }

  #finish(): void {
    if (this.#finished) {
      return
    }

    this.#finished = true
    this.#options.onFinished(this, [...this.#pendingCalls.keys()])
  }

  #flushDeferredText(): void {
    const chunks = this.#deferredText
    this.#deferredText = undefined

    for (const text of chunks ?? []) {
      this.#outputs.push({ text, type: 'text-delta' })
    }
  }

  #matchesContinuation(request: ChatCompletionRequest, toolCallId: string): boolean {
    const initialMessages = this.#options.request.messages
    const initialPrefix = request.messages.slice(0, initialMessages.length)
    const assistantMessage = request.messages.at(-2)
    const pendingCall = this.#pendingCalls.get(toolCallId)

    if (
      !pendingCall
      || request.model !== this.#options.model.id
      || JSON.stringify(request.tools) !== JSON.stringify(this.#options.request.tools)
      || JSON.stringify(request.toolChoice) !== JSON.stringify(this.#options.request.toolChoice)
      || JSON.stringify(initialPrefix) !== JSON.stringify(initialMessages)
      || !isRecord(assistantMessage)
    ) {
      return false
    }

    const toolCalls = assistantMessage.tool_calls

    return Array.isArray(toolCalls)
      && toolCalls.some(call => isRecord(call)
        && call.id === toolCallId
        && isRecord(call.function)
        && call.function.name === pendingCall.name
        && call.function.arguments === pendingCall.arguments)
  }

  #pushText(text: string): void {
    if (this.#deferredText) {
      this.#deferredText.push(text)
      return
    }

    this.#outputs.push({ text, type: 'text-delta' })
  }

  async #run(): Promise<void> {
    const { cwd, model, origin, request } = this.#options

    try {
      const connection = await model.openConnection()
      this.#connection = connection
      this.#assertActive()
      const acpClient = authorizeRequestTools(client({ name: 'alint-model-adapter-acp' }))

      await this.#bridge?.start()
      this.#assertActive()
      await connectWith(acpClient, connection, async (context) => {
        await context.request(methods.agent.initialize, {
          clientCapabilities: {},
          clientInfo: { name: 'alint-model-adapter-acp', version: '0.3.2' },
          protocolVersion: PROTOCOL_VERSION,
        })
        this.#assertActive()

        await context.buildSession({
          ...sessionExtensions(request.extensions),
          cwd,
          mcpServers: this.#bridge ? [this.#bridge.config(origin)] : [],
        }).withSession(async (session) => {
          this.#cancelSession = () => context.notify(methods.agent.session.cancel, {
            sessionId: session.sessionId,
          })
          this.#assertActive()
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const callCountBeforePrompt = this.#toolCallCount
            this.#deferredText = requiresTool(request.toolChoice) ? [] : undefined
            const prompt = session.prompt(attempt === 0
              ? renderMessages(request)
              : [
                  'The request requires a request-scoped MCP tool call.',
                  `Call one of these functions before returning an answer: ${this.#options.tools.map(tool => tool.function.name).join(', ')}.`,
                ].join(' '))

            for (;;) {
              const message = await session.nextUpdate()

              if (message.kind === 'stop') {
                await prompt

                if (message.stopReason === 'cancelled') {
                  throw new Error('The ACP agent cancelled the prompt.')
                }

                if (requiresTool(request.toolChoice) && this.#toolCallCount === callCountBeforePrompt) {
                  this.#deferredText = undefined
                  break
                }

                this.#outputs.push({
                  stopReason: message.stopReason,
                  type: 'completion',
                  usage: message.response.usage,
                })
                return
              }

              if (message.update.sessionUpdate === 'agent_message_chunk' && message.update.content.type === 'text') {
                this.#pushText(message.update.content.text)
              }
            }
          }

          throw new Error('The ACP agent did not satisfy tool_choice after one retry.')
        })
      })
    }
    finally {
      if (this.#timer) {
        clearTimeout(this.#timer)
      }

      if (this.#bridge) {
        this.#options.bridges.delete(this.#bridge.id)
        await this.#bridge.close()
      }

      try {
        await this.#disposeConnection()
      }
      finally {
        this.#finish()
      }
    }
  }
}

/** Creates the OpenAI-compatible HTTP interface backed by configured ACP agents. */
export function createGateway(options: GatewayOptions): GatewayApp {
  const models = new Map(options.models.map(model => [model.id, model]))
  const activeTurns = new Set<CompletionTurn>()
  const bridges = new Map<string, ToolBridge>()
  const pendingTurns = new Map<string, CompletionTurn>()
  const configuredMcpOrigin = options.mcpBaseUrl ? new URL(options.mcpBaseUrl).origin : undefined
  const app = new H3()

  app.get('/v1/models', defineEventHandler(() => ({
    data: options.models.map(model => ({
      created: 0,
      id: model.id,
      object: 'model',
      owned_by: model.name,
    })),
    object: 'list',
  })))

  app.all('/_alint/mcp/:bridgeId', defineEventHandler(async (event) => {
    const bridge = bridges.get(getRouterParam(event, 'bridgeId') ?? '')

    if (!bridge || event.req.headers.get('authorization') !== `Bearer ${bridge.token}`) {
      return new Response(null, { status: 404 })
    }

    return bridge.handleRequest(event.req)
  }))

  app.post('/v1/chat/completions', defineEventHandler(async (event) => {
    const body = await event.req.json().catch(() => undefined) as unknown
    const request = chatCompletionRequest(body)

    if (!request) {
      event.res.status = 400
      return openAIError('Invalid chat completion request.', 'invalid_request_error')
    }

    if (request.temperature !== undefined) {
      options.onCompatibilityDiagnostic?.({
        field: 'temperature',
        message: 'ACP has no temperature equivalent; the configured agent controls sampling.',
        value: request.temperature,
      })
    }

    const model = models.get(request.model)

    if (!model) {
      event.res.status = 404
      return openAIError(`Unknown model: ${request.model}`, 'invalid_request_error')
    }

    const toolResult = lastToolResult(request.messages)
    let turn: CompletionTurn

    if (toolResult) {
      const pendingTurn = pendingTurns.get(toolResult.toolCallId)

      if (!pendingTurn || !pendingTurn.resume(request, toolResult)) {
        event.res.status = 400
        return openAIError(`Unknown tool call: ${toolResult.toolCallId}`, 'invalid_request_error')
      }

      pendingTurns.delete(toolResult.toolCallId)
      turn = pendingTurn
    }
    else {
      const selectedTools = toolsForChoice(request.tools, request.toolChoice)
      const origin = mcpOrigin(event.req.url, configuredMcpOrigin)

      if (requiresTool(request.toolChoice) && selectedTools.length === 0) {
        event.res.status = 400
        return openAIError('tool_choice requires a function present in tools.', 'invalid_request_error')
      }

      if (selectedTools.length > 0 && !origin) {
        event.res.status = 500
        return openAIError('mcpBaseUrl is required when the gateway is not accessed through loopback.', 'server_error')
      }

      turn = new CompletionTurn({
        bridges,
        continuationTtlMs: options.continuationTtlMs ?? 30_000,
        cwd: options.cwd ?? process.cwd(),
        model,
        onFinished: (finishedTurn, pendingCallIds) => {
          activeTurns.delete(finishedTurn)
          for (const callId of pendingCallIds) {
            pendingTurns.delete(callId)
          }
        },
        onPending: (call, pendingTurn) => pendingTurns.set(call.id, pendingTurn),
        origin: origin ?? new URL(event.req.url).origin,
        request,
        tools: selectedTools,
      })
      activeTurns.add(turn)
      turn.start()
    }

    if (request.stream) {
      return streamCompletion(turn, model.id, options.onCompatibilityDiagnostic)
    }

    let output: BufferedCompletionOutput

    try {
      output = await bufferCompletion(turn, event.req.signal)
    }
    catch {
      event.res.status = 500
      return openAIError('The ACP agent could not complete the request.', 'server_error')
    }

    if (output.type === 'tool-call') {
      deferToolCall(turn, output.call, options.onCompatibilityDiagnostic)
      return chatCompletion(turn.modelId, {
        finishReason: 'tool_calls',
        message: {
          content: output.text || null,
          role: 'assistant',
          tool_calls: [{
            function: { arguments: output.call.arguments, name: output.call.name },
            id: output.call.id,
            type: 'function',
          }],
        },
      }, zeroUsage)
    }

    return chatCompletion(turn.modelId, {
      finishReason: finishReason(output.stopReason),
      message: { content: output.text, role: 'assistant' },
    }, output.usage)
  }))

  return Object.assign(app, {
    /**
     * Cancels turns retained by the H3 application.
     *
     * Triggering workflow:
     *
     * {@link startGateway}
     *   -> `GatewayApp.shutdown`
     *     -> {@link CompletionTurn.cancel}
     *
     * Upstream:
     * - {@link startGateway}
     *
     * Downstream:
     * - {@link CompletionTurn.cancel}
     */
    async shutdown() {
      await Promise.all([...activeTurns].map(turn => turn.cancel(new Error('The gateway is shutting down.'))))
      bridges.clear()
      pendingTurns.clear()
    },
  })
}

/** Starts an ephemeral loopback gateway for one CLI run. */
export async function startGateway(options: GatewayOptions): Promise<GatewayServer> {
  const app = createGateway(options)
  const server = await serve(app, {
    hostname: '127.0.0.1',
    port: 0,
    silent: true,
  }).ready()
  let stopped = false

  return {
    endpoint: new URL('/v1/', server.url).href,
    /**
     * Stops adapter work before closing the loopback listener.
     *
     * Triggering workflow:
     *
     * `ModelAdapterRuntime.shutdown`
     *   -> `GatewayServer.shutdown`
     *     -> {@link GatewayApp.shutdown}
     *
     * Upstream:
     * - {@link startGateway}
     *
     * Downstream:
     * - {@link GatewayApp.shutdown}
     * - `Server.close`
     */
    async shutdown() {
      if (stopped) {
        return
      }

      stopped = true
      await app.shutdown()
      await server.close(true)
    },
  }
}

/**
 * Allows an agent to invoke only the request-scoped tools supplied by the OpenAI caller.
 *
 * Triggering workflow:
 *
 * {@link CompletionTurn.#run}
 *   -> ACP `session/request_permission`
 *     -> {@link authorizeRequestTools}
 *
 * The ACP Codex adapter marks MCP tool approvals with `is_mcp_tool_approval`. Other
 * permission requests can execute commands or edit files, so they remain cancelled.
 *
 * Upstream:
 * - {@link CompletionTurn.#run}
 *
 * Downstream:
 * - ACP permission response
 */
function authorizeRequestTools(client: ClientApp): ClientApp {
  return client.onRequest(methods.client.session.requestPermission, ({ params }) => {
    const meta = params._meta
    const allowOnce = params.options.find(option => option.kind === 'allow_once')

    if (isRecord(meta) && meta.is_mcp_tool_approval === true && allowOnce) {
      return {
        outcome: {
          optionId: allowOnce.optionId,
          outcome: 'selected',
        },
      }
    }

    return { outcome: { outcome: 'cancelled' } }
  })
}

async function bufferCompletion(
  turn: CompletionTurn,
  signal: AbortSignal,
): Promise<BufferedCompletionOutput> {
  let text = ''

  for (;;) {
    const output = await turn.nextOutput(signal)

    if (output.type === 'text-delta') {
      text += output.text
      continue
    }

    return { ...output, text }
  }
}

function chatCompletion(
  model: string,
  choice: { finishReason: string, message: Record<string, unknown> },
  usage?: null | Usage,
) {
  return {
    choices: [{
      finish_reason: choice.finishReason,
      index: 0,
      message: choice.message,
    }],
    created: Math.floor(Date.now() / 1_000),
    id: `chatcmpl-${crypto.randomUUID()}`,
    model,
    object: 'chat.completion',
    ...(usage
      ? {
          usage: toOpenAIUsage(usage),
        }
      : {}),
  }
}

function chatCompletionChunk(id: string, created: number, model: string, choices: unknown[]) {
  return {
    choices,
    created,
    id,
    model,
    object: 'chat.completion.chunk',
  }
}

function chatCompletionRequest(value: unknown): ChatCompletionRequest | undefined {
  const result = safeParse(chatCompletionRequestSchema, value)

  if (!result.success) {
    return undefined
  }

  const {
    messages,
    model,
    parallel_tool_calls: _parallelToolCalls,
    stream,
    stream_options: _streamOptions,
    temperature,
    tool_choice: toolChoice,
    tools,
    ...extensions
  } = result.output

  return { extensions, messages, model, stream, temperature, toolChoice, tools }
}

function connectWith<T>(
  client: ClientApp,
  connection: GatewayModelConnection,
  operation: (context: ClientContext) => Promise<T>,
): Promise<T> {
  return connection.kind === 'agent-app'
    ? client.connectWith(connection.agent, operation)
    : client.connectWith(connection.stream, operation)
}

function deferToolCall(
  turn: CompletionTurn,
  call: PendingToolCall,
  onCompatibilityDiagnostic?: GatewayOptions['onCompatibilityDiagnostic'],
): void {
  turn.armContinuation(call.id)
  onCompatibilityDiagnostic?.({
    field: 'usage',
    message: 'ACP usage is unavailable while a deferred tool call is pending; zero usage was reported.',
    value: null,
  })
}

function enqueueSse(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  value: unknown,
): void {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
}

function finishReason(stopReason: StopReason): 'content_filter' | 'length' | 'stop' {
  switch (stopReason) {
    case 'cancelled':
    case 'end_turn':
      return 'stop'
    case 'max_tokens':
    case 'max_turn_requests':
      return 'length'
    case 'refusal':
      return 'content_filter'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function lastToolResult(messages: unknown[]): ToolResultMessage | undefined {
  const message = messages.at(-1)

  if (!isRecord(message) || message.role !== 'tool' || typeof message.tool_call_id !== 'string') {
    return undefined
  }

  return {
    content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    toolCallId: message.tool_call_id,
  }
}

function mcpOrigin(requestUrl: string, configuredOrigin: string | undefined): string | undefined {
  if (configuredOrigin) {
    return configuredOrigin
  }

  const url = new URL(requestUrl)

  // A remote Host header must not decide where the ACP agent sends an authenticated MCP request.
  return ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ? url.origin : undefined
}

function openAIError(message: string, type: string) {
  return { error: { message, type } }
}

function renderMessages(request: ChatCompletionRequest): string {
  const requiredTool = request.toolChoice && typeof request.toolChoice === 'object'
    ? request.toolChoice.function.name
    : undefined
  const toolNames = request.tools.map(tool => tool.function.name).join(', ')

  return [
    'Process this OpenAI chat transcript. Preserve message order and role intent.',
    'Return only the assistant response requested by the transcript.',
    request.toolChoice === 'required'
      ? `You must call one of these request-scoped MCP tools before answering: ${toolNames}.`
      : '',
    requiredTool
      ? `You must call the request-scoped MCP tool ${JSON.stringify(requiredTool)} before answering.`
      : '',
    '',
    JSON.stringify({ messages: request.messages }),
  ].join('\n')
}

function requiresTool(choice: ToolChoice | undefined): boolean {
  return choice === 'required' || typeof choice === 'object'
}

function sessionExtensions(extensions: Record<string, unknown>): Record<string, unknown> {
  const { _meta: explicitMeta, ...fields } = extensions

  if (Object.keys(fields).length === 0 && !isRecord(explicitMeta)) {
    return {}
  }

  return {
    ...fields,
    _meta: {
      ...fields,
      ...(isRecord(explicitMeta) ? explicitMeta : {}),
    },
  }
}

function streamCompletion(
  turn: CompletionTurn,
  model: string,
  onCompatibilityDiagnostic?: GatewayOptions['onCompatibilityDiagnostic'],
): Response {
  const encoder = new TextEncoder()
  const id = `chatcmpl-${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1_000)
  const finishStream = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    reason: 'tool_calls' | ReturnType<typeof finishReason>,
    usage?: null | Usage,
  ) => {
    enqueueSse(controller, encoder, chatCompletionChunk(id, created, model, [{
      delta: {},
      finish_reason: reason,
      index: 0,
    }]))

    if (usage) {
      enqueueSse(controller, encoder, {
        ...chatCompletionChunk(id, created, model, []),
        usage: toOpenAIUsage(usage),
      })
    }

    controller.enqueue(encoder.encode('data: [DONE]\n\n'))
    controller.close()
  }

  const body = new ReadableStream<Uint8Array>({
    async cancel() {
      await turn.cancel(new Error('The OpenAI stream consumer cancelled the request.'))
    },
    async start(controller) {
      try {
        for (;;) {
          const output = await turn.nextOutput()

          if (output.type === 'text-delta') {
            enqueueSse(controller, encoder, chatCompletionChunk(id, created, model, [{
              delta: { content: output.text, role: 'assistant' },
              index: 0,
            }]))
            continue
          }

          if (output.type === 'tool-call') {
            // The ACP call stays blocked until the next OpenAI request returns its tool result.
            deferToolCall(turn, output.call, onCompatibilityDiagnostic)
            enqueueSse(controller, encoder, chatCompletionChunk(id, created, model, [{
              delta: {
                role: 'assistant',
                tool_calls: [{
                  function: { arguments: output.call.arguments, name: output.call.name },
                  id: output.call.id,
                  index: 0,
                  type: 'function',
                }],
              },
              index: 0,
            }]))
            finishStream(controller, 'tool_calls', zeroUsage)
            return
          }

          finishStream(controller, finishReason(output.stopReason), output.usage)
          return
        }
      }
      catch (error) {
        controller.error(error)
      }
    },
  })

  return new Response(body, {
    headers: {
      'cache-control': 'no-cache',
      'content-type': 'text/event-stream; charset=utf-8',
    },
  })
}

function toolsForChoice(tools: OpenAIFunctionTool[], choice: ToolChoice | undefined): OpenAIFunctionTool[] {
  if (choice === 'none') {
    return []
  }

  if (typeof choice === 'object') {
    return tools.filter(tool => tool.function.name === choice.function.name)
  }

  return tools
}

function toOpenAIUsage(usage: Usage) {
  return {
    completion_tokens: usage.outputTokens,
    prompt_tokens: usage.inputTokens,
    total_tokens: usage.totalTokens,
  }
}

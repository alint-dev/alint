import type { McpServer } from '@agentclientprotocol/sdk'

import { McpServer as ProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { fromJSONSchema } from 'zod'

export interface OpenAIFunctionTool {
  function: {
    description?: string
    name: string
    parameters?: JSONSchema
    strict?: boolean
  }
  type: 'function'
}

export interface PendingToolCall {
  arguments: string
  id: string
  name: string
}

interface DeferredToolResult {
  reject: (reason: Error) => void
  resolve: (content: string) => void
}

type JSONSchema = Exclude<Parameters<typeof fromJSONSchema>[0], boolean>

export class ToolBridge {
  readonly id = crypto.randomUUID()
  readonly token = crypto.randomUUID()

  #closed = false
  #deferred = new Map<string, DeferredToolResult>()
  #onCall: (call: PendingToolCall) => void
  #server: ProtocolServer
  #tools: OpenAIFunctionTool[]
  #transport: WebStandardStreamableHTTPServerTransport

  constructor(tools: OpenAIFunctionTool[], onCall: (call: PendingToolCall) => void) {
    this.#tools = tools
    this.#onCall = onCall

    this.#server = new ProtocolServer(
      { name: 'alint-openai-tools', version: '0.3.2' },
      {
        capabilities: { tools: {} },
      },
    )
    this.#transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: () => crypto.randomUUID(),
    })

    for (const tool of this.#tools) {
      this.#server.registerTool(tool.function.name, {
        description: tool.function.description,
        // The MCP high-level API validates Zod schemas. Convert the request's JSON
        // Schema so registration keeps both validation and the advertised shape.
        inputSchema: fromJSONSchema(inputSchema(tool)),
      }, arguments_ => this.#call(tool.function.name, arguments_))
    }
  }

  async close(reason = new Error('The ACP turn ended before the tool returned.')): Promise<void> {
    if (this.#closed) {
      return
    }

    this.#closed = true
    for (const deferred of this.#deferred.values()) {
      deferred.reject(reason)
    }
    this.#deferred.clear()
    await this.#server.close()
  }

  config(origin: string): McpServer {
    return {
      headers: [
        { name: 'authorization', value: `Bearer ${this.token}` },
      ],
      name: 'openai-request-tools',
      type: 'http',
      url: new URL(`/_alint/mcp/${this.id}`, origin).href,
    }
  }

  /**
   * Routes the gateway's authenticated MCP endpoint into the request-scoped
   * transport. Tool calls then enter `#call` through `McpServer.registerTool`.
   */
  handleRequest(request: Request): Promise<Response> {
    return this.#transport.handleRequest(request)
  }

  resolve(callId: string, content: string): boolean {
    const deferred = this.#deferred.get(callId)

    if (!deferred) {
      return false
    }

    this.#deferred.delete(callId)
    deferred.resolve(content)
    return true
  }

  start(): Promise<void> {
    return this.#server.connect(this.#transport)
  }

  /**
   * Handles an MCP `tools/call` request from the ACP agent. It records one pending
   * result, emits the equivalent OpenAI tool call through `#onCall`, and completes
   * when `resolve` receives the next request's tool result. Unknown tools and
   * parallel calls fail before any OpenAI-visible state is emitted.
   */
  async #call(name: string, arguments_: unknown) {
    if (!this.#tools.some(tool => tool.function.name === name)) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown request tool: ${name}`)
    }

    if (this.#deferred.size > 0) {
      throw new McpError(ErrorCode.InvalidRequest, 'Parallel request tool calls are not supported.')
    }

    const id = `call_${crypto.randomUUID()}`
    const content = new Promise<string>((resolve, reject) => {
      this.#deferred.set(id, { reject, resolve })
    })

    this.#onCall({
      arguments: JSON.stringify(arguments_),
      id,
      name,
    })

    return {
      content: [
        { text: await content, type: 'text' as const },
      ],
    }
  }
}

function inputSchema(tool: OpenAIFunctionTool): JSONSchema {
  return {
    ...tool.function.parameters,
    properties: tool.function.parameters?.properties ?? {},
    type: 'object' as const,
  }
}

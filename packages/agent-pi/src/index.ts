import type { ResolvedModel } from '@alint-js/core'
import type { AgentAdapter, AgentRequest, AgentResult, AgentTool } from '@alint-js/core/agent'
import type { AgentTool as PiTool } from '@earendil-works/pi-agent-core'
import type { Model } from '@earendil-works/pi-ai'

import { RetryableAgentError } from '@alint-js/core/agent'
import { Agent } from '@earendil-works/pi-agent-core'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'

export interface PiAdapterOptions {
  run: (request: AgentRequest) => Promise<PiMessage[]>
}

interface PiMessage {
  content?: unknown
  errorMessage?: unknown
  role?: unknown
  stopReason?: unknown
}

// NOTE(Makito): Extend this when necessary.
export function apiKeyFromModel(model: ResolvedModel): string {
  const auth = model.provider.headers.Authorization ?? model.provider.headers.authorization
  // Extract the key from header or fallback to a placeholder (no auth).
  return auth?.replace(/^Bearer\s+/i, '') ?? 'unused'
}

export function createPiAdapter(options: Partial<PiAdapterOptions> = {}): AgentAdapter {
  const run = options.run ?? runPiAgent

  return async (request: AgentRequest): Promise<AgentResult> => {
    let toolStarted = false
    const trackedRequest: AgentRequest = {
      ...request,
      tools: request.tools.map(tool => ({
        ...tool,
        execute: (input) => {
          toolStarted = true
          return tool.execute(input)
        },
      })),
    }

    try {
      request.signal?.throwIfAborted()
      const messages = await run(trackedRequest)
      request.signal?.throwIfAborted()
      const assistant = [...messages].reverse().find(message => message.role === 'assistant')

      if (assistant?.stopReason === 'error' || assistant?.stopReason === 'aborted') {
        throw new Error(
          typeof assistant.errorMessage === 'string'
            ? assistant.errorMessage
            : 'Pi agent failed',
        )
      }

      return {
        answer: extractPiText(assistant),
        usage: undefined,
      }
    }
    catch (error) {
      if (request.signal?.aborted)
        throw request.signal.reason
      if (!toolStarted)
        throw new RetryableAgentError('Pi agent invocation can be safely replayed', { cause: error })
      throw error
    }
  }
}

export function createPiModel(model: ResolvedModel): Model<'openai-completions'> {
  return {
    api: 'openai-completions',
    baseUrl: model.provider.endpoint,
    contextWindow: model.contextWindow ?? 32768,
    cost: {
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
      output: 0,
    },
    id: model.id,
    input: ['text'],
    maxTokens: 4096,
    name: model.name,
    provider: model.provider.id as Model<'openai-completions'>['provider'],
    reasoning: false,
  }
}

export function extractPiText(message?: PiMessage): string {
  if (!message) {
    return ''
  }

  const { content } = message

  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .filter((part): part is { text: string } => isTextPart(part))
      .map(part => part.text)
      .join('')
  }

  return ''
}

export function toPiTools(tools: AgentTool[]): PiTool[] {
  return tools.map((agentTool): PiTool => ({
    description: agentTool.description,
    execute: async (_toolCallId: string, params: unknown) => ({
      content: [
        {
          text: String(await agentTool.execute(params)),
          type: 'text',
        },
      ],
      details: undefined,
    }),
    label: agentTool.name,
    name: agentTool.name,
    parameters: agentTool.parameters,
  } as PiTool))
}

function isTextPart(part: unknown): part is { text: string, type: 'text' } {
  return typeof part === 'object'
    && part !== null
    && (part as { type?: unknown }).type === 'text'
    && typeof (part as { text?: unknown }).text === 'string'
}

async function runPiAgent(request: AgentRequest): Promise<PiMessage[]> {
  const model = createPiModel(request.model)
  const agent = new Agent({
    getApiKey: () => apiKeyFromModel(request.model),
    initialState: {
      model,
      systemPrompt: request.instructions,
      tools: toPiTools(request.tools),
    },
    // pi 1.x no longer picks a transport from `model.api`. Every alint model is an OpenAI-compatible
    // endpoint, so the agent's only model is the one built above and is streamed through that API
    // directly, without registering a provider.
    streamFn: (_model, context, options) => streamSimple(model, context, options),
  })
  const abort = () => agent.abort()
  request.signal?.addEventListener('abort', abort, { once: true })

  try {
    request.signal?.throwIfAborted()
    await agent.prompt(request.prompt)
    await agent.waitForIdle()
    request.signal?.throwIfAborted()

    return agent.state.messages as PiMessage[]
  }
  finally {
    request.signal?.removeEventListener('abort', abort)
  }
}

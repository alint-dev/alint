/// Super WIP

import type { ResolvedModel } from '@alint-js/core'
import type { AgentAdapter, AgentRequest, AgentResult, AgentTool, AgentUsage } from '@alint-js/core/agent'
import type { AgentChannel, AgentInput, Runner, RunnerContext, Tool, Usage } from 'apeira'

import { RetryableAgentError } from '@alint-js/core/agent'
import { chat, rawTool, user } from 'apeira'

import { isRetryableApeiraFailure } from './retry'
import { runSteps } from './steps'

export { runSteps } from './steps'
export type { StepsOptions, StepsResult } from './steps'

const defaultMaxSteps = 8

export interface ApeiraAdapterOptions {
  createRunner: (model: ResolvedModel) => Runner
  maxSteps: number
}

export function createApeiraAdapter(options: Partial<ApeiraAdapterOptions> = {}): AgentAdapter {
  const createRunner = options.createRunner ?? createApeiraRunner
  const maxSteps = options.maxSteps ?? defaultMaxSteps

  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new TypeError('Apeira adapter maxSteps must be a positive integer')
  }

  return async (request: AgentRequest): Promise<AgentResult> => {
    let toolStarted = false
    const runner = createRunner(request.model)

    try {
      const result = await runSteps(runner, buildRunnerContext(request, () => {
        toolStarted = true
      }), { maxSteps })

      return {
        answer: extractAnswer(result.output),
        usage: mapUsage(result.usage),
      }
    }
    catch (error) {
      if (!toolStarted && !request.signal?.aborted && isRetryableApeiraFailure(error)) {
        throw new RetryableAgentError('Apeira agent invocation can be safely replayed', { cause: error })
      }

      throw error
    }
  }
}

export function createApeiraRunner(model: ResolvedModel): Runner {
  return chat({
    baseURL: model.provider.endpoint,
    headers: model.provider.headers,
    model: model.id,
    streamOptions: { includeUsage: true },
  })
}

export function toRunnerTools(tools: AgentTool[], onToolStart: () => void = () => {}): Tool[] {
  return tools.map(agentTool => rawTool({
    description: agentTool.description,
    execute: async (input) => {
      onToolStart()
      const result = await agentTool.execute(input)
      return (result ?? '') as object | string | unknown[]
    },
    name: agentTool.name,
    parameters: agentTool.parameters,
  }))
}

function buildRunnerContext(request: AgentRequest, onToolStart: () => void): Omit<RunnerContext, 'stepNumber'> {
  return {
    abortSignal: request.signal,
    channel: noopChannel(),
    input: [
      user(request.prompt),
    ],
    instructions: request.instructions,
    tools: toRunnerTools(request.tools, onToolStart),
    turnId: 'alint',
  }
}

function extractAnswer(output: readonly AgentInput[]): string {
  for (let index = output.length - 1; index >= 0; index -= 1) {
    const item = output[index] as { content?: unknown, role?: unknown }

    if (item.role === 'assistant' && typeof item.content === 'string') {
      return item.content
    }
  }

  return ''
}

function mapUsage(usage?: Usage): AgentUsage | undefined {
  if (!usage) {
    return undefined
  }

  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  }
}

function noopChannel(): AgentChannel {
  return {
    emit: () => {},
    subscribe: () => () => {},
  }
}

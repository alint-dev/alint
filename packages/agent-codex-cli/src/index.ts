import type { AgentAdapter, AgentRequest, AgentResult, AgentUsage } from '@alint-js/core/agent'
import type { CodexOptions, RunResult, SandboxMode, ThreadOptions, TurnOptions, Usage } from '@openai/codex-sdk'

import process from 'node:process'

import { Codex } from '@openai/codex-sdk'

export interface CodexCliAdapterOptions {
  additionalDirectories: string[]
  approvalPolicy: ThreadOptions['approvalPolicy']
  codexPath: string
  config: NonNullable<CodexOptions['config']>
  cwd: string
  env: Record<string, string>
  outputSchema: NonNullable<TurnOptions['outputSchema']>
  run: (request: CodexCliRunRequest) => Promise<RunResult>
  sandbox: SandboxMode
  skipGitRepoCheck: boolean
  useRequestModel: boolean
}

export interface CodexCliRunRequest {
  codexOptions: CodexOptions
  input: string
  threadOptions: ThreadOptions
  turnOptions: TurnOptions
}

export function createCodexCliAdapter(options: Partial<CodexCliAdapterOptions> = {}): AgentAdapter {
  const run = options.run ?? runCodexSdk

  return async (request: AgentRequest): Promise<AgentResult> => {
    if (request.tools.length > 0) {
      throw new TypeError('Codex CLI adapter does not support alint AgentTool callbacks. Codex uses its own local tool runtime.')
    }

    const result = await run(createRunRequest(request, options))

    return {
      answer: result.finalResponse,
      usage: mapUsage(result.usage),
    }
  }
}

export function createRunRequest(
  request: AgentRequest,
  options: Partial<CodexCliAdapterOptions>,
): CodexCliRunRequest {
  const cwd = options.cwd ?? process.cwd()

  return {
    codexOptions: {
      ...(options.codexPath
        ? { codexPathOverride: options.codexPath }
        : {}),
      ...(options.config
        ? { config: options.config }
        : {}),
      ...(options.env
        ? { env: options.env }
        : {}),
    },
    input: formatPrompt(request),
    threadOptions: {
      ...(options.additionalDirectories
        ? { additionalDirectories: options.additionalDirectories }
        : {}),
      ...(options.approvalPolicy
        ? { approvalPolicy: options.approvalPolicy }
        : {}),
      ...(options.sandbox
        ? { sandboxMode: options.sandbox }
        : {}),
      ...(options.skipGitRepoCheck !== undefined
        ? { skipGitRepoCheck: options.skipGitRepoCheck }
        : {}),
      ...(options.useRequestModel
        ? { model: request.model.id }
        : {}),
      workingDirectory: cwd,
    },
    turnOptions: {
      ...(options.outputSchema
        ? { outputSchema: options.outputSchema }
        : {}),
      ...(request.signal
        ? { signal: request.signal }
        : {}),
    },
  }
}

function formatPrompt(request: AgentRequest): string {
  return [request.instructions, request.prompt].filter(Boolean).join('\n\n')
}

function mapUsage(usage: null | Usage): AgentUsage | undefined {
  if (!usage) {
    return undefined
  }

  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.input_tokens + usage.output_tokens,
  }
}

async function runCodexSdk(request: CodexCliRunRequest): Promise<RunResult> {
  const codex = new Codex(request.codexOptions)
  const thread = codex.startThread(request.threadOptions)

  return await thread.run(request.input, request.turnOptions)
}

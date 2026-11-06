import type { AgentInput, RunnerContext, RunnerResult } from 'apeira'

import { rawTool, user } from 'apeira'
import { describe, expect, it } from 'vitest'

import { runSteps } from './steps'

function answer(content: string): RunnerResult {
  return {
    output: [
      { content, role: 'assistant', type: 'message' },
    ],
    toolCalls: [],
  }
}

function callTool(name: string, id: string, args = '{}'): RunnerResult {
  return {
    output: [
      {
        arguments: args,
        call_id: id,
        name,
        type: 'function_call',
      },
    ],
    toolCalls: [
      {
        args,
        toolCallId: id,
        toolCallType: 'function',
        toolName: name,
      },
    ],
  }
}

function context(tools: RunnerContext['tools'] = []): Omit<RunnerContext, 'stepNumber'> {
  return {
    channel: {
      emit: () => {},
      subscribe: () => () => {},
    },
    input: [
      user('review this'),
    ],
    instructions: 'be careful',
    tools,
    turnId: 'test',
  }
}

function echoTool(calls: unknown[]) {
  return rawTool({
    description: 'echo the input',
    execute: (input) => {
      calls.push(input)
      return 'echoed'
    },
    name: 'echo',
    parameters: {
      properties: {
        text: { type: 'string' },
      },
      type: 'object',
    },
  })
}

describe('runSteps', () => {
  it('runs the requested tools and feeds their output into the next step', async () => {
    const toolInputs: unknown[] = []
    const seen: AgentInput[][] = []
    const steps = [
      callTool('echo', 'call-1', '{"text":"hi"}'),
      answer('done'),
    ]

    const result = await runSteps(async (ctx) => {
      seen.push([...ctx.input])
      return steps[ctx.stepNumber]
    }, context([
      echoTool(toolInputs),
    ]), { maxSteps: 8 })

    expect(toolInputs).toEqual([
      { text: 'hi' },
    ])
    expect(seen).toHaveLength(2)
    expect(seen[1].at(-1)).toEqual({ call_id: 'call-1', output: 'echoed', type: 'function_call_output' })
    expect(result.output.at(-1)).toEqual({ content: 'done', role: 'assistant', type: 'message' })
  })

  it('stops after maxSteps model calls even when the model keeps calling tools', async () => {
    const toolInputs: unknown[] = []
    let calls = 0

    await runSteps(async (ctx) => {
      calls += 1
      return callTool('echo', `call-${ctx.stepNumber}`)
    }, context([
      echoTool(toolInputs),
    ]), { maxSteps: 3 })

    expect(calls).toBe(3)
    expect(toolInputs).toHaveLength(3)
  })

  it('stops once until() holds after the tools ran', async () => {
    const toolInputs: unknown[] = []
    let calls = 0

    await runSteps(async () => {
      calls += 1
      return callTool('echo', `call-${calls}`)
    }, context([
      echoTool(toolInputs),
    ]), {
      maxSteps: 8,
      until: () => toolInputs.length === 2,
    })

    expect(calls).toBe(2)
    expect(toolInputs).toHaveLength(2)
  })

  it('sums usage across steps', async () => {
    const steps: RunnerResult[] = [
      {
        ...callTool('echo', 'call-1'),
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      },
      {
        ...answer('done'),
        usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 },
      },
    ]

    const result = await runSteps(async ctx => steps[ctx.stepNumber], context([
      echoTool([]),
    ]), { maxSteps: 8 })

    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 5, totalTokens: 35 })
  })
})

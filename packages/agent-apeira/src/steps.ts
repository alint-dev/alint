import type { AgentInput, Runner, RunnerContext, Usage } from 'apeira'

import { computeTotalUsage, executeTool } from '@xsai/shared-chat'

export interface StepsOptions {
  /** Upper bound on model calls. Tool calls from the last allowed step still run. */
  maxSteps: number
  /**
   * Checked after each step's tools have run; `true` finishes without asking the model again. A
   * failing tool does not throw here: xsai hands the error back to the model as the tool result,
   * so a predicate on the caller's own state lets the model retry a rejected call.
   */
  until?: () => boolean
}

export interface StepsResult {
  output: AgentInput[]
  usage?: Usage
}

/**
 * Drives an apeira runner until the model stops calling tools.
 *
 * Since apeira 0.0.8 a runner makes exactly one model call and returns its tool calls unexecuted;
 * the step loop and tool execution moved into `createAgent`. That loop has no step limit, and its
 * queue, storage and plugin machinery is more than a single lint call needs, so alint drives the
 * runner itself.
 */
export async function runSteps(
  runner: Runner,
  context: Omit<RunnerContext, 'stepNumber'>,
  options: StepsOptions,
): Promise<StepsResult> {
  // The chat runner rebuilds the whole conversation from `input` on every call, so each step gets
  // the original input plus everything produced so far.
  const input = [...context.input]
  let usage: undefined | Usage

  for (let stepNumber = 0; stepNumber < options.maxSteps; stepNumber += 1) {
    // A snapshot, because `input` keeps growing after the call and a runner may hold on to it.
    const result = await runner({
      ...context,
      input: [...input],
      stepNumber,
    })
    input.push(...result.output)
    if (result.usage != null)
      usage = computeTotalUsage(usage, result.usage)

    if (result.toolCalls.length === 0)
      break

    // NOTICE: mirrors apeira's own tool execution, minus plugin hooks and channel events, which
    // alint does not use. alint tools only return text or JSON, so the content-part branch of
    // apeira's `toToolOutput` is not needed.
    // `https://github.com/moeru-ai/apeira/blob/47508a5bbf4f7c493632686d372aa0ce91edc99c/packages/core/src/agent/tool.ts#L10-L47`
    const toolResults = await Promise.all(result.toolCalls.map(toolCall => executeTool({
      abortSignal: context.abortSignal,
      messages: [],
      toolCall: {
        function: { arguments: toolCall.args, name: toolCall.toolName },
        id: toolCall.toolCallId,
        type: 'function',
      },
      tools: context.tools,
      wrapResult: toolOutput => typeof toolOutput === 'string'
        ? toolOutput
        : JSON.stringify(toolOutput),
    })))

    for (const toolResult of toolResults) {
      input.push({
        call_id: toolResult.completionToolCall.toolCallId,
        output: toolResult.result,
        type: 'function_call_output',
      })
    }

    if (options.until?.() === true)
      break
  }

  return {
    output: input.slice(context.input.length),
    usage,
  }
}

import type { ResolvedModel, RuleDefinition } from '@alint-js/core'
import type { AgentTool, AgentUsage } from '@alint-js/core/agent'
import type { Runner, Tool } from 'apeira'

import type { DeclarativeFindingResponse, DeclarativeRuleDefinition } from '../../plugins/declarative/types'

import { formatOutputLanguageInstruction, formatSourceWithLineNumbers, toolParametersFromSchema } from '@alint-js/core/structured-output'
import { createTools } from '@alint-js/tools-fs'
import { chat, hasToolCall, or, rawTool, stepCountAtLeast, user } from 'apeira'
import { parse } from 'valibot'

import { declarativeFindingResponseSchema } from '../../plugins/declarative/types'
import { reportDeclarativeFindings } from './basic-structured'

const maxAgentSteps = 8
const reportFindingsToolName = 'report_findings'

interface CodingAgentRunOptions {
  cwd: string
  instruction: string
  outputLanguage?: string
  sourceText: string
  targetFilePath: string
  tools: AgentTool[]
}

export function createBasicCodingAgentRule(rule: DeclarativeRuleDefinition): RuleDefinition {
  return {
    cache: false,
    create: ctx => ({
      /**
       * Runs one tool-using declarative review for a planned file.
       *
       * Triggering workflow:
       *
       * {@link createBasicCodingAgentRule}
       *   -> `RuleHandlers.onTargetFile`
       *     -> {@link createCodingAgent}
       *
       * Upstream:
       * - {@link createBasicCodingAgentRule}
       *
       * Downstream:
       * - {@link createCodingAgent}
       * - {@link reportDeclarativeFindings}
       */
      async onTargetFile(target) {
        const model = await ctx.model()
        const file = await ctx.src.readFile(target.file)
        const result = await createCodingAgent(model).run({
          cwd: ctx.cwd,
          instruction: rule.instruction,
          outputLanguage: ctx.outputLanguage,
          sourceText: file.text,
          targetFilePath: target.file.path,
          tools: createTools(ctx.cwd),
        })

        if (result.usage) {
          ctx.metering.recordUsage({
            filePath: target.file.path,
            inputTokens: result.usage.inputTokens,
            metadata: {
              operation: `declarative-${rule.name}-coding-agent`,
            },
            modelId: model.id,
            outputTokens: result.usage.outputTokens,
            providerId: model.provider.id,
            ruleId: ctx.id,
            totalTokens: result.usage.totalTokens,
          })
        }

        reportDeclarativeFindings({
          ctx,
          excludeFiles: rule.excludeFiles,
          findings: result.findings,
          includeFiles: rule.includeFiles,
          targetFilePath: target.file.path,
        })
      },
    }),
  }
}

export function createCodingAgent(
  model: ResolvedModel,
  runner: Runner = chat({
    baseURL: model.provider.endpoint,
    headers: model.provider.headers,
    model: model.id,
    parallelToolCalls: false,
    stopWhen: or(hasToolCall(reportFindingsToolName), stepCountAtLeast(maxAgentSteps)),
    toolChoice: 'required',
  }),
) {
  return {
    async run(options: CodingAgentRunOptions): Promise<{
      findings: DeclarativeFindingResponse['findings']
      usage?: AgentUsage
    }> {
      let report: DeclarativeFindingResponse | undefined
      const tools: Tool[] = options.tools.map(agentTool => rawTool({
        description: agentTool.description,
        execute: async (input) => {
          const result = await agentTool.execute(input)
          return (result ?? '') as object | string | unknown[]
        },
        name: agentTool.name,
        parameters: agentTool.parameters,
      }))

      tools.push(rawTool({
        description: 'Submit all findings and finish the review. Submit an empty findings array when there are no issues, instead of a finding that states the target is already correct.',
        execute: async (input) => {
          report = parse(declarativeFindingResponseSchema, input)
          return report
        },
        name: reportFindingsToolName,
        parameters: toolParametersFromSchema(declarativeFindingResponseSchema),
        strict: true,
      }))

      const result = await runner({
        channel: {
          emit: () => {},
          subscribe: () => () => {},
        },
        input: [user([
          formatOutputLanguageInstruction(options.outputLanguage),
          `Project root: ${options.cwd}`,
          `Reviewed target file path: ${options.targetFilePath}`,
          `Reviewed target source with line numbers:\n\n${formatSourceWithLineNumbers(options.sourceText)}`,
        ].filter(Boolean).join('\n\n'))],
        instructions: [
          options.instruction,
          'Use the filesystem tools to inspect the project as needed before reaching a conclusion.',
          `When the review is complete, call ${reportFindingsToolName} exactly once with all findings. Submit an empty findings array when there are no issues, instead of a finding that states the target is already correct.`,
        ].join('\n\n'),
        tools,
        turnId: 'alint',
      })

      if (!report) {
        throw new Error(`basic-coding-agent stopped without calling ${reportFindingsToolName}`)
      }

      return {
        findings: report.findings,
        usage: result.usage
          ? {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              totalTokens: result.usage.totalTokens,
            }
          : undefined,
      }
    },
  }
}

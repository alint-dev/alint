import type { ResolvedModel } from '@alint-js/core'
import type { Runner, RunnerContext, RunnerResult, Usage } from 'apeira'

import { describe, expect, it } from 'vitest'

import { createBasicCodingAgentRule, createCodingAgent } from './basic-coding-agent'

const model: ResolvedModel = {
  aliases: [],
  capabilities: [],
  id: 'test-model',
  name: 'Test Model',
  params: {},
  provider: {
    endpoint: 'https://example.test/v1',
    headers: {},
    id: 'test-provider',
    type: 'openai-compatible',
  },
}

function callTool(name: string, id: string, args: unknown, usage?: Usage): RunnerResult {
  const serialized = JSON.stringify(args)

  return {
    output: [
      {
        arguments: serialized,
        call_id: id,
        name,
        type: 'function_call',
      },
    ],
    toolCalls: [
      {
        args: serialized,
        toolCallId: id,
        toolCallType: 'function',
        toolName: name,
      },
    ],
    usage,
  }
}

describe('basic-coding-agent declarative preset', () => {
  it('creates a non-cacheable rule without requiring ctx.agent', () => {
    const rule = createBasicCodingAgentRule({
      builtInAgent: 'basic-coding-agent',
      excludeFiles: [],
      filePath: '/repo/rules/reinvented/rule.alint.toml',
      instruction: 'Find reinvented helpers.',
      name: 'reinvented-helper',
    })

    expect(rule.cache).toBe(false)
    expect(rule.create).toEqual(expect.any(Function))
  })

  it('runs filesystem tools across steps and returns the terminal report', async () => {
    const readCalls: unknown[] = []
    const report = {
      findings: [
        { filePath: 'src/main.py', line: 1, message: 'move helper' },
      ],
    }
    const seen: RunnerContext[] = []
    const steps = [
      callTool('read_file', 'call-read', { path: 'src/utils.py' }, { inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
      callTool('report_findings', 'call-report', report, { inputTokens: 20, outputTokens: 5, totalTokens: 25 }),
    ]
    const runner: Runner = async (context) => {
      seen.push(context)
      return steps[context.stepNumber]
    }

    const result = await createCodingAgent(model, runner).run({
      cwd: '/repo',
      instruction: 'Find reinvented helpers.',
      outputLanguage: '简体中文',
      sourceText: 'def main():\n    pass\n',
      targetFilePath: '/repo/src/main.py',
      tools: [
        {
          description: 'Read file',
          execute: (input) => {
            readCalls.push(input)
            return 'contents'
          },
          name: 'read_file',
          parameters: { type: 'object' },
        },
      ],
    })

    expect(seen).toHaveLength(2)
    expect(seen[0].instructions).toContain('Find reinvented helpers.')
    expect(seen[0].instructions).toContain('call report_findings')
    expect(seen[0].input).toEqual([
      {
        content: expect.stringContaining('1 | def main():'),
        role: 'user',
        type: 'message',
      },
    ])
    expect(seen[0].tools.map(tool => tool.function.name)).toEqual(['read_file', 'report_findings'])
    expect(seen[1].input.at(-1)).toEqual({ call_id: 'call-read', output: 'contents', type: 'function_call_output' })
    expect(readCalls).toEqual([
      { path: 'src/utils.py' },
    ])
    expect(result).toEqual({
      findings: report.findings,
      usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
    })
  })

  it('hands an invalid report back to the model and accepts the corrected one', async () => {
    const report = {
      findings: [
        { filePath: 'src/main.ts', line: 1, message: 'fixed' },
      ],
    }
    const seen: RunnerContext[] = []
    const steps = [
      callTool('report_findings', 'call-invalid', {
        findings: [
          { line: '1', message: 'bad' },
        ],
      }),
      callTool('report_findings', 'call-valid', report),
    ]
    const runner: Runner = async (context) => {
      seen.push(context)
      return steps[context.stepNumber]
    }

    const result = await createCodingAgent(model, runner).run({
      cwd: '/repo',
      instruction: 'Review.',
      sourceText: 'const value = 1',
      targetFilePath: '/repo/src/main.ts',
      tools: [],
    })

    expect(seen).toHaveLength(2)
    expect(seen[1].input.at(-1)).toMatchObject({ call_id: 'call-invalid', type: 'function_call_output' })
    expect(result.findings).toEqual(report.findings)
  })

  it('rejects a run that stops without report_findings', async () => {
    const runner: Runner = async () => ({ output: [], toolCalls: [] })

    await expect(createCodingAgent(model, runner).run({
      cwd: '/repo',
      instruction: 'Review.',
      sourceText: 'const value = 1',
      targetFilePath: '/repo/src/main.ts',
      tools: [],
    })).rejects.toThrow('basic-coding-agent stopped without calling report_findings')
  })
})

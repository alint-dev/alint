import type { AgentAdapter, AgentRequest } from '@alint-js/core/agent'
import type { PlannedSourceTarget, ResolvedModel, RuleContext } from '@alint-js/plugin'

import type { ReinventedHelperFinding } from './index'

import { createHash } from 'node:crypto'

import { createSourceRuntime } from '@alint-js/core'
import { describe, expect, it } from 'vitest'

import {
  agentExamplePlugin,
  buildReinventedHelperPrompt,
  createAgentExamplePlugin,
  createReadFileTool,
  createReportFindingTool,
  reinventedHelperInstructions,
} from './index'

const sourceText = 'import { clamp } from \'./utils\'\n\nexport function clampValue(value: number) {\n  return Math.min(Math.max(value, 0), 1)\n}\n'

function createResolvedModel(): ResolvedModel {
  return {
    aliases: [],
    capabilities: ['tool-call'],
    id: 'model',
    name: 'model',
    params: {},
    provider: {
      endpoint: 'http://localhost:11434/v1',
      headers: {},
      id: 'provider',
      type: 'openai-compatible',
    },
  }
}

function createRuleContext(agent?: AgentAdapter): RuleContext {
  return {
    agent,
    cwd: '/repo',
    id: 'agent-example/reinvented-helper',
    localId: 'reinvented-helper',
    logger: {
      debug: () => {},
    },
    metering: {
      recordUsage: () => {},
    },
    model: async () => createResolvedModel(),
    options: [],
    report: () => {},
    settings: {},
    src: createSourceRuntime({
      readFile: async file => ({
        contentHash: createHash('sha256').update(sourceText).digest('hex'),
        language: 'plaintext',
        lines: sourceText.split('\n'),
        path: typeof file === 'string'
          ? file
          : file.path,
        text: sourceText,
      }),
    }),
  }
}

function createSourceTarget<Kind extends PlannedSourceTarget['kind']>(kind: Kind, path = '/repo/src/math.ts'): PlannedSourceTarget & { kind: Kind } {
  const file = {
    contentHash: createHash('sha256').update(sourceText).digest('hex'),
    language: 'plaintext',
    path,
  }

  return {
    file,
    identity: `${kind}:demo`,
    kind,
    language: file.language,
  }
}

function getRule() {
  const rule = agentExamplePlugin.rules?.['reinvented-helper']

  if (!rule) {
    throw new Error('Expected agent example plugin to expose the reinvented-helper rule')
  }

  return rule
}

describe('agentExamplePlugin', () => {
  it('exposes the reinvented-helper rule and a recommended config', () => {
    expect(agentExamplePlugin.rules?.['reinvented-helper']).toBeDefined()
    expect(agentExamplePlugin.configs?.recommended).toEqual([
      {
        files: ['**/*.ts'],
        language: 'plaintext',
        rules: {
          'agent-example/reinvented-helper': 'warn',
        },
      },
    ])
  })

  it('builds the plugin without requiring callers to inject an agent adapter', () => {
    const plugin = createAgentExamplePlugin()

    expect(plugin.rules?.['reinvented-helper']).toBeDefined()
    expect(plugin.configs?.recommended).toEqual(agentExamplePlugin.configs?.recommended)
  })

  it('exposes the rule through onTargetFile only', () => {
    const handlers = getRule().create(createRuleContext())

    expect(handlers.onTargetFile).toBeTypeOf('function')
    expect('onFile' in handlers).toBe(false)
    expect('onFunction' in handlers).toBe(false)
    expect('onClass' in handlers).toBe(false)
  })

  it('throws a clear error when the rule runs without a configured agent', async () => {
    await expect(getRule().create(createRuleContext()).onTargetFile?.(createSourceTarget('file')))
      .rejects
      .toThrow(/requires an agent/i)
  })

  it('ignores non-TypeScript files before invoking the agent', async () => {
    let invoked = false
    const context = createRuleContext(async () => {
      invoked = true
      return { answer: '' }
    })

    await getRule().create(context).onTargetFile?.(createSourceTarget('file', '/repo/src/math.go'))

    expect(invoked).toBe(false)
  })

  it('invokes ctx.agent and maps recorded findings into diagnostics', async () => {
    let captured: AgentRequest | undefined
    const agent: AgentAdapter = async (request) => {
      captured = request

      const report = request.tools.find(tool => tool.name === 'report_finding')
      if (!report) {
        throw new Error('Expected the rule to expose a report_finding tool')
      }

      await report.execute({
        line: 3,
        message: 'clampValue reimplements clamp() from ./utils.',
        suggestion: 'Import clamp from ./utils instead of hand-rolling it.',
      })

      return { answer: 'done' }
    }

    const diagnostics: Parameters<RuleContext['report']>[0][] = []
    const context = createRuleContext(agent)
    context.report = diagnostic => diagnostics.push(diagnostic)

    await getRule().create(context).onTargetFile?.(createSourceTarget('file'))

    expect(captured?.instructions).toBe(reinventedHelperInstructions)
    expect(captured?.model.id).toBe('model')
    expect(captured?.prompt).toContain('/repo/src/math.ts')
    expect(captured?.prompt).toContain('3 | export function clampValue(value: number) {')
    expect(captured?.tools.map(tool => tool.name)).toEqual(['read_file', 'report_finding'])

    expect(diagnostics).toEqual([
      {
        evidence: {
          suggestion: 'Import clamp from ./utils instead of hand-rolling it.',
        },
        filePath: '/repo/src/math.ts',
        loc: {
          start: {
            column: 0,
            line: 3,
          },
        },
        message: 'clampValue reimplements clamp() from ./utils.',
      },
    ])
  })
})

describe('reinvented-helper tools', () => {
  it('reads files relative to the project root through ctx.src', async () => {
    let requestedPath: string | undefined
    const tool = createReadFileTool({
      readFile: async (filePath) => {
        const path = typeof filePath === 'string'
          ? filePath
          : filePath.path
        requestedPath = path
        const text = 'export const clamp = 1'
        return {
          contentHash: createHash('sha256').update(text).digest('hex'),
          language: 'plaintext',
          lines: [text],
          path,
          text,
        }
      },
    }, '/repo')

    const text = await tool.execute({ path: 'src/utils.ts' })

    expect(requestedPath).toBe('/repo/src/utils.ts')
    expect(text).toBe('export const clamp = 1')
  })

  it('returns a readable message when a file cannot be read', async () => {
    const tool = createReadFileTool({
      readFile: async () => {
        throw new Error('ENOENT: no such file')
      },
    }, '/repo')

    const result = await tool.execute({ path: 'missing.ts' })

    expect(result).toContain('Could not read "missing.ts"')
    expect(result).toContain('ENOENT: no such file')
  })

  it('records one finding per report_finding call', async () => {
    const findings: ReinventedHelperFinding[] = []
    const tool = createReportFindingTool(findings)

    const acknowledgement = await tool.execute({
      line: 7,
      message: 'Duplicates isPlainObject from the shared utils.',
      suggestion: 'Reuse the shared isPlainObject helper.',
    })

    expect(acknowledgement).toBe('recorded')
    expect(findings).toEqual([
      {
        line: 7,
        message: 'Duplicates isPlainObject from the shared utils.',
        suggestion: 'Reuse the shared isPlainObject helper.',
      },
    ])
  })

  it('ignores a duplicate report for a line already recorded', async () => {
    const findings: ReinventedHelperFinding[] = []
    const tool = createReportFindingTool(findings)

    await tool.execute({ line: 7, message: 'first', suggestion: 'a' })
    const second = await tool.execute({ line: 7, message: 'second', suggestion: 'b' })

    expect(second).toBe('Already recorded a finding for line 7.')
    expect(findings).toEqual([
      { line: 7, message: 'first', suggestion: 'a' },
    ])
  })
})

describe('buildReinventedHelperPrompt', () => {
  it('builds a prompt with the file path and line-numbered source', () => {
    const prompt = buildReinventedHelperPrompt('/repo/src/math.ts', 'const a = 1\nconst b = 2\n')

    expect(prompt).toContain('Review this file: /repo/src/math.ts')
    expect(prompt).toContain('1 | const a = 1')
    expect(prompt).toContain('2 | const b = 2')
  })
})

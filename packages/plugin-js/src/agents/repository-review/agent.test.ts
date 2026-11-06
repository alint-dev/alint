import type { AgentAdapter, AgentRequest, AgentTool } from '@alint-js/core/agent'
import type { FileTarget, RuleContext } from '@alint-js/plugin'

import { createHash } from 'node:crypto'

import { createSourceRuntime } from '@alint-js/core'
import { createTools } from '@alint-js/tools-fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RepositoryReviewProtocolError, reviewRepository } from './agent'

vi.mock('@alint-js/tools-fs', () => ({
  createTools: vi.fn(),
}))

const mockedCreateTools = vi.mocked(createTools)
const source = 'export const parse = (value: string) => value.trim()'
const target: FileTarget = {
  file: {
    contentHash: createHash('sha256').update(source).digest('hex'),
    language: 'typescript',
    path: '/repo/src/parse.ts',
  },
  identity: 'file:src/parse.ts',
  kind: 'file',
  language: 'typescript',
}
const options = {
  allowedCategories: ['coupling'],
  instructions: 'Inspect repository evidence.',
  operation: 'repository-review',
  prompt: 'Find coupled policy.',
} as const

function createContext(agent: AgentAdapter, recordUsage = vi.fn()): RuleContext {
  return {
    agent,
    cwd: '/repo',
    id: 'js/repository-review',
    localId: 'repository-review',
    logger: {
      debug: () => {},
    },
    metering: { recordUsage },
    model: async () => ({
      aliases: [],
      capabilities: ['tool-call'],
      id: 'model',
      name: 'model',
      params: {},
      provider: {
        endpoint: '',
        headers: {},
        id: 'provider',
        type: 'openai-compatible',
      },
    }),
    options: [],
    report: () => {},
    settings: {},
    src: createSourceRuntime({
      readFile: async file => ({
        contentHash: createHash('sha256').update(source).digest('hex'),
        language: 'typescript',
        lines: [source],
        path: typeof file === 'string'
          ? file
          : file.path,
        text: source,
      }),
    }),
  }
}

function filesystemTool(name: string): AgentTool {
  return {
    description: name,
    execute: async () => name === 'read_file'
      ? 'supporting source'
      : 'src/support.ts:1',
    name,
    parameters: {
      additionalProperties: false,
      properties: {},
      required: [],
      type: 'object',
    },
  }
}

function toolNamed(request: AgentRequest, name: string): AgentTool {
  const tool = request.tools.find(candidate => candidate.name === name)

  if (!tool) {
    throw new Error(`Missing tool ${name}`)
  }

  return tool
}

describe('reviewRepository', () => {
  beforeEach(() => {
    mockedCreateTools.mockReset()
    mockedCreateTools.mockReturnValue([
      filesystemTool('read_file'),
      filesystemTool('list_files'),
      filesystemTool('search_files'),
      filesystemTool('search_in_files'),
    ])
  })

  it('reuses the standard filesystem tools without a repository security mode', async () => {
    const agent: AgentAdapter = async (request) => {
      await toolNamed(request, 'submit_review').execute({ findings: [] })
      return { answer: 'done' }
    }

    await reviewRepository(createContext(agent), target, options)

    expect(mockedCreateTools).toHaveBeenCalledWith('/repo')
  })

  it('returns one structured finding and records model usage', async () => {
    const agent: AgentAdapter = async (request) => {
      await toolNamed(request, 'search_in_files').execute({ query: 'parse' })
      await toolNamed(request, 'read_file').execute({ path: 'src/support.ts' })
      await toolNamed(request, 'submit_review').execute({
        findings: [
          {
            category: 'coupling',
            futureFailure: 'A format change would require both files to change.',
            line: 1,
            message: 'Two files own one policy.',
            proof: 'src/parse.ts:1 duplicates src/support.ts:1.',
            relatedLocations: ['src/support.ts:1'],
            suggestion: 'Move the policy to one owner.',
          },
        ],
      })

      return {
        answer: 'done',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }
    }
    const recordUsage = vi.fn()

    const findings = await reviewRepository(createContext(agent, recordUsage), target, {
      ...options,
      requireFutureFailure: true,
      requireRelatedLocations: true,
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toBe('Two files own one policy.')
    expect(recordUsage).toHaveBeenCalledOnce()
  })

  it('rejects a finding outside the configured schema', async () => {
    let rejected: unknown
    const agent: AgentAdapter = async (request) => {
      rejected = await toolNamed(request, 'submit_review').execute({
        findings: [
          {
            category: 'unsupported',
            futureFailure: null,
            line: 2,
            message: 'Invalid.',
            proof: 'Invalid.',
            relatedLocations: [],
            suggestion: 'Invalid.',
          },
        ],
      })
      await toolNamed(request, 'submit_review').execute({ findings: [] })
      return { answer: 'done' }
    }

    await reviewRepository(createContext(agent), target, options)

    expect(rejected).toMatch(/review rejected/i)
  })

  it('fails when the agent does not submit a review', async () => {
    const agent: AgentAdapter = async () => ({ answer: 'done' })

    await expect(reviewRepository(createContext(agent), target, options))
      .rejects
      .toBeInstanceOf(RepositoryReviewProtocolError)
  })
})

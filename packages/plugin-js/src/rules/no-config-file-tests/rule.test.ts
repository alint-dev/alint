import type { FileTarget, RuleContext } from '@alint-js/plugin'

import { createHash } from 'node:crypto'

import { createSourceRuntime } from '@alint-js/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { judgeSource } from '../../agents/judge/agent'
import { configFileTestsRule } from './rule'

vi.mock('../../agents/judge/agent', () => ({
  judgeSource: vi.fn(),
}))

const mockedJudgeSource = vi.mocked(judgeSource)
const source = [
  'import config from \'../eslint.config\'',
  '',
  'it(\'keeps no-console configured\', () => {',
  '  expect(config.rules).toContain(\'no-console\')',
  '})',
].join('\n')

function createContext() {
  const diagnostics: Parameters<RuleContext['report']>[0][] = []
  const context: RuleContext = {
    cwd: '/repo',
    id: 'js/no-config-file-tests',
    localId: 'no-config-file-tests',
    logger: { debug: () => {} },
    metering: { recordUsage: () => {} },
    model: async () => ({
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
    }),
    options: [],
    report: diagnostic => diagnostics.push(diagnostic),
    settings: {},
    src: createSourceRuntime({
      readFile: async file => ({
        contentHash: createHash('sha256').update(source).digest('hex'),
        language: 'typescript',
        lines: source.split('\n'),
        path: typeof file === 'string' ? file : file.path,
        text: source,
      }),
    }),
  }

  return { context, diagnostics }
}

function createFileTarget(path: string): FileTarget {
  const file = {
    contentHash: createHash('sha256').update(source).digest('hex'),
    language: 'typescript',
    path,
  }

  return {
    file,
    identity: `file:${path}`,
    kind: 'file',
    language: file.language,
  }
}

// https://discord.com/channels/1127171173982154893/1554151684026929214
describe('configFileTestsRule', () => {
  beforeEach(() => {
    mockedJudgeSource.mockReset()
  })

  it('does not judge the configuration file itself', async () => {
    const { context, diagnostics } = createContext()

    await configFileTestsRule.create(context).onTargetFile?.(createFileTarget('/repo/eslint.config.ts'))

    expect(mockedJudgeSource).not.toHaveBeenCalled()
    expect(diagnostics).toEqual([])
  })

  it('judges a test file beside the configuration it tests', async () => {
    mockedJudgeSource.mockResolvedValueOnce([
      {
        confidence: 'high',
        line: 4,
        message: 'The assertion repeats the severity the eslint config already declares.',
        suggestion: 'Delete the test; the configuration already states this rule.',
      },
    ])
    const { context, diagnostics } = createContext()

    await configFileTestsRule.create(context).onTargetFile?.(createFileTarget('/repo/eslint.config.test.ts'))

    expect(mockedJudgeSource.mock.calls[0]?.[0].operation).toBe('config-file-tests-judge')
    expect(mockedJudgeSource.mock.calls[0]?.[0].source).toBe(source)
    expect(diagnostics).toEqual([
      {
        evidence: {
          confidence: 'high',
          suggestion: 'Delete the test; the configuration already states this rule.',
        },
        filePath: '/repo/eslint.config.test.ts',
        loc: { start: { column: 0, line: 4 } },
        message: 'The assertion repeats the severity the eslint config already declares.',
      },
    ])
  })

  it('judges a spec file that carries no test suffix', async () => {
    mockedJudgeSource.mockResolvedValueOnce([])
    const { context, diagnostics } = createContext()

    await configFileTestsRule.create(context).onTargetFile?.(createFileTarget('/repo/src/__tests__/lint-rules.ts'))

    expect(mockedJudgeSource).toHaveBeenCalledTimes(1)
    expect(diagnostics).toEqual([])
  })
})

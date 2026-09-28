import type { AlintConfig, SetupConfig } from '@alint-js/core'

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runAlint } from '@alint-js/core'
import { describe, expect, it, vi } from 'vitest'

import { builtInAgentVersions, createDeclarativeCacheKey } from './cache-key'
import { createDeclarativePlugin } from './plugin'
import { builtInAgentNames } from './types'

const generateStructuredMock = vi.hoisted(() => vi.fn())

vi.mock('@alint-js/core/structured-output', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@alint-js/core/structured-output')>()

  return {
    ...actual,
    generateStructured: generateStructuredMock,
  }
})

function createSetupConfig(): SetupConfig {
  return {
    providers: [
      {
        endpoint: 'http://localhost:11434/v1',
        id: 'ollama',
        models: [
          {
            aliases: ['default'],
            capabilities: ['structured-output'],
            id: 'local:qwen-8b',
            name: 'qwen:8b',
            size: 'small',
          },
        ],
        type: 'openai-compatible',
      },
    ],
    version: 1,
  }
}

describe('declarative rule cache key', () => {
  it('re-runs a declarative rule after its instruction changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-declarative-cache-'))
    const targetPath = join(root, 'demo.txt')
    const cacheLocation = join(root, '.alintcache')
    const ruleFilePath = join(root, 'rules', 'rule.alint.toml')

    await writeFile(targetPath, 'hello\n')

    const createConfig = (instruction: string): AlintConfig => [
      {
        files: ['**/*.txt'],
        language: 'plaintext',
        plugins: {
          demo: createDeclarativePlugin({
            rules: [
              {
                builtInAgent: 'basic-structured',
                excludeFiles: [],
                filePath: ruleFilePath,
                instruction,
                name: 'review',
              },
            ],
          }),
        },
        rules: {
          'demo/review': 'warn',
        },
      },
    ]

    generateStructuredMock.mockResolvedValue({ findings: [{ line: 1, message: 'first instruction finding' }] })

    const first = await runAlint({
      config: createConfig('Report the first problem.'),
      cwd: root,
      files: [targetPath],
      runner: { cache: { location: cacheLocation } },
      setupConfig: createSetupConfig(),
    })

    generateStructuredMock.mockResolvedValue({ findings: [{ line: 1, message: 'second instruction finding' }] })

    const second = await runAlint({
      config: createConfig('Report a completely different problem.'),
      cwd: root,
      files: [targetPath],
      runner: { cache: { location: cacheLocation } },
      setupConfig: createSetupConfig(),
    })

    // A cache entry keyed only by the rule source would replay the first instruction's finding here.
    expect(generateStructuredMock).toHaveBeenCalledTimes(2)
    expect(first.diagnostics.map(diagnostic => diagnostic.message)).toEqual(['first instruction finding'])
    expect(second.diagnostics.map(diagnostic => diagnostic.message)).toEqual(['second instruction finding'])
  })

  it('reuses the cached finding while the instruction and the target stay unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-declarative-cache-stable-'))
    const targetPath = join(root, 'demo.txt')
    const cacheLocation = join(root, '.alintcache')
    const ruleFilePath = join(root, 'rules', 'rule.alint.toml')

    await writeFile(targetPath, 'hello\n')
    generateStructuredMock.mockResolvedValue({ findings: [{ line: 1, message: 'stable finding' }] })

    const config: AlintConfig = [
      {
        files: ['**/*.txt'],
        language: 'plaintext',
        plugins: {
          demo: createDeclarativePlugin({
            rules: [
              {
                builtInAgent: 'basic-structured',
                excludeFiles: [],
                filePath: ruleFilePath,
                instruction: 'Report the stable problem.',
                name: 'review',
              },
            ],
          }),
        },
        rules: {
          'demo/review': 'warn',
        },
      },
    ]

    const run = () => runAlint({
      config,
      cwd: root,
      files: [targetPath],
      runner: { cache: { location: cacheLocation } },
      setupConfig: createSetupConfig(),
    })

    await run()
    generateStructuredMock.mockClear()

    const second = await run()

    expect(generateStructuredMock).not.toHaveBeenCalled()
    expect(second.diagnostics.map(diagnostic => diagnostic.message)).toEqual(['stable finding'])
  })
})

describe('createDeclarativeCacheKey', () => {
  const createRule = (overrides: Partial<Parameters<typeof createDeclarativeCacheKey>[0]> = {}) => ({
    builtInAgent: 'basic-structured' as const,
    excludeFiles: [],
    filePath: '/repo/rules/semantic/rule.alint.toml',
    instruction: 'Find semantic boundary issues.',
    name: 'semantic-boundary',
    ...overrides,
  })

  it('covers every built-in agent', () => {
    expect(Object.keys(builtInAgentVersions).sort()).toEqual([...builtInAgentNames].sort())
  })

  it('changes when the rule instruction changes', () => {
    expect(createDeclarativeCacheKey(createRule()))
      .not
      .toEqual(createDeclarativeCacheKey(createRule({ instruction: 'Find reinvented helpers.' })))
  })

  it('changes when the reviewed file scope changes', () => {
    expect(createDeclarativeCacheKey(createRule()))
      .not
      .toEqual(createDeclarativeCacheKey(createRule({ excludeFiles: ['**/*.test.ts'] })))
    expect(createDeclarativeCacheKey(createRule()))
      .not
      .toEqual(createDeclarativeCacheKey(createRule({ includeFiles: ['src/**/*.ts'] })))
  })

  it('ignores inputs that cannot change the findings', () => {
    expect(createDeclarativeCacheKey(createRule()))
      .toEqual(createDeclarativeCacheKey(createRule({ name: 'renamed-rule' })))
  })
})

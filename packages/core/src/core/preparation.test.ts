import type { LanguageDefinition } from '../dsl/types'

import { describe, expect, it } from 'vitest'

import { definePlugin, defineRule } from '../dsl/define'
import { stableHash } from './hash'
import { createBuiltInLanguageRegistry, registerLanguage, resolveLanguageForPath } from './languages'
import { prepareRun } from './preparation'

const fileRule = defineRule({
  create: () => ({
    onTargetFile: () => {},
  }),
})
const directoryRule = defineRule({
  create: () => ({
    onTargetDirectory: () => {},
  }),
})
const projectRule = defineRule({
  create: () => ({
    onTargetProject: () => {},
  }),
})

function createConfig(
  extras: Record<string, unknown> = {},
  languages: Record<string, LanguageDefinition> = {},
) {
  return [
    {
      ...extras,
      plugins: {
        company: definePlugin({
          configs: {
            marker: {
              settings: { marker: 'PREPARATION_CONFIG_MARKER' },
            },
          },
          languages,
          rules: {
            directory: directoryRule,
            file: fileRule,
            project: projectRule,
          },
        }),
      },
      rules: {
        'company/directory': 'warn' as const,
        'company/file': 'warn' as const,
        'company/project': 'warn' as const,
      },
    },
  ]
}

describe('prepareRun', () => {
  it('prepares nonexistent paths synchronously in input and registry order', () => {
    const preparation = prepareRun({
      config: createConfig(),
      cwd: '/repo',
      directories: ['packages/core'],
      files: ['src/b.ts', 'src/a.ts'],
      projectTargets: true,
    })

    expect(preparation).not.toBeInstanceOf(Promise)
    expect(Object.keys(preparation.files[0] ?? {}).sort()).toEqual([
      'agent',
      'configHash',
      'fileIndex',
      'language',
      'languageOptions',
      'path',
      'rules',
      'settings',
    ])
    expect(Object.keys(preparation.directories[0] ?? {}).sort()).toEqual([
      'agent',
      'configHash',
      'directoryIndex',
      'rules',
      'settings',
      'target',
    ])
    expect(Object.keys(preparation.project ?? {}).sort()).toEqual([
      'agent',
      'configHash',
      'root',
      'rules',
      'settings',
    ])
    expect(JSON.stringify(preparation)).not.toContain('PREPARATION_CONFIG_MARKER')
    expect(preparation.files.map(input => ({
      fileIndex: input.fileIndex,
      language: input.language.name,
      path: input.path,
      rules: input.rules.map(rule => [rule.ruleIndex, rule.enabledRule.id]),
    }))).toEqual([
      {
        fileIndex: 0,
        language: 'typescript',
        path: '/repo/src/b.ts',
        rules: [
          [0, 'company/directory'],
          [1, 'company/file'],
          [2, 'company/project'],
        ],
      },
      {
        fileIndex: 1,
        language: 'typescript',
        path: '/repo/src/a.ts',
        rules: [
          [0, 'company/directory'],
          [1, 'company/file'],
          [2, 'company/project'],
        ],
      },
    ])
    expect(preparation.directories.map(input => ({
      directoryIndex: input.directoryIndex,
      rules: input.rules.map(rule => [rule.ruleIndex, rule.enabledRule.id]),
      target: input.target,
    }))).toEqual([
      {
        directoryIndex: 0,
        rules: [
          [0, 'company/directory'],
          [1, 'company/file'],
          [2, 'company/project'],
        ],
        target: { kind: 'directory', path: '/repo/packages/core' },
      },
    ])
    expect(preparation.project).toMatchObject({
      root: '/repo',
      rules: [
        {
          enabledRule: { id: 'company/directory' },
          ruleIndex: 0,
        },
        {
          enabledRule: { id: 'company/file' },
          ruleIndex: 1,
        },
        {
          enabledRule: { id: 'company/project' },
          ruleIndex: 2,
        },
      ],
    })
  })

  it('filters ignored inputs before assigning contiguous indexes', () => {
    const preparation = prepareRun({
      config: [
        {
          ignores: ['ignored/**', 'ignored-directory'],
        },
        ...createConfig(),
      ],
      cwd: '/repo',
      directories: ['ignored-directory', 'packages/core', 'packages/cli'],
      files: ['ignored/a.ts', 'src/b.ts', 'src/a.ts'],
      projectTargets: false,
    })

    expect(preparation.files.map(input => [input.fileIndex, input.path])).toEqual([
      [0, '/repo/src/b.ts'],
      [1, '/repo/src/a.ts'],
    ])
    expect(preparation.directories.map(input => [input.directoryIndex, input.target.path])).toEqual([
      [0, '/repo/packages/core'],
      [1, '/repo/packages/cli'],
    ])
    expect(preparation.project).toBeUndefined()

    const ignoredProject = prepareRun({
      config: [
        {
          ignores: ['**'],
        },
        ...createConfig(),
      ],
      cwd: '/repo/generated',
    })

    expect(ignoredProject.project).toBeUndefined()
  })

  it('registers plugin languages while preparing files', () => {
    const markdownLanguage: LanguageDefinition = {
      extensions: ['.mdx'],
      extract: () => [],
      name: 'markdown',
    }
    const config = createConfig({}, { markdown: markdownLanguage })

    const preparation = prepareRun({
      config,
      cwd: '/repo',
      files: ['README.mdx'],
    })

    expect(preparation.files[0]?.language).toBe(markdownLanguage)
  })

  it('hashes the effective file and aggregate configuration inputs', () => {
    const first = prepareRun({
      config: createConfig({
        languageOptions: { jsx: false },
        settings: { mode: 'first' },
      }),
      cwd: '/repo',
      directories: ['src'],
      files: ['src/a.ts'],
    })
    const second = prepareRun({
      config: createConfig({
        languageOptions: { jsx: true },
        settings: { mode: 'second' },
      }),
      cwd: '/repo',
      directories: ['src'],
      files: ['src/a.ts'],
    })

    expect(first.files[0]?.configHash).toBe(stableHash({
      language: undefined,
      languageOptions: { jsx: false },
      processor: undefined,
      resolvedLanguage: 'typescript',
      settings: { mode: 'first' },
    }))
    expect(first.directories[0]?.configHash).toBe(stableHash({
      settings: { mode: 'first' },
    }))
    expect(first.project?.configHash).toBe(stableHash({
      settings: { mode: 'first' },
    }))
    expect(second.files[0]?.configHash).not.toBe(first.files[0]?.configHash)
    expect(second.directories[0]?.configHash).not.toBe(first.directories[0]?.configHash)
    expect(second.project?.configHash).not.toBe(first.project?.configHash)
  })
})

describe('resolveLanguageForPath', () => {
  it('uses override, processed language, extension, then text fallback', () => {
    const registry = createBuiltInLanguageRegistry()

    expect(resolveLanguageForPath('/repo/file.ts', registry, { language: 'plaintext', processedLanguage: 'javascript' }).name).toBe('plaintext')
    expect(resolveLanguageForPath('/repo/file.unknown', registry, { processedLanguage: 'typescript' }).name).toBe('typescript')
    expect(resolveLanguageForPath('/repo/file.ts', registry, {}).name).toBe('typescript')
    expect(resolveLanguageForPath('/repo/file.unknown', registry, {}).name).toBe('plaintext')
  })

  it('resolves registered languages and rejects unknown overrides', () => {
    const registry = createBuiltInLanguageRegistry()
    const language: LanguageDefinition = {
      extensions: ['.go'],
      extract: () => [],
      name: 'go',
    }
    registerLanguage(registry, language)

    expect(resolveLanguageForPath('/repo/main.go', registry, {})).toBe(language)
    expect(() => resolveLanguageForPath('/repo/main.go', registry, { language: 'rust' })).toThrow('Unknown language "rust".')
  })
})

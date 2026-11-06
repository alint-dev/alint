import type { AlintConfigExtends } from '../dsl/types'

import { describe, expect, it } from 'vitest'

import { definePlugin, defineRule } from '../dsl/define'
import {
  normalizeConfig,
  resolveConfigForDirectory,
  resolveConfigForFile,
  resolveConfigForProject,
} from './config-array'

describe('config array resolution', () => {
  const plugin = definePlugin({
    configs: {
      recommended: [
        {
          rules: {
            'review/file-review': 'warn',
          },
        },
      ],
    },
    rules: {
      'file-review': defineRule({
        create: () => ({
          onTargetWith: () => {},
        }),
      }),
      'strict-review': defineRule({
        create: () => ({
          onTargetWith: () => {},
        }),
      }),
    },
  })

  it('normalizes nested flat config arrays', () => {
    const first = { name: 'first' }
    const second = { name: 'second' }
    const third = { name: 'third' }

    expect(normalizeConfig([
      first,
      [
        second,
        [third],
      ],
    ])).toEqual([first, second, third])
  })

  it('does not enable rules from plugin registration alone', () => {
    const result = resolveConfigForFile('/repo/main.go', [
      {
        plugins: { review: plugin },
      },
    ], { cwd: '/repo' })

    expect(result.config.rules).toEqual({})
    expect(result.config.plugins).toEqual({ review: plugin })
  })

  it('resolves directory rules without matching file patterns', () => {
    const result = resolveConfigForDirectory('/repo/crates/auv-cli-invoke', [
      {
        directories: ['crates/*'],
        plugins: { review: plugin },
        rules: { 'review/file-review': 'warn' },
      },
      {
        files: ['**/Cargo.toml'],
        rules: { 'review/strict-review': 'warn' },
      },
    ], { cwd: '/repo' })

    expect(result.config.rules).toEqual({
      'review/file-review': 'warn',
    })
  })

  it('keeps an empty files matcher global for file targets', () => {
    const result = resolveConfigForFile('/repo/main.go', [
      {
        files: [],
        rules: { 'review/file-review': 'warn' },
      },
    ], { cwd: '/repo' })

    expect(result.config.rules).toEqual({
      'review/file-review': 'warn',
    })
  })

  it('resolves only global config for a project target', () => {
    const result = resolveConfigForProject('/repo', [
      {
        name: 'global',
        rules: { 'review/file-review': 'warn' },
      },
      {
        files: ['**/*.go'],
        name: 'files',
        rules: { 'review/strict-review': 'warn' },
      },
      {
        directories: ['crates/*'],
        name: 'directories',
        rules: { 'review/strict-review': 'error' },
      },
    ], { cwd: '/repo' })

    expect(result.matched.map(item => item.name)).toEqual(['global'])
    expect(result.config.rules).toEqual({
      'review/file-review': 'warn',
    })
  })

  it('applies a global ignore to the project root', () => {
    const result = resolveConfigForProject('/repo/generated', [
      {
        ignores: ['generated/**'],
        name: 'global ignores',
      },
      {
        name: 'global',
        rules: { 'review/file-review': 'warn' },
      },
    ], { cwd: '/repo' })

    expect(result.ignored).toBe(true)
  })

  it('applies later matching rule entries over earlier ones', () => {
    const result = resolveConfigForFile('/repo/src/main.go', [
      {
        files: ['**/*.go'],
        plugins: { review: plugin },
        rules: { 'review/file-review': 'warn' },
      },
      {
        files: ['src/**'],
        rules: { 'review/file-review': 'off' },
      },
    ], { cwd: '/repo' })

    expect(result.config.rules).toEqual({ 'review/file-review': 'off' })
    expect(result.matched.map(item => item.name)).toEqual([undefined, undefined])
  })

  it('expands plugin config extends before local fields', () => {
    const result = resolveConfigForFile('/repo/main.go', [
      {
        extends: ['review/recommended'],
        plugins: { review: plugin },
        rules: {
          'review/strict-review': 'error',
        },
      },
    ], { cwd: '/repo' })

    expect(result.config.rules).toEqual({
      'review/file-review': 'warn',
      'review/strict-review': 'error',
    })
  })

  it('constrains plugin config extends to parent matchers', () => {
    const srcResult = resolveConfigForFile('/repo/src/main.go', [
      {
        extends: ['review/recommended'],
        files: ['src/**'],
        plugins: { review: plugin },
      },
    ], { cwd: '/repo' })
    const testResult = resolveConfigForFile('/repo/test/main.go', [
      {
        extends: ['review/recommended'],
        files: ['src/**'],
        plugins: { review: plugin },
      },
    ], { cwd: '/repo' })

    expect(srcResult.config.rules).toEqual({ 'review/file-review': 'warn' })
    expect(testResult.config.rules).toEqual({})
  })

  it('intersects nested matcher scopes from extended configs', () => {
    const scopedPlugin = definePlugin({
      configs: {
        recommended: [
          {
            extends: [
              {
                files: ['**/*.go'],
                rules: { 'review/file-review': 'warn' },
              },
            ],
            files: ['src/**'],
            ignores: ['src/generated/**'],
          },
        ],
      },
    })

    const sourceResult = resolveConfigForFile('/repo/packages/core/src/main.go', [
      {
        basePath: 'packages/core',
        extends: ['review/recommended'],
        files: ['src/**'],
        plugins: { review: scopedPlugin },
      },
    ], { cwd: '/repo' })
    const generatedResult = resolveConfigForFile('/repo/packages/core/src/generated/main.go', [
      {
        basePath: 'packages/core',
        extends: ['review/recommended'],
        files: ['src/**'],
        plugins: { review: scopedPlugin },
      },
    ], { cwd: '/repo' })
    const testResult = resolveConfigForFile('/repo/packages/core/test/main.go', [
      {
        basePath: 'packages/core',
        extends: ['review/recommended'],
        files: ['src/**'],
        plugins: { review: scopedPlugin },
      },
    ], { cwd: '/repo' })
    const swiftResult = resolveConfigForFile('/repo/packages/core/src/main.swift', [
      {
        basePath: 'packages/core',
        extends: ['review/recommended'],
        files: ['src/**'],
        plugins: { review: scopedPlugin },
      },
    ], { cwd: '/repo' })

    expect(sourceResult.config.rules).toEqual({ 'review/file-review': 'warn' })
    expect(generatedResult.config.rules).toEqual({})
    expect(testResult.config.rules).toEqual({})
    expect(swiftResult.config.rules).toEqual({})
  })

  it('supports nested AND file patterns', () => {
    const result = resolveConfigForFile('/repo/src/main.go', [
      {
        files: [
          ['src/**', '**/*.go'],
        ],
        rules: { 'review/file-review': 'warn' },
      },
      {
        files: [
          ['src/**', '**/*.swift'],
        ],
        rules: { 'review/strict-review': 'warn' },
      },
    ], { cwd: '/repo' })

    expect(result.config.rules).toEqual({ 'review/file-review': 'warn' })
  })

  it('honors global ignores', () => {
    const result = resolveConfigForFile('/repo/dist/main.go', [
      {
        ignores: ['dist/**'],
        name: 'global ignores',
      },
      {
        files: ['**/*.go'],
        rules: { 'review/file-review': 'warn' },
      },
    ], { cwd: '/repo' })

    expect(result.ignored).toBe(true)
    expect(result.config.rules).toEqual({})
    expect(result.matched).toEqual([])
  })

  it('uses item ignores to skip only that config item', () => {
    const result = resolveConfigForFile('/repo/src/generated/main.go', [
      {
        files: ['src/**'],
        ignores: ['src/generated/**'],
        rules: { 'review/file-review': 'warn' },
      },
      {
        files: ['src/**'],
        rules: { 'review/strict-review': 'error' },
      },
    ], { cwd: '/repo' })

    expect(result.config.rules).toEqual({ 'review/strict-review': 'error' })
    expect(result.skipped).toHaveLength(1)
  })

  it('scopes files and ignores to basePath', () => {
    const result = resolveConfigForFile('/repo/packages/core/src/main.go', [
      {
        basePath: 'packages/core',
        files: ['src/**'],
        ignores: ['src/generated/**'],
        rules: { 'review/file-review': 'warn' },
      },
      {
        basePath: 'packages/cli',
        files: ['src/**'],
        rules: { 'review/strict-review': 'error' },
      },
    ], { cwd: '/repo' })

    expect(result.config.rules).toEqual({ 'review/file-review': 'warn' })
    expect(result.skipped.map(entry => entry.item.basePath)).toEqual(['packages/cli'])
  })

  it('shallow merges config objects and applies later scalar fields', () => {
    const firstProcessor = {
      preprocess: () => [],
    }
    const secondProcessor = {
      preprocess: () => [],
    }
    const result = resolveConfigForFile('/repo/main.go', [
      {
        language: 'plaintext',
        languageOptions: { parser: 'a', sourceType: 'module' },
        linterOptions: { noInlineConfig: true },
        processor: firstProcessor,
        runner: { agentRetries: 1, ruleConcurrency: 1, timeoutMs: 100 },
        settings: {
          review: { depth: 'light' },
          shared: true,
        },
      },
      {
        language: 'go',
        languageOptions: { parser: 'b' },
        linterOptions: { reportUnusedDisableDirectives: 'warn' },
        processor: secondProcessor,
        runner: { agentRetries: 3, timeoutMs: 200 },
        settings: {
          review: { depth: 'strict' },
        },
      },
    ], { cwd: '/repo' })

    expect(result.config.language).toBe('go')
    expect(result.config.processor).toBe(secondProcessor)
    expect(result.config.languageOptions).toEqual({ parser: 'b', sourceType: 'module' })
    expect(result.config.linterOptions).toEqual({
      noInlineConfig: true,
      reportUnusedDisableDirectives: 'warn',
    })
    expect(result.config.runner).toEqual({ agentRetries: 3, ruleConcurrency: 1, timeoutMs: 200 })
    expect(result.config.settings).toEqual({
      review: { depth: 'strict' },
      shared: true,
    })
  })

  it('resolves the agent adapter as a last-write-wins scalar field', () => {
    const firstAgent = async () => ({ answer: 'first' })
    const secondAgent = async () => ({ answer: 'second' })

    const result = resolveConfigForFile('/repo/main.ts', [
      { agent: firstAgent },
      { agent: secondAgent },
    ], { cwd: '/repo' })

    expect(result.config.agent).toBe(secondAgent)
  })

  it('does not copy matching and provenance fields into the effective config', () => {
    const result = resolveConfigForFile('/repo/main.go', [
      {
        basePath: '.',
        extends: [],
        files: ['**/*.go'],
        ignores: ['dist/**'],
        name: 'go',
        rules: { 'review/file-review': 'warn' },
      },
    ], { cwd: '/repo' })

    expect(result.config).not.toHaveProperty('basePath')
    expect(result.config).not.toHaveProperty('extends')
    expect(result.config).not.toHaveProperty('files')
    expect(result.config).not.toHaveProperty('ignores')
    expect(result.config).not.toHaveProperty('name')
  })

  it('throws when duplicate plugin aliases point to different objects', () => {
    const otherPlugin = definePlugin({ rules: {} })

    expect(() => resolveConfigForFile('/repo/main.go', [
      {
        plugins: { review: plugin },
      },
      {
        plugins: { review: otherPlugin },
      },
    ], { cwd: '/repo' })).toThrow('Duplicate plugin alias "review".')
  })

  it('throws for unknown plugin config extends', () => {
    expect(() => resolveConfigForFile('/repo/main.go', [
      {
        extends: ['review/missing'],
        plugins: { review: plugin },
      },
    ], { cwd: '/repo' })).toThrow('Unknown config "review/missing".')
  })

  it('throws for circular config extends', () => {
    const recursivePlugin = definePlugin({
      configs: {
        recommended: [
          {
            extends: ['review/recommended'],
          },
        ],
      },
    })

    expect(() => resolveConfigForFile('/repo/main.go', [
      {
        extends: ['review/recommended'],
        plugins: { review: recursivePlugin },
      },
    ], { cwd: '/repo' })).toThrow('Circular config extends: review/recommended -> review/recommended')
  })

  it('throws for circular inline config extends', () => {
    const recursiveConfig = {
      extends: [] as AlintConfigExtends[],
      rules: { 'review/file-review': 'warn' as const },
    }
    recursiveConfig.extends = [recursiveConfig]

    expect(() => resolveConfigForFile('/repo/main.go', [
      recursiveConfig,
    ], { cwd: '/repo' })).toThrow('Circular inline config extends.')
  })
})

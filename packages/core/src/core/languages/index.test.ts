import type { LanguageDefinition } from '../../dsl/types'

import { describe, expect, it } from 'vitest'

import { createSourceFile, createSourceRuntime } from '../source/runtime'
import { createBuiltInLanguageRegistry, registerLanguage, resolveLanguage } from './index'

describe('language registry', () => {
  it('prefers explicit language over extension inference', () => {
    const registry = createBuiltInLanguageRegistry()
    const file = createSourceFile('/repo/main.ts', 'export const value = 1\n')

    expect(resolveLanguage(file, registry, { language: 'plaintext' }).name).toBe('plaintext')
  })

  it('prefers explicit language over processed source language', () => {
    const registry = createBuiltInLanguageRegistry()
    const file = createSourceFile('/repo/main.js', 'export const value: number = 1\n')

    expect(resolveLanguage(file, registry, {
      language: 'plaintext',
      processedLanguage: 'typescript',
    }).name).toBe('plaintext')
  })

  it('prefers processed source language over extension inference', () => {
    const registry = createBuiltInLanguageRegistry()
    const file = createSourceFile('/repo/main.js', 'export const value: number = 1\n')

    expect(resolveLanguage(file, registry, { processedLanguage: 'typescript' }).name).toBe('typescript')
  })

  it('uses resolved processed source language when extracting JavaScript source targets', async () => {
    const registry = createBuiltInLanguageRegistry()
    const file = createSourceFile('/repo/main.js', 'export function load() {\n  return 1\n}\n')
    const language = resolveLanguage(file, registry, { processedLanguage: 'typescript' })
    const targets = await language.extract(file, {
      cwd: '/repo',
      languageOptions: {},
      src: createSourceRuntime(),
    })

    expect(language.name).toBe('typescript')
    expect(targets.map(target => target.kind)).toEqual(['file', 'function'])
    expect(targets[0]?.language).toBe('typescript')
    expect(targets[1]?.language).toBe('typescript')
  })

  it('falls back to plaintext for unknown extensions', () => {
    const registry = createBuiltInLanguageRegistry()
    const file = createSourceFile('/repo/main.go', 'package main\n')

    expect(resolveLanguage(file, registry, {}).name).toBe('plaintext')
  })

  it('uses built-in typescript for ts files', () => {
    const registry = createBuiltInLanguageRegistry()
    const file = createSourceFile('/repo/main.ts', 'export const value = 1\n')

    expect(resolveLanguage(file, registry, {}).name).toBe('typescript')
  })

  it('uses built-in javascript for JavaScript extensions', () => {
    const registry = createBuiltInLanguageRegistry()

    for (const extension of ['.cjs', '.js', '.jsx', '.mjs']) {
      const file = createSourceFile(`/repo/main${extension}`, 'export const value = 1\n')

      expect(resolveLanguage(file, registry, {}).name).toBe('javascript')
    }
  })

  it('uses built-in typescript for TypeScript extensions', () => {
    const registry = createBuiltInLanguageRegistry()

    for (const extension of ['.cts', '.mts', '.ts', '.tsx']) {
      const file = createSourceFile(`/repo/main${extension}`, 'export const value = 1\n')

      expect(resolveLanguage(file, registry, {}).name).toBe('typescript')
    }
  })

  it('throws for unknown explicit language', () => {
    const registry = createBuiltInLanguageRegistry()
    const file = createSourceFile('/repo/main.ts', 'export const value = 1\n')

    expect(() => resolveLanguage(file, registry, { language: 'go' })).toThrow('Unknown language "go".')
  })

  it('throws when duplicate language ids point to different objects', () => {
    const registry = createBuiltInLanguageRegistry()
    const language = createLanguage({ name: 'typescript' })

    expect(() => registerLanguage(registry, language)).toThrow('Duplicate language "typescript".')
  })

  it('allows registering the same language object more than once', () => {
    const registry = createBuiltInLanguageRegistry()
    const language = createLanguage({
      extensions: ['.demo'],
      name: 'demo',
    })

    registerLanguage(registry, language)
    registerLanguage(registry, language)

    expect(registry.languages.get('demo')).toBe(language)
    expect(registry.byExtension.get('.demo')).toBe('demo')
  })

  it('throws when duplicate extensions point to different language owners', () => {
    const registry = createBuiltInLanguageRegistry()
    const language = createLanguage({
      extensions: ['.ts'],
      name: 'typed',
    })

    expect(() => registerLanguage(registry, language)).toThrow('Duplicate language extension ".ts".')
  })

  it('does not register language or extensions when a later extension conflicts', () => {
    const registry = createBuiltInLanguageRegistry()
    const language = createLanguage({
      extensions: ['.free', '.ts'],
      name: 'typed',
    })

    expect(() => registerLanguage(registry, language)).toThrow('Duplicate language extension ".ts".')
    expect(registry.languages.has('typed')).toBe(false)
    expect(registry.byExtension.has('.free')).toBe(false)
  })

  it('plaintext extractor returns a whole-file target', async () => {
    const registry = createBuiltInLanguageRegistry()
    const file = createSourceFile('/repo/README', 'hello\nworld\n')
    const language = resolveLanguage(file, registry, {})
    const targets = await language.extract(file, {
      cwd: '/repo',
      languageOptions: {},
      src: createSourceRuntime(),
    })

    expect(targets).toEqual([
      {
        file,
        identity: 'file',
        kind: 'file',
        language: 'plaintext',
        origin: { physicalPath: '/repo/README' },
        text: 'hello\nworld\n',
      },
    ])
  })

  it('javascript and typescript built-ins extract JavaScript source targets', async () => {
    const registry = createBuiltInLanguageRegistry()
    const file = createSourceFile('/repo/main.ts', 'export function load() {\n  return 1\n}\n')
    const language = resolveLanguage(file, registry, {})
    const targets = await language.extract(file, {
      cwd: '/repo',
      languageOptions: {},
      src: createSourceRuntime(),
    })

    expect(targets.map(target => target.kind)).toEqual(['file', 'function'])
    expect(targets[0]?.identity).toBe('file')
    expect(targets[1]?.identity).toBe('function:load')
    expect(targets[1]?.name).toBe('load')
    expect(targets[1]?.language).toBe('typescript')
  })

  it('javascript built-in extracts JavaScript source targets with javascript language', async () => {
    const registry = createBuiltInLanguageRegistry()
    const file = createSourceFile('/repo/main.js', 'export function load() {\n  return 1\n}\n')
    const language = resolveLanguage(file, registry, {})
    const targets = await language.extract(file, {
      cwd: '/repo',
      languageOptions: {},
      src: createSourceRuntime(),
    })

    expect(language.name).toBe('javascript')
    expect(targets.map(target => target.kind)).toEqual(['file', 'function'])
    expect(targets[0]?.identity).toBe('file')
    expect(targets[0]?.language).toBe('javascript')
    expect(targets[1]?.identity).toBe('function:load')
    expect(targets[1]?.name).toBe('load')
    expect(targets[1]?.language).toBe('javascript')
  })
})

function createLanguage(input: Partial<LanguageDefinition> & Pick<LanguageDefinition, 'name'>): LanguageDefinition {
  return {
    extract: () => [],
    ...input,
  }
}

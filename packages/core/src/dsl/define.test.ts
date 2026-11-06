import type { ProjectFileEntry, ProjectTargetEntry } from './index'

import { number, object, optional } from 'valibot'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { defineConfig, definePlugin, defineRule } from './define'

describe('define helpers', () => {
  it('exports compact project descriptors from the DSL entrypoint', () => {
    expectTypeOf<keyof ProjectFileEntry>().toEqualTypeOf<'contentHash' | 'language' | 'path' | 'targetCount'>()
    expectTypeOf<keyof ProjectTargetEntry>().toEqualTypeOf<'filePath' | 'identity' | 'kind' | 'name' | 'range'>()
  })

  it('defines compact project handlers that read source lazily', () => {
    const projectRule = defineRule({
      create: ctx => ({
        async onTargetProject(project) {
          for (const entry of project.files) {
            const file = await ctx.src.readFile(entry.path)
            if (file.text.includes('deprecated-api'))
              ctx.report({ filePath: entry.path, message: 'deprecated API used' })
          }
        },
      }),
    })

    expect(projectRule.create).toBeTypeOf('function')
  })

  it('exposes all target lifecycle handlers from a rule', () => {
    const onTargetClass = () => {}
    const onTargetDirectory = () => {}
    const onTargetFile = () => {}
    const onTargetFunction = () => {}
    const onTargetProject = () => {}
    const rule = defineRule({
      create: () => ({
        onTargetClass,
        onTargetDirectory,
        onTargetFile,
        onTargetFunction,
        onTargetProject,
      }),
      languages: 'any',
    })

    expect(rule.create({} as never)).toEqual({
      onTargetClass,
      onTargetDirectory,
      onTargetFile,
      onTargetFunction,
      onTargetProject,
    })
  })

  it('keeps flat config arrays unchanged', () => {
    const rule = defineRule({
      create: () => ({
        onTargetWith: () => {},
      }),
    })
    const plugin = definePlugin({
      rules: {
        review: rule,
      },
    })
    const config = defineConfig([
      {
        files: ['**/*.go'],
        plugins: { demo: plugin },
        rules: { 'demo/review': 'warn' },
      },
    ])

    expect(config).toEqual([
      {
        files: ['**/*.go'],
        plugins: { demo: plugin },
        rules: { 'demo/review': 'warn' },
      },
    ])
  })

  it('does not allow a catch-all handler alongside specialized handlers', () => {
    const create = () => ({
      onTargetFile: () => {},
      onTargetWith: () => {},
    })

    // @ts-expect-error catch-all and specialized handlers would execute the same target twice.
    const rule = defineRule({ create })

    expect(rule.create).toBe(create)
  })

  it('does not imply rule enablement from plugin registration', () => {
    const plugin = definePlugin({
      rules: {
        review: defineRule({
          create: () => ({
            onTargetWith: () => {},
          }),
        }),
      },
    })
    const [item] = defineConfig([
      {
        plugins: { demo: plugin },
      },
    ])

    expect(item).not.toHaveProperty('rules')
  })

  it('infers rule options from valibot schemas in rule contexts', () => {
    const rule = defineRule({
      create: (context) => {
        const [options] = context.options
        const maxLines: number = options.maxLines

        // @ts-expect-error maxLines is a number after Valibot parsing.
        const invalidMaxLines: string = options.maxLines

        return {
          onTargetWith: () => {
            expect(maxLines).toBeTypeOf('number')
            expect(invalidMaxLines).toBeTypeOf('number')
          },
        }
      },
      options: [
        object({
          maxLines: optional(number(), 10),
        }),
      ],
    })

    expect(rule.options).toHaveLength(1)
  })

  it('infers same-item plugin rule names and rule option entries in defineConfig', () => {
    const plugin = definePlugin({
      rules: {
        noOptions: defineRule({
          create: () => ({}),
        }),
        review: defineRule({
          create: () => ({}),
          options: [
            object({
              maxLines: optional(number(), 10),
            }),
          ],
        }),
      },
    })

    defineConfig([
      {
        plugins: { demo: plugin },
        rules: {
          'demo/review': [
            'warn',
            { maxLines: 20 },
          ],
        },
      },
    ])

    defineConfig([
      {
        plugins: { demo: plugin },
        rules: {
          // @ts-expect-error known schema-less rules do not accept positional options.
          'demo/noOptions': [
            'warn',
            { maxLines: 20 },
          ],
        },
      },
    ])

    defineConfig([
      {
        plugins: { demo: plugin },
        rules: {
          'demo/review': ['warn'],
        },
      },
    ])

    defineConfig([
      {
        plugins: { demo: plugin },
        rules: {
          // @ts-expect-error maxLines must be a number.
          'demo/review': [
            'warn',
            { maxLines: 'twenty' },
          ],
        },
      },
    ])
  })
})

import type { ProjectFileEntry, ProjectTargetEntry } from './index'

import { number, object, optional } from 'valibot'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { defineConfig, definePlugin, defineRule } from './index'

describe('@alint-js/plugin helpers', () => {
  it('exports compact project descriptors through the plugin facade', () => {
    expectTypeOf<keyof ProjectFileEntry>().toEqualTypeOf<'contentHash' | 'language' | 'path' | 'targetCount'>()
    expectTypeOf<keyof ProjectTargetEntry>().toEqualTypeOf<'filePath' | 'identity' | 'kind' | 'name' | 'range'>()
  })

  it('returns plugin DSL objects unchanged', () => {
    const rule = defineRule({
      create: () => ({}),
    })
    const plugin = definePlugin({
      rules: { demo: rule },
    })
    const input = [
      {
        plugins: { demo: plugin },
        rules: { 'demo/demo': 'warn' },
      },
    ] as const
    const config = defineConfig(input)

    expect(plugin.rules?.demo).toBe(rule)
    expect(config).toBe(input)
  })

  it('preserves typed rule options through the plugin facade', () => {
    const rule = defineRule({
      create: (context) => {
        const [options] = context.options
        const maxLines: number = options.maxLines

        // @ts-expect-error maxLines is a number after parsing.
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
    const plugin = definePlugin({
      rules: { review: rule },
    })
    const input = [
      {
        plugins: { demo: plugin },
        rules: {
          'demo/review': [
            'warn',
            { maxLines: 20 },
          ],
        },
      },
    ] as const
    const config = defineConfig(input)

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

    expect(config).toBe(input)
  })
})

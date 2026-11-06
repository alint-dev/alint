import type { LanguageDefinition } from '../../dsl/types'
import type { SourceTarget } from './types'

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { defineConfig, definePlugin, defineRule } from '../../dsl/define'
import { runAlint } from '../run'

const dslLanguage: LanguageDefinition = {
  extensions: ['.dsl'],
  extract: file => [
    {
      file,
      identity: `dsl:${file.path}`,
      kind: 'file',
      language: 'dsl',
      metadata: { lineCount: file.lines.length },
      origin: { physicalPath: file.path },
      text: file.text,
    },
  ],
  name: 'dsl',
}

/** Runs `use` inside a `.txt` file's handler, where `ctx.src` is the run's own wired runtime. */
async function withExtract(
  cwd: string,
  use: (extract: (path: string) => Promise<SourceTarget[]>) => Promise<void>,
): Promise<void> {
  const linted = join(cwd, 'probe.txt')
  await writeFile(linted, 'probe\n')

  let ran = false
  let failure: unknown

  const rule = defineRule({
    create: ctx => ({
      onTargetFile: async () => {
        ran = true
        try {
          await use(path => ctx.src.extract(path))
        }
        catch (error) {
          failure = error
        }
      },
    }),
  })

  await runAlint({
    config: defineConfig([
      {
        plugins: {
          probe: definePlugin({
            languages: { dsl: dslLanguage },
            rules: { rule },
          }),
        },
        rules: { 'probe/rule': 'warn' },
      },
    ]),
    cwd,
    files: [linted],
    runner: { cache: false },
    setupConfig: { providers: [], version: 1 },
  })

  expect(ran).toBe(true)
  if (failure !== undefined)
    throw failure
}

describe('src.extract', () => {
  it('parses a file the run never linted, through its registered language', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-src-extract-'))
    await writeFile(join(cwd, 'shape.dsl'), 'one\ntwo\n')

    await withExtract(cwd, async (extract) => {
      const targets = await extract(join(cwd, 'shape.dsl'))

      expect(targets).toHaveLength(1)
      expect(targets[0].language).toBe('dsl')
      expect(targets[0].metadata?.lineCount).toBe(3)
    })
  })

  it('returns [] for an ignored file rather than throwing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-src-extract-ignored-'))
    await writeFile(join(cwd, 'skip.dsl'), 'ignored\n')

    const linted = join(cwd, 'probe.txt')
    await writeFile(linted, 'probe\n')

    let targets: SourceTarget[] | undefined
    let ran = false

    const rule = defineRule({
      create: ctx => ({
        onTargetFile: async () => {
          ran = true
          targets = await ctx.src.extract(join(cwd, 'skip.dsl'))
        },
      }),
    })

    await runAlint({
      config: defineConfig([
        {
          plugins: {
            probe: definePlugin({
              languages: { dsl: dslLanguage },
              rules: { rule },
            }),
          },
          rules: { 'probe/rule': 'warn' },
        },
        {
          ignores: ['**/skip.dsl'],
        },
      ]),
      cwd,
      files: [linted],
      runner: { cache: false },
      setupConfig: { providers: [], version: 1 },
    })

    expect(ran).toBe(true)
    expect(targets).toStrictEqual([])
  })

  it('honours a language pin passed to extract', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-src-extract-pin-'))
    await writeFile(join(cwd, 'mystery.unknown'), 'x\n')

    await withExtract(cwd, async (extract) => {
      const fallback = await extract(join(cwd, 'mystery.unknown'))
      expect(fallback[0].language).toBe('plaintext')

      const pinned = await runExtractWith(cwd, 'mystery.unknown', 'dsl')
      expect(pinned[0].language).toBe('dsl')
    })
  })
})

/** A second run whose handler pins the extract language, kept apart so the assertion reads plainly. */
async function runExtractWith(cwd: string, name: string, language: string): Promise<SourceTarget[]> {
  const linted = join(cwd, 'probe2.txt')
  await writeFile(linted, 'probe\n')

  let targets: SourceTarget[] = []

  const rule = defineRule({
    create: ctx => ({
      onTargetFile: async () => {
        targets = await ctx.src.extract(join(cwd, name), { language })
      },
    }),
  })

  await runAlint({
    config: defineConfig([
      {
        plugins: {
          probe: definePlugin({
            languages: { dsl: dslLanguage },
            rules: { rule },
          }),
        },
        rules: { 'probe/rule': 'warn' },
      },
    ]),
    cwd,
    files: [linted],
    runner: { cache: false },
    setupConfig: { providers: [], version: 1 },
  })

  return targets
}

import { relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createFixtureContext, FIXTURES_DIR as FIXTURES } from './fixtures'
import { helpersIn, repoIndexFor, twinsOf } from './index'

function helperNamed(index: Awaited<ReturnType<typeof indexFixtures>>, name: string, directory: string) {
  const helper = index.helpers.find(entry => entry.name === name && entry.id.startsWith(directory))

  if (helper === undefined) {
    throw new Error(`fixtures have no helper "${name}" under ${directory}`)
  }

  return helper
}

async function indexFixtures() {
  return repoIndexFor(createFixtureContext(), {
    cwd: FIXTURES,
    ignores: ['alint.config.ts'],
    maxLines: 10,
    minTokens: 5,
  })
}

describe('repoIndexFor', () => {
  it('indexes helpers across every language it can parse', async () => {
    const index = await indexFixtures()
    const languages = new Set(index.helpers.map(helper => helper.language))

    expect(languages.has('typescript')).toBe(true)
    expect(languages.has('rust')).toBe(true)
    expect(languages.has('go')).toBe(true)
    expect(languages.has('python')).toBe(true)
  })

  it('is built once per run, however many files ask for it', async () => {
    const ctx = createFixtureContext()
    const options = {
      cwd: FIXTURES,
      ignores: [],
      maxLines: 10,
      minTokens: 5,
    }

    const [first, second] = await Promise.all([
      repoIndexFor(ctx, options),
      repoIndexFor(ctx, options),
    ])

    expect(second).toBe(first)
  })

  it('gives every helper an id a model can quote back', async () => {
    const index = await indexFixtures()
    const helper = helperNamed(index, 'isNodeError', 'ts/store.ts')

    // Derived, not spelled out: the line moves whenever the fixture's comments do.
    expect(helper.id).toBe(`${relative(FIXTURES, helper.filePath)}:${helper.line}`)
    expect(index.byId.get(helper.id)).toBe(helper)
  })

  it('reads the helpers of one file', async () => {
    const index = await indexFixtures()
    const names = helpersIn(index, resolve(FIXTURES, 'ts/walk.ts')).map(helper => helper.name)

    expect(names).toStrictEqual(['walkDirectory', 'walkFiles'])
  })
})

describe('twinsOf, across every language', () => {
  // Each language ships an original, a verbatim copy, a copy that renamed only what it declares, and
  // two accessors that share a shape. The accessors are load-bearing: blinding every identifier
  // would collapse them.
  const LANGUAGES = [
    {
      accessors: ['readName', 'readSize'],
      copy: 'isNodeError',
      directory: 'ts/',
      name: 'typescript',
      original: 'isNodeError',
      renamed: 'hasErrorCode',
    },
    {
      accessors: ['read_name', 'read_size'],
      copy: 'is_missing',
      directory: 'rust/',
      name: 'rust',
      original: 'is_missing',
      renamed: 'is_absent',
    },
    {
      accessors: ['ReadName', 'ReadSize'],
      copy: 'isMissing',
      directory: 'go/',
      name: 'go',
      original: 'isMissing',
      renamed: 'isAbsent',
    },
    {
      accessors: ['read_name', 'read_size'],
      copy: 'is_missing',
      directory: 'python/',
      name: 'python',
      original: 'is_missing',
      renamed: 'is_absent',
    },
  ] as const

  for (const language of LANGUAGES) {
    describe(language.name, () => {
      it('finds the character-for-character copy', async () => {
        const index = await indexFixtures()
        const original = helperNamed(index, language.original, `${language.directory}store`)
        const twins = twinsOf(index, original, 'exact')

        expect(twins).toHaveLength(1)
        expect(twins[0].name).toBe(language.copy)
        expect(twins[0].id.startsWith(`${language.directory}archive`)).toBe(true)
      })

      it('finds the copy that renamed only what it declares', async () => {
        const index = await indexFixtures()
        const original = helperNamed(index, language.original, `${language.directory}store`)
        const renamed = helperNamed(index, language.renamed, `${language.directory}renamed`)

        expect(renamed.alphaFingerprint).toBe(original.alphaFingerprint)
        expect(renamed.exactFingerprint).not.toBe(original.exactFingerprint)
        expect(twinsOf(index, renamed, 'alpha').map(twin => twin.name)).toContain(language.original)
      })

      it('keeps two accessors that read different properties apart', async () => {
        const index = await indexFixtures()
        const [first, second] = language.accessors.map(name => helperNamed(index, name, `${language.directory}accessors`))

        expect(second.alphaFingerprint).not.toBe(first.alphaFingerprint)
        expect(twinsOf(index, first, 'alpha')).toStrictEqual([])
      })

      it('never makes a helper its own twin', async () => {
        const index = await indexFixtures()
        const original = helperNamed(index, language.original, `${language.directory}store`)

        expect(twinsOf(index, original, 'exact').every(twin => twin.id !== original.id)).toBe(true)
      })
    })
  }
})

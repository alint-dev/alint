import type { FunctionInfo } from '@alint-js/plugin'

import { createSourceFile } from '@alint-js/core'
import { extractJsSourceTargets } from '@alint-js/core/languages/js'
import { describe, expect, it } from 'vitest'

import { alphaFingerprint, exactFingerprint } from './fingerprint'

/**
 * Feeds real extractor output, never hand-written offsets and name lists through core's
 * own extractor, because that is what reads TypeScript during a run.
 */
async function fingerprintsOf(source: string, name?: string) {
  const targets = extractJsSourceTargets(createSourceFile('/fixture.ts', source))
    .filter(candidate => candidate.kind === 'function')
  const target = name === undefined
    ? targets.at(0)
    : targets.find(candidate => candidate.name === name)
  if (target === undefined)
    throw new Error(`fixture has no function named ${name ?? '(first)'}`)

  const { commentRanges, declaredNames, identifierRanges } = target.metadata?.function as FunctionInfo
  const { text } = target

  return {
    alpha: alphaFingerprint(text, commentRanges, identifierRanges, declaredNames),
    binderNames: declaredNames,
    exact: exactFingerprint(text, commentRanges),
  }
}

const BASELINE = [
  'function walkFiles(root: string): string[] {',
  '  const entries = readDir(root)',
  '  return entries',
  '}',
].join('\n')

describe('exactFingerprint', () => {
  it('ignores comments', async () => {
    const commented = [
      '/** Lists every file under `root`. */',
      'function walkFiles(root: string): string[] {',
      '  // Directories are walked eagerly.',
      '  const entries = readDir(root)',
      '  return entries // already sorted',
      '}',
    ].join('\n')

    const baseline = await fingerprintsOf(BASELINE)
    const withComments = await fingerprintsOf(commented)

    expect(withComments.exact).toBe(baseline.exact)
  })

  it('ignores indentation and line wrapping', async () => {
    const reformatted = [
      'function walkFiles(root: string): string[] {',
      '',
      '\t\tconst entries =',
      '\t\t\treadDir(root)',
      '\t\treturn entries',
      '}',
    ].join('\n')

    const baseline = await fingerprintsOf(BASELINE)
    const reflowed = await fingerprintsOf(reformatted)

    expect(reflowed.exact).toBe(baseline.exact)
  })

  it('changes when the body changes', async () => {
    const changed = [
      'function walkFiles(root: string): string[] {',
      '  const entries = readDir(root)',
      '  return entries.sort()',
      '}',
    ].join('\n')

    const baseline = await fingerprintsOf(BASELINE)
    const edited = await fingerprintsOf(changed)

    expect(edited.exact).not.toBe(baseline.exact)
  })

  it('changes when an identifier is renamed', async () => {
    const renamed = [
      'function listPaths(dir: string): string[] {',
      '  const found = readDir(dir)',
      '  return found',
      '}',
    ].join('\n')

    const baseline = await fingerprintsOf(BASELINE)
    const copy = await fingerprintsOf(renamed)

    expect(copy.exact).not.toBe(baseline.exact)
  })
})

describe('alphaFingerprint', () => {
  it('matches a copy that renamed the name, the parameter and the local', async () => {
    const renamed = [
      '// A renamed copy of walkFiles.',
      'function listPaths(dir: string): string[] {',
      '  const found = readDir(dir)',
      '  return found',
      '}',
    ].join('\n')

    const baseline = await fingerprintsOf(BASELINE)
    const copy = await fingerprintsOf(renamed)

    expect(copy.alpha).toBe(baseline.alpha)
    expect(copy.exact).not.toBe(baseline.exact)
  })

  it('collects the declared names, and only those', async () => {
    const baseline = await fingerprintsOf(BASELINE)

    expect(baseline.binderNames).toContain('walkFiles')
    expect(baseline.binderNames).toContain('root')
    expect(baseline.binderNames).toContain('entries')
    expect(baseline.binderNames).not.toContain('readDir')
  })

  it('keeps the function a copy calls, so a different callee does not match', async () => {
    const otherCallee = [
      'function listPaths(dir: string): string[] {',
      '  const found = scanDir(dir)',
      '  return found',
      '}',
    ].join('\n')

    const baseline = await fingerprintsOf(BASELINE)
    const other = await fingerprintsOf(otherCallee)

    expect(other.alpha).not.toBe(baseline.alpha)
  })

  // Blinding every identifier (NiCad's blind renaming, PMD's `--ignore-identifiers`) would collapse
  // these two. A property name is not a name the function declares, so it stays and tells them apart.
  it('does not collapse two accessors that read different properties', async () => {
    const name = 'function getName(): string {\n  return this.name\n}'
    const size = 'function getSize(): number {\n  return this.size\n}'

    const first = await fingerprintsOf(name)
    const second = await fingerprintsOf(size)

    expect(second.alpha).not.toBe(first.alpha)
  })

  it('keeps literals, so two helpers with different constants do not match', async () => {
    const double = 'function double(n: number): number {\n  return n * 2\n}'
    const triple = 'function triple(n: number): number {\n  return n * 3\n}'

    const first = await fingerprintsOf(double)
    const second = await fingerprintsOf(triple)

    expect(second.alpha).not.toBe(first.alpha)
  })

  it('does not match a function with a different shape', async () => {
    const inlined = [
      'function walkFiles(root: string): string[] {',
      '  return readDir(root)',
      '}',
    ].join('\n')

    const baseline = await fingerprintsOf(BASELINE)
    const other = await fingerprintsOf(inlined)

    expect(other.alpha).not.toBe(baseline.alpha)
  })

  it('keeps one placeholder per distinct name, so reordered uses differ', async () => {
    const swapped = [
      'function walkFiles(root: string): string[] {',
      '  const entries = readDir(root)',
      '  return readDir(entries)',
      '}',
    ].join('\n')

    const baseline = await fingerprintsOf(BASELINE)
    const other = await fingerprintsOf(swapped)

    expect(other.alpha).not.toBe(baseline.alpha)
  })

  it('renames a parameter without renaming the property that shares its name', async () => {
    const parameterNamedLikeProperty = 'function read(name: string): string {\n  return this.name + name\n}'
    const parameterRenamed = 'function read(key: string): string {\n  return this.name + key\n}'

    const first = await fingerprintsOf(parameterNamedLikeProperty)
    const second = await fingerprintsOf(parameterRenamed)

    // If the property were blinded along with the parameter sharing its name, the first would lose
    // `this.name` too and the two would differ.
    expect(second.alpha).toBe(first.alpha)
  })
})

describe('duplicated helpers already in this repository', () => {
  // `isNodeError` is copied verbatim into `packages/cli/src/cli/commands/lint/discovery.ts` (L127-L129)
  // and `packages/cli/src/cli/commands/lint/index.ts` (L57-L59). The copies sit at different offsets,
  // so a fingerprint built from absolute rather than function-relative offsets would fail here.
  const DISCOVERY = [
    'function isGlobPattern(input: string): boolean {',
    '  return new Minimatch(input, minimatchOptions).hasMagic()',
    '}',
    '',
    'function isNodeError(error: unknown): error is NodeJS.ErrnoException {',
    '  return error instanceof Error && \'code\' in error',
    '}',
  ].join('\n')

  const LINT_COMMAND = [
    'function isNodeError(error: unknown): error is NodeJS.ErrnoException {',
    '  return error instanceof Error && \'code\' in error',
    '}',
  ].join('\n')

  // `packages/config/src/utils/fs.ts` (added by PR #31) answers the same question in a different
  // shape, so no fingerprint can settle it and the agent is asked instead.
  const CONFIG_UTILS = [
    'function isNodeErrorCode(error: unknown, code: string): boolean {',
    '  return isError(error) && \'code\' in error && error.code === code',
    '}',
  ].join('\n')

  it('gives the two `isNodeError` copies the same fingerprints', async () => {
    const discovery = await fingerprintsOf(DISCOVERY, 'isNodeError')
    const lintCommand = await fingerprintsOf(LINT_COMMAND, 'isNodeError')

    expect(discovery.exact).toBe(lintCommand.exact)
    expect(discovery.alpha).toBe(lintCommand.alpha)
  })

  it('gives a renamed `isNodeError` the same alpha fingerprint, and a different exact one', async () => {
    const renamed = [
      'function isErrnoError(err: unknown): err is NodeJS.ErrnoException {',
      '  return err instanceof Error && \'code\' in err',
      '}',
    ].join('\n')

    const original = await fingerprintsOf(LINT_COMMAND, 'isNodeError')
    const copy = await fingerprintsOf(renamed, 'isErrnoError')

    expect(copy.alpha).toBe(original.alpha)
    expect(copy.exact).not.toBe(original.exact)
  })

  it('does not give the neighboring helper the same fingerprint', async () => {
    const discovery = await fingerprintsOf(DISCOVERY, 'isNodeError')
    const globPattern = await fingerprintsOf(DISCOVERY, 'isGlobPattern')

    expect(globPattern.exact).not.toBe(discovery.exact)
    expect(globPattern.alpha).not.toBe(discovery.alpha)
  })

  it('leaves `isNodeErrorCode` for the agent: it answers the same question in another shape', async () => {
    const guard = await fingerprintsOf(LINT_COMMAND, 'isNodeError')
    const variant = await fingerprintsOf(CONFIG_UTILS, 'isNodeErrorCode')

    expect(variant.exact).not.toBe(guard.exact)
    expect(variant.alpha).not.toBe(guard.alpha)
    // All they share is a name each declares, and alpha replaces exactly those. Nothing
    // deterministic can pair them.
    expect(variant.binderNames).toContain('error')
    expect(guard.binderNames).toContain('error')
  })
})

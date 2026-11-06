import type { LanguageDefinition, RuleDefinition, RuleLanguages } from '../../dsl/types'

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { defineConfig, definePlugin, defineRule } from '../../dsl/define'
import { AlintRunError, runAlint } from '../run'

const rubyLanguage = testLanguage('ruby', '.rb')

const zigLanguage = testLanguage('zig', '.zig')

describe('languages omitted — extraction off', () => {
  it('reads the file target and not the functions the language extracted', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-languages-off-'))
    const [first] = await writeZigFiles(cwd)
    const { rule, seen } = watchingRule()

    const result = await runOn({
      cwd,
      files: [first],
      rule,
      withLanguage: true,
    })

    expect(seen).toStrictEqual(['file:zig'])
    expect(result.diagnostics).toStrictEqual([])
  })

  it('stays silent when no language claims the extension', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-languages-off-unclaimed-'))
    const files = await writeZigFiles(cwd)
    const { rule, seen } = watchingRule()

    const result = await runOn({ cwd, files, rule })

    // The rule asked for no language, so plain text is not a disappointment and nothing is reported.
    expect(seen).toStrictEqual(['file:plaintext', 'file:plaintext'])
    expect(result.diagnostics).toStrictEqual([])
  })

  it('fails a rule that handles function targets yet declared no languages', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-languages-off-footgun-'))
    const [first] = await writeZigFiles(cwd)

    const rule = defineRule({
      create: () => ({
        onTargetFunction: () => {},
      }),
    })

    const error = await runOn({
      cwd,
      files: [first],
      rule,
      withLanguage: true,
    }).then(
      () => {
        throw new Error('expected the run to fail')
      },
      (cause: unknown) => cause,
    )

    expect(error).toBeInstanceOf(AlintRunError)
    const { failures } = error as AlintRunError
    expect(failures).toHaveLength(1)
    expect(failures[0].message).toContain('declares no "languages"')
  })
})

describe('languages: any', () => {
  it('reads every target a registered language extracted', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-languages-any-'))
    const [first] = await writeZigFiles(cwd)
    const { rule, seen } = watchingRule('any')

    const result = await runOn({
      cwd,
      files: [first],
      rule,
      withLanguage: true,
    })

    expect(seen).toStrictEqual(['file:zig', 'function:zig'])
    expect(result.diagnostics).toStrictEqual([])
  })

  it('warns once per extension, counting the files, when nothing claims them', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-languages-any-unclaimed-'))
    const [first, second] = await writeZigFiles(cwd)
    const { rule } = watchingRule('any')

    const result = await runOn({
      cwd,
      files: [first, second],
      rule,
    })

    expect(result.diagnostics).toHaveLength(1)
    const [diagnostic] = result.diagnostics
    expect(diagnostic.ruleId).toBe('alint/unregistered-language')
    expect(diagnostic.severity).toBe('warn')
    expect(diagnostic.filePath).toBe(first)
    expect(diagnostic.message).toContain('".zig"')
    expect(diagnostic.message).toContain('2 files were handled as plain text')
  })

  it('withholds plain-text targets rather than failing, since there is no structure to read', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-languages-any-plain-'))
    const [first] = await writeZigFiles(cwd)
    const { rule, seen } = watchingRule('any')

    const result = await runOn({
      cwd,
      files: [first],
      rule,
    })

    expect(seen).toStrictEqual([])
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0].ruleId).toBe('alint/unregistered-language')
  })

  it('stays silent under an explicit plaintext pin', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-languages-any-pinned-'))
    const files = await writeZigFiles(cwd)
    const { rule } = watchingRule('any')

    const result = await runOn({
      configItem: { language: 'plaintext' },
      cwd,
      files,
      rule,
    })

    expect(result.diagnostics).toStrictEqual([])
  })

  it('follows linterOptions.reportUnregisteredLanguages', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-languages-any-severity-'))
    const files = await writeZigFiles(cwd)

    const off = await runOn({
      configItem: {
        linterOptions: { reportUnregisteredLanguages: 'off' },
      },
      cwd,
      files,
      rule: watchingRule('any').rule,
    })
    expect(off.diagnostics).toStrictEqual([])

    const escalated = await runOn({
      configItem: {
        linterOptions: { reportUnregisteredLanguages: 'error' },
      },
      cwd,
      files,
      rule: watchingRule('any').rule,
    })
    expect(escalated.diagnostics).toHaveLength(1)
    expect(escalated.diagnostics[0].severity).toBe('error')
  })
})

describe('languages: a list', () => {
  it('reads targets of a listed language', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-languages-list-'))
    const [first] = await writeZigFiles(cwd)
    const { rule, seen } = watchingRule(['zig'])

    const result = await runOn({
      cwd,
      files: [first],
      rule,
      withLanguage: true,
    })

    expect(seen).toStrictEqual(['file:zig', 'function:zig'])
    expect(result.diagnostics).toStrictEqual([])
  })

  it('skips other registered languages rather than failing them', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-languages-list-scoped-'))
    const [first] = await writeZigFiles(cwd)
    const { rule, seen } = watchingRule(['ruby'])

    const result = await runAlint({
      config: defineConfig([
        {
          plugins: {
            probe: definePlugin({
              languages: { ruby: rubyLanguage, zig: zigLanguage },
              rules: { rule },
            }),
          },
          rules: { 'probe/rule': 'warn' },
        },
      ]),
      cwd,
      files: [first],
      projectTargets: false,
      runner: { cache: false },
      setupConfig: { providers: [], version: 1 },
    })

    expect(seen).toStrictEqual([])
    expect(result.diagnostics).toStrictEqual([])
  })

  it('reads plain text when the list asks for it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-languages-list-plain-'))
    const [first] = await writeZigFiles(cwd)
    const { rule, seen } = watchingRule(['plaintext'])

    const result = await runOn({
      cwd,
      files: [first],
      rule,
    })

    // A rule may deliberately handle raw text. Listing it is intent, so the file is neither withheld
    // nor reported — plain text is registered like any other language.
    expect(seen).toStrictEqual(['file:plaintext'])
    expect(result.diagnostics).toStrictEqual([])
  })

  it('reports a listed language that no plugin registered', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-languages-list-missing-'))
    const [first] = await writeZigFiles(cwd)
    const { rule, seen } = watchingRule(['go'])

    const result = await runOn({
      cwd,
      files: [first],
      rule,
      withLanguage: true,
    })

    expect(result.diagnostics).toHaveLength(1)
    const [diagnostic] = result.diagnostics
    expect(diagnostic.ruleId).toBe('alint/missing-language')
    expect(diagnostic.severity).toBe('error')
    expect(diagnostic.message).toContain('"go"')
    expect(diagnostic.message).toContain('probe/rule')
    // The gap is reported instead of the rule quietly matching nothing.
    expect(seen).toStrictEqual([])
  })

  it('names every rule that needed the missing language, in one diagnostic', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-languages-list-missing-many-'))
    const [first] = await writeZigFiles(cwd)

    const result = await runAlint({
      config: defineConfig([
        {
          plugins: {
            probe: definePlugin({
              languages: { zig: zigLanguage },
              rules: { first: watchingRule(['go']).rule, second: watchingRule(['go']).rule },
            }),
          },
          rules: { 'probe/first': 'warn', 'probe/second': 'warn' },
        },
      ]),
      cwd,
      files: [first],
      projectTargets: false,
      runner: { cache: false },
      setupConfig: { providers: [], version: 1 },
    })

    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0].message).toContain('"probe/first", "probe/second"')
  })

  it('fails a missing language for the object form as well, when skipMissing is absent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-languages-list-object-missing-'))
    const [first] = await writeZigFiles(cwd)
    const { rule, seen } = watchingRule({
      ids: ['go'],
    })

    const result = await runOn({
      cwd,
      files: [first],
      rule,
      withLanguage: true,
    })

    // `{ ids }` is the bare list with room for options, so omitting `skipMissing` has to behave
    // exactly as `['go']` does. Failing is the default in both spellings; skipping is only ever
    // asked for. Nothing else pins that, so flipping the default would otherwise go unnoticed.
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0].ruleId).toBe('alint/missing-language')
    expect(result.diagnostics[0].severity).toBe('error')
    expect(seen).toStrictEqual([])
  })

  it('skips a missing language instead of reporting it when skipMissing is set', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-languages-list-skip-missing-'))
    const [first] = await writeZigFiles(cwd)
    const { rule, seen } = watchingRule({
      ids: ['go'],
      skipMissing: true,
    })

    const result = await runOn({
      cwd,
      files: [first],
      rule,
      withLanguage: true,
    })

    expect(result.diagnostics).toStrictEqual([])
    expect(seen).toStrictEqual([])
  })
})

describe('the unregistered-language warning', () => {
  it('stays silent when no rule lints the file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-unregistered-no-rules-'))
    const files = await writeZigFiles(cwd)

    const result = await runAlint({
      config: defineConfig([
        { settings: {} },
      ]),
      cwd,
      files,
      projectTargets: false,
      runner: { cache: false },
      setupConfig: { providers: [], version: 1 },
    })

    expect(result.diagnostics).toStrictEqual([])
  })

  it('stays silent when a language claims the extension', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-unregistered-claimed-'))
    const files = await writeZigFiles(cwd)
    const { rule } = watchingRule('any')

    const result = await runOn({ cwd, files, rule, withLanguage: true })

    expect(result.diagnostics).toStrictEqual([])
  })
})

describe('targets no language extracted', () => {
  it('hands a rule the project target whatever its languages say', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-languages-project-'))
    const [first] = await writeZigFiles(cwd)
    const { rule, seen } = watchingRule('any')

    await runOn({
      cwd,
      files: [first],
      projectTargets: true,
      rule,
    })

    expect(seen).toStrictEqual(['project'])
  })
})

async function runOn(options: {
  configItem?: Record<string, unknown>
  cwd: string
  files: string[]
  projectTargets?: boolean
  rule: RuleDefinition<[]>
  withLanguage?: boolean
}) {
  return runAlint({
    config: defineConfig([
      {
        plugins: {
          probe: definePlugin({
            ...(options.withLanguage
              ? {
                  languages: { zig: zigLanguage },
                }
              : {}),
            rules: { rule: options.rule },
          }),
        },
        rules: { 'probe/rule': 'warn' },
        ...(options.configItem ?? {}),
      },
    ]),
    cwd: options.cwd,
    files: options.files,
    // Off unless a case is about them: the project target reaches every rule regardless of
    // `languages`, so leaving it on would add the same entry to every expectation below.
    projectTargets: options.projectTargets ?? false,
    runner: { cache: false },
    setupConfig: { providers: [], version: 1 },
  })
}

/** A language that extracts one file target and one function target, so scoping is observable. */
function testLanguage(name: string, extension: string): LanguageDefinition {
  return {
    extensions: [extension],
    extract: file => [
      {
        file,
        identity: 'file',
        kind: 'file',
        language: name,
        origin: { physicalPath: file.path },
        text: file.text,
      },
      {
        file,
        identity: 'fn:main',
        kind: 'function',
        language: name,
        name: 'main',
        origin: { physicalPath: file.path },
        text: file.text,
      },
    ],
    name,
  }
}

/** Records every target a rule is handed, as `kind:language`, so withholding is visible. */
function watchingRule(languages?: RuleLanguages) {
  const seen: string[] = []

  const rule = defineRule({
    create: () => ({
      onTargetWith: (target) => {
        // Directory and project targets carry no language, and reach every rule regardless.
        seen.push('language' in target
          ? `${target.kind}:${target.language}`
          : target.kind)
      },
    }),
    ...(languages === undefined
      ? {}
      : { languages }),
  })

  return { rule, seen }
}

async function writeZigFiles(cwd: string): Promise<string[]> {
  const first = join(cwd, 'alpha.zig')
  const second = join(cwd, 'beta.zig')
  await writeFile(first, 'const alpha = 1;\n')
  await writeFile(second, 'const beta = 2;\n')

  return [first, second]
}

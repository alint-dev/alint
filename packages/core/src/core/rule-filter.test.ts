import type { SetupConfig } from '../config/types'
import type { RuleDefinition } from '../dsl/types'

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { defineConfig, definePlugin, defineRule } from '../dsl/define'
import { matchesRuleFilter } from './rule-filter'
import { runAlint } from './run'

function createConfig(rules: Record<string, RuleDefinition>, enabledRules: Record<string, 'warn'>) {
  return defineConfig([
    {
      language: 'plaintext',
      plugins: {
        company: definePlugin({ rules }),
      },
      rules: enabledRules,
    },
  ])
}

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

describe('matchesRuleFilter', () => {
  const rule = { id: 'docs/review-copy', localId: 'review-copy' }

  it.each([
    ['docs/review-copy'],
    ['docs/*'],
    ['review-copy'],
    ['**/review-copy'],
  ])('matches %j', (pattern) => {
    expect(matchesRuleFilter(rule, [pattern])).toBe(true)
  })

  it('matches when any pattern in the filter matches', () => {
    expect(matchesRuleFilter(rule, ['other/rule', 'docs/review-copy'])).toBe(true)
  })

  it.each([
    ['docs/other'],
    ['review'],
    ['js/*'],
  ])('does not match %j', (pattern) => {
    expect(matchesRuleFilter(rule, [pattern])).toBe(false)
  })
})

// Report: https://github.com/moeru-ai/alint/issues/91
describe('runAlint rule filter', () => {
  const createRules = () => ({
    naming: defineRule({
      create: ctx => ({
        onTargetFile: (target) => {
          ctx.report({ filePath: target.file.path, message: 'naming finding' })
        },
      }),
    }),
    review: defineRule({
      create: ctx => ({
        onTargetFile: (target) => {
          ctx.report({ filePath: target.file.path, message: 'review finding' })
        },
      }),
    }),
  })

  async function createRun() {
    const root = await mkdtemp(join(tmpdir(), 'alint-rule-filter-'))
    const filePath = join(root, 'demo.txt')
    await writeFile(filePath, 'hello\n')

    return (ruleFilter?: readonly string[]) => runAlint({
      config: createConfig(createRules(), { 'company/naming': 'warn', 'company/review': 'warn' }),
      cwd: root,
      files: [filePath],
      ...(ruleFilter === undefined ? {} : { ruleFilter }),
      setupConfig: createSetupConfig(),
    })
  }

  it('runs every enabled rule without a filter', async () => {
    const run = await createRun()
    const result = await run()

    expect(result.diagnostics.map(diagnostic => diagnostic.message)).toEqual([
      'naming finding',
      'review finding',
    ])
  })

  it('runs only the rules the filter names (Issue #91)', async () => {
    const run = await createRun()
    const result = await run(['company/review'])

    expect(result.diagnostics.map(diagnostic => diagnostic.message)).toEqual([
      'review finding',
    ])
  })

  it('matches a rule by its own name', async () => {
    const run = await createRun()
    const result = await run(['naming'])

    expect(result.diagnostics.map(diagnostic => diagnostic.message)).toEqual([
      'naming finding',
    ])
  })

  it('fails the run when the filter matches no enabled rule', async () => {
    const run = await createRun()

    await expect(run(['company/missing'])).rejects.toThrow(
      'No enabled rule matched --rule "company/missing". Enabled rules: company/naming, company/review.',
    )
  })
})

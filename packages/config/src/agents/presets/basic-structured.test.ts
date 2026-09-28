import type { PlannedSourceTarget, RuleContext } from '@alint-js/core'

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSourceRuntime } from '@alint-js/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createBasicStructuredRule, createStructuredMessages, reportDeclarativeFindings } from './basic-structured'

const generateStructuredMock = vi.hoisted(() => vi.fn())
const source = 'print("hello")\n'

vi.mock('@alint-js/core/structured-output', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@alint-js/core/structured-output')>()

  return {
    ...actual,
    generateStructured: generateStructuredMock,
  }
})

describe('basic-structured declarative preset', () => {
  beforeEach(() => {
    generateStructuredMock.mockReset()
  })

  it('builds messages with instruction, output language, target source, and included files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-structured-messages-'))
    await mkdir(join(root, 'src'), { recursive: true })
    const targetPath = join(root, 'src', 'main.py')
    const helperPath = join(root, 'src', 'helper.py')
    await writeFile(targetPath, 'def main():\n    pass\n')
    await writeFile(helperPath, 'def helper():\n    pass\n')

    const messages = await createStructuredMessages({
      cwd: root,
      includeFiles: ['src/helper.py'],
      instruction: 'Find boundary issues.',
      outputLanguage: '简体中文',
      ruleFilePath: join(root, 'rules', 'rule.alint.toml'),
      sourceText: 'def main():\n    pass\n',
      targetFilePath: targetPath,
    })

    const content = messages.map(message => message.content).join('\n')
    expect(messages[0]).toMatchObject({ role: 'system' })
    expect(content).toContain('Find boundary issues.')
    expect(content).toContain('Write all human-readable finding messages and suggestions in this language: 简体中文.')
    expect(content).toContain('1 | def main():')
    expect(content).toContain('Supplemental files')
    expect(content).toContain('src/helper.py')
    expect(content).toContain('def helper():')
  })

  it('skips oversized supplemental files while keeping small supplemental files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-structured-sized-context-'))
    await mkdir(join(root, 'src'), { recursive: true })
    const targetPath = join(root, 'src', 'main.py')
    const helperPath = join(root, 'src', 'helper.py')
    const oversizedPath = join(root, 'src', 'large.py')
    await writeFile(targetPath, 'def main():\n    pass\n')
    await writeFile(helperPath, 'small_helper_marker = True\n')
    await writeFile(oversizedPath, `${'x'.repeat(65 * 1024)}oversized_marker\n`)

    const messages = await createStructuredMessages({
      cwd: root,
      includeFiles: ['src/*.py'],
      instruction: 'Find boundary issues.',
      ruleFilePath: join(root, 'rules', 'rule.alint.toml'),
      sourceText: 'def main():\n    pass\n',
      targetFilePath: targetPath,
    })

    const content = messages.map(message => message.content).join('\n')
    expect(content).toContain('small_helper_marker')
    expect(content).not.toContain('oversized_marker')
  })

  it('maps findings to diagnostics and filters out-of-scope files', () => {
    const reports: unknown[] = []
    const ctx = {
      cwd: '/repo',
      logger: { debug: vi.fn() },
      report: (diagnostic: unknown) => reports.push(diagnostic),
    }

    reportDeclarativeFindings({
      ctx,
      excludeFiles: ['**/*_test.py'],
      findings: [
        { confidence: 'high', filePath: '/repo/src/main.py', line: 2, message: 'move parser', suggestion: 'Create a parser object.' },
        { filePath: '/repo/src/main_test.py', line: 1, message: 'ignored test file' },
      ],
      includeFiles: ['src/**/*.py'],
      targetFilePath: '/repo/src/main.py',
    })

    expect(reports).toEqual([
      {
        evidence: {
          confidence: 'high',
          suggestion: 'Create a parser object.',
        },
        filePath: '/repo/src/main.py',
        loc: { start: { column: 0, line: 2 } },
        message: 'move parser',
      },
    ])
    expect(ctx.logger.debug).toHaveBeenCalledOnce()
  })

  it('creates a cacheable file-target rule without included supplemental files', () => {
    const rule = createBasicStructuredRule({
      builtInAgent: 'basic-structured',
      excludeFiles: [],
      filePath: '/repo/rules/semantic/rule.alint.toml',
      instruction: 'Find semantic boundary issues.',
      name: 'semantic-boundary',
    })

    expect(rule.cache).toBe(true)
    // The rule text is not part of the rule source the run engine hashes, so the rule has to
    // declare it. Without this key, editing `instruction` replays the previous findings.
    expect(rule.cacheKey).toMatchObject({ agent: 'basic-structured', instruction: 'Find semantic boundary issues.' })
    expect(rule.create).toEqual(expect.any(Function))
    expect(rule.create(createRuleContext()).onTargetFile).toEqual(expect.any(Function))
  })

  it('creates a non-cacheable file-target rule with included supplemental files', () => {
    const rule = createBasicStructuredRule({
      builtInAgent: 'basic-structured',
      excludeFiles: [],
      filePath: '/repo/rules/semantic/rule.alint.toml',
      includeFiles: ['src/**/*.py'],
      instruction: 'Find semantic boundary issues.',
      name: 'semantic-boundary',
    })

    expect(rule.cache).toBe(false)
    expect(rule.create).toEqual(expect.any(Function))
    expect(rule.create(createRuleContext()).onTargetFile).toEqual(expect.any(Function))
  })

  // Report: https://github.com/moeru-ai/alint/issues/91
  it('drops findings that only report the target is clean (Issue #91)', async () => {
    generateStructuredMock.mockResolvedValueOnce({
      findings: [
        { line: 1, message: 'No violations found.' },
        { line: 3, message: 'move parser', suggestion: 'Create a parser object.' },
      ],
    })

    const ctx = createRuleContext()
    const rule = createBasicStructuredRule({
      builtInAgent: 'basic-structured',
      excludeFiles: [],
      filePath: '/repo/rules/semantic/rule.alint.toml',
      instruction: 'Find semantic boundary issues.',
      name: 'semantic-boundary',
    })

    await rule.create(ctx).onTargetFile?.(createTarget('file'))

    expect(ctx.report).toHaveBeenCalledOnce()
    expect(ctx.report).toHaveBeenCalledWith({
      evidence: { suggestion: 'Create a parser object.' },
      filePath: '/repo/src/main.py',
      loc: { start: { column: 0, line: 3 } },
      message: 'move parser',
    })
    expect(ctx.logger.debug).toHaveBeenCalledWith('Ignoring declarative finding that reports no issue', {
      message: 'No violations found.',
    })
  })

  it('runs structured output for a file target', async () => {
    generateStructuredMock.mockResolvedValueOnce({
      findings: [
        {
          line: 1,
          message: 'use a clearer boundary',
        },
      ],
    })

    const ctx = createRuleContext()
    const rule = createBasicStructuredRule({
      builtInAgent: 'basic-structured',
      excludeFiles: [],
      filePath: '/repo/rules/semantic/rule.alint.toml',
      instruction: 'Find semantic boundary issues.',
      name: 'semantic-boundary',
    })

    await rule.create(ctx).onTargetFile?.(createTarget('file'))

    expect(ctx.model).toHaveBeenCalledOnce()
    expect(generateStructuredMock).toHaveBeenCalledOnce()
    expect(ctx.report).toHaveBeenCalledWith({
      filePath: '/repo/src/main.py',
      loc: { start: { column: 0, line: 1 } },
      message: 'use a clearer boundary',
    })
  })
})

function createRuleContext(): RuleContext {
  return {
    cwd: '/repo',
    id: 'declarative/semantic-boundary',
    localId: 'semantic-boundary',
    logger: { debug: vi.fn() },
    metering: { recordUsage: vi.fn() },
    model: vi.fn(async () => ({
      aliases: [],
      capabilities: ['structured-output'],
      id: 'test-model',
      name: 'Test Model',
      params: {},
      provider: {
        endpoint: 'https://example.test/v1',
        headers: {},
        id: 'test-provider',
        type: 'openai-compatible' as const,
      },
    })),
    options: [],
    report: vi.fn(),
    settings: {},
    src: createSourceRuntime({
      readFile: async file => ({
        contentHash: createHash('sha256').update(source).digest('hex'),
        language: 'python',
        lines: source.split('\n'),
        path: typeof file === 'string' ? file : file.path,
        text: source,
      }),
    }),
  }
}

function createTarget<Kind extends PlannedSourceTarget['kind']>(kind: Kind): PlannedSourceTarget & { kind: Kind } {
  return {
    file: {
      contentHash: createHash('sha256').update(source).digest('hex'),
      language: 'python',
      path: '/repo/src/main.py',
    },
    identity: `${kind}:main`,
    kind,
    language: 'python',
  }
}

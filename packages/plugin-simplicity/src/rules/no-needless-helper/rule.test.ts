import type { Buffer } from 'node:buffer'
import type { AddressInfo } from 'node:net'

import type { DiagnosticDescriptor, FileTarget, RuleContext } from '@alint-js/plugin'

import type { IndexedHelper } from '../../repo'

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createFixtureContext, createFixtureIndex, fixtureHelper, FIXTURES_DIR } from '../../repo/fixtures'
import { judgeKey, needlessHelperRule, resolveFinding } from './rule'

interface Finding {
  helper: number
  name: string
  reason: string
}

interface Run {
  contextFor: (settings?: Record<string, unknown>) => RuleContext
  cwd: string
  debug: string[]
  diagnostics: DiagnosticDescriptor[]
  requests: Record<string, unknown>[]
}

/* A real server answers the model call rather than a stub, so the request the rule actually sends stays under test. Same approach as core's structured-output tests. */
let baseURL: string
let close: () => Promise<void>
let requests: Record<string, unknown>[]
let findings: Finding[]

beforeEach(async () => {
  requests = []
  findings = []

  const server = createServer((request, response) => {
    let payload = ''
    request.on('data', (chunk: Buffer) => {
      payload += chunk.toString()
    })
    request.on('end', () => {
      requests.push(JSON.parse(payload) as Record<string, unknown>)
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(completion(findings)))
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  close = async () => new Promise((done, fail) => server.close(error => error
    ? fail(error)
    : done()))
})

afterEach(async () => {
  await close()
})

function completion(reported: Finding[]): unknown {
  return {
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: null,
          role: 'assistant',
          tool_calls: [
            {
              function: {
                arguments: JSON.stringify({ findings: reported }),
                name: 'reportFindings',
              },
              id: 'call_1',
              type: 'function',
            },
          ],
        },
      },
    ],
    usage: { completion_tokens: 5, prompt_tokens: 11, total_tokens: 16 },
  }
}

function createRun(cwd: string = FIXTURES_DIR): Run {
  const debug: string[] = []
  const diagnostics: DiagnosticDescriptor[] = []
  const src = createFixtureContext().src

  return {
    contextFor: (settings = {}): RuleContext => createFixtureContext({
      cwd,
      logger: {
        debug: (...args) => void debug.push(args.join(' ')),
      },
      model: () => Promise.resolve({
        aliases: [],
        capabilities: ['tool-call'],
        id: 'test-model',
        name: 'test-model',
        params: {},
        provider: {
          endpoint: baseURL,
          headers: {},
          id: 'test-provider',
          type: 'openai-compatible',
        },
      }),
      report: diagnostic => void diagnostics.push(diagnostic),
      settings,
      src,
    }),
    cwd,
    debug,
    diagnostics,
    requests,
  }
}

/** The fixture workspace, copied, so a run may write its cache into it. */
async function createWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'simplicity-needless-'))

  await cp(FIXTURES_DIR, cwd, {
    filter: source => basename(source) !== '.alint',
    recursive: true,
  })

  return cwd
}

/** A candidate of a file that does not exist. The path is deliberately not a fixture's: these cases must not be kept in step with the evaluation corpus. */
function indexedHelper(overrides: Partial<IndexedHelper> = {}): IndexedHelper {
  return {
    alphaFingerprint: 'alpha',
    body: 'return JSON.parse(text)',
    bodyIsSingleExpression: true,
    bodyStatements: 1,
    exactFingerprint: 'exact',
    exported: false,
    filePath: '/repo/ts/helpers.ts',
    id: 'ts/helpers.ts:19',
    language: 'typescript',
    line: 19,
    lines: 3,
    name: 'parse',
    text: 'function parse(text: string): unknown {\n  return JSON.parse(text)\n}',
    tokens: [],
    usageCount: 1,
    ...overrides,
  }
}

function judgePrompt(): string {
  const messages = requests[0].messages as { content: string, role: string }[]

  return messages.filter(message => message.role === 'user').map(message => message.content).join('\n')
}

/* The cache is off by default: with it on, a run would write a decision into the fixture workspace and answer the next test from disk instead of the server. The cache tests turn it on, against a copy. */
async function lint(run: Run, relativePath: string, settings: Record<string, unknown> = {
  simplicity: {
    cache: false,
    ignores: ['**/*.config.ts'],
  },
}): Promise<void> {
  const path = resolve(run.cwd, relativePath)
  const target: FileTarget = {
    file: { contentHash: 'unused', language: 'plaintext', path },
    identity: 'file',
    kind: 'file',
    language: 'plaintext',
  }

  await needlessHelperRule.create(run.contextFor(settings)).onTargetFile?.(target)
}

describe('no-needless-helper, choosing what to ask about', () => {
  it('asks only about helpers whose whole body is one expression', async () => {
    const run = createRun()

    await lint(run, 'ts/needless.ts')

    expect(requests).toHaveLength(1)

    const prompt = judgePrompt()
    expect(prompt).toContain('nameLength')
    expect(prompt).toContain('parse')
    expect(prompt).toContain('clamp')
    expect(prompt).toContain('isEntry')
    // `describeEntry` has an `if` and a return: two statements, so the rule never asks about it.
    expect(prompt).not.toContain('describeEntry')
  })

  it('asks nothing at all when no helper is a single expression', async () => {
    const run = createRun()

    await lint(run, 'ts/walk.ts')

    expect(requests).toStrictEqual([])
    expect(run.diagnostics).toStrictEqual([])
  })

  it('tells the judge how often a helper is used, and whether it is somebody\'s API', async () => {
    const run = createRun()

    await lint(run, 'ts/needless.ts')

    const prompt = judgePrompt()
    expect(prompt).toContain('private to its file')
    expect(prompt).toContain('exported')
    expect(prompt).toMatch(/called (once|\d+ times) in the workspace/)
  })

  it('spends nothing when the judge is off', async () => {
    const run = createRun()

    await lint(run, 'ts/needless.ts', {
      simplicity: {
        ignores: ['**/*.config.ts'],
        judge: false,
      },
    })

    expect(requests).toStrictEqual([])
    expect(run.diagnostics).toStrictEqual([])
  })
})

describe('no-needless-helper, reporting', () => {
  it('reports what the judge found, at the helper\'s line', async () => {
    const nameLength = fixtureHelper(await createFixtureIndex(), 'ts/needless.ts', 'nameLength')
    findings = [
      { helper: 1, name: 'nameLength', reason: 'Reads one property; `entry.name.length` says the same thing.' },
    ]

    const run = createRun()
    await lint(run, 'ts/needless.ts')

    expect(run.diagnostics).toHaveLength(1)

    const [diagnostic] = run.diagnostics
    expect(diagnostic.message).toBe('Helper "nameLength" does not earn its existence: Reads one property; `entry.name.length` says the same thing.')
    expect(diagnostic.loc?.start.line).toBe(nameLength.line)
    expect(diagnostic.evidence).toMatchObject({ exported: false })
  })

  // A model that miscounts must not land a diagnostic on the wrong function.
  it('reports at the line the index knows, not the line the model claimed', async () => {
    findings = [
      { helper: 99, name: 'parse', reason: 'Forwards to JSON.parse unchanged.' },
    ]

    const index = await createFixtureIndex()
    const run = createRun()
    await lint(run, 'ts/needless.ts')

    expect(run.diagnostics).toHaveLength(1)
    expect(run.diagnostics[0].loc?.start.line).toBe(fixtureHelper(index, 'ts/needless.ts', 'parse').line)
  })

  it('drops a finding for a helper it never showed the judge', async () => {
    findings = [
      { helper: 1, name: 'aFunctionThatDoesNotExist', reason: 'Invented.' },
    ]

    const run = createRun()
    await lint(run, 'ts/needless.ts')

    expect(run.diagnostics).toStrictEqual([])
    expect(run.debug.join('\n')).toContain('was not one of the helpers under review')
  })

  it('reports nothing when the judge finds nothing', async () => {
    const run = createRun()

    await lint(run, 'ts/needless.ts')

    expect(requests).toHaveLength(1)
    expect(run.diagnostics).toStrictEqual([])
  })
})

/* A name does not identify a helper: a nested function is extracted on its own, so one file can hold two candidates called `parse`. */
describe('no-needless-helper, resolving a finding to the helper it is about', () => {
  it('resolves a name only one helper carries, whatever ordinal the model claimed', () => {
    const parse = indexedHelper({ line: 19, name: 'parse' })
    const nameLength = indexedHelper({ id: 'ts/helpers.ts:13', line: 13, name: 'nameLength' })

    expect(resolveFinding([parse, nameLength], { helper: 99, name: 'parse' }))
      .toStrictEqual({ helper: parse, outcome: 'resolved' })
  })

  it('tells two helpers of one name apart by the ordinal the model was shown', () => {
    const outer = indexedHelper({ id: 'ts/a.ts:3', line: 3, name: 'parse' })
    const nested = indexedHelper({ id: 'ts/a.ts:11', line: 11, name: 'parse' })

    expect(resolveFinding([outer, nested], { helper: 2, name: 'parse' }))
      .toStrictEqual({ helper: nested, outcome: 'resolved' })
    expect(resolveFinding([outer, nested], { helper: 1, name: 'parse' }))
      .toStrictEqual({ helper: outer, outcome: 'resolved' })
  })

  it('drops a finding that names two helpers and gives the ordinal of neither', () => {
    const outer = indexedHelper({ id: 'ts/a.ts:3', line: 3, name: 'parse' })
    const nested = indexedHelper({ id: 'ts/a.ts:11', line: 11, name: 'parse' })

    expect(resolveFinding([outer, nested], { helper: 7, name: 'parse' })).toStrictEqual({ outcome: 'ambiguous' })
  })

  it('drops a finding for a name no candidate carries', () => {
    expect(resolveFinding([
      indexedHelper(),
    ], { helper: 1, name: 'invented' })).toStrictEqual({ outcome: 'unknown' })
  })
})

/* Measured: an interface added above two borderline accessors moved them five lines and the judge stopped reporting them. The line is no longer shown, so it cannot be a reason. */
describe('no-needless-helper, what the judge is shown', () => {
  it('never shows the judge a line number', async () => {
    const run = createRun()

    await lint(run, 'ts/needless.ts')

    const prompt = judgePrompt()
    expect(prompt).toContain('helper 1')
    expect(prompt).not.toMatch(/--- line \d+/)
  })

  it('asks the same question wherever the file\'s helpers sit', async () => {
    const first = createRun()
    await lint(first, 'ts/needless.ts')
    const before = judgePrompt()

    const moved = await createWorkspace()
    const path = resolve(moved, 'ts/needless.ts')
    await writeFile(path, `\n\n\n${await readFile(path, 'utf8')}`, 'utf8')

    requests = []
    const second = createRun(moved)
    await lint(second, 'ts/needless.ts')

    expect(judgePrompt()).toBe(before)

    await rm(moved, { force: true, recursive: true })
  })
})

describe('no-needless-helper, what a remembered decision is stamped with', () => {
  it('is the same key for the same helpers, asked the same question', () => {
    const candidates = [
      indexedHelper(),
    ]

    expect(judgeKey(undefined, candidates)).toBe(judgeKey(undefined, [
      indexedHelper(),
    ]))
  })

  // Why this rule cannot use the core's per-target cache: a call added in a file nobody is
  // linting moves the count, and the count is most of why a short helper is or is not needless.
  it('moves when nothing changed but the number of times the workspace calls a helper', () => {
    const before = judgeKey(undefined, [
      indexedHelper({ usageCount: 1 }),
    ])
    const after = judgeKey(undefined, [
      indexedHelper({ usageCount: 40 }),
    ])

    expect(after).not.toBe(before)
  })

  it('moves when a candidate\'s text changes, when one appears, and when the answer is asked for in another language', () => {
    const base = judgeKey(undefined, [
      indexedHelper(),
    ])

    expect(judgeKey(undefined, [
      indexedHelper({ text: 'function parse(text: string): unknown {\n  return YAML.parse(text)\n}' }),
    ])).not.toBe(base)
    expect(judgeKey(undefined, [
      indexedHelper(),
      indexedHelper({ line: 13, name: 'nameLength' }),
    ])).not.toBe(base)
    expect(judgeKey('zh-CN', [
      indexedHelper(),
    ])).not.toBe(base)
  })

  // The line is deliberately left out of the key: a helper that only moved is the same helper,
  // and its diagnostic is pinned from the index rather than from what was remembered.
  it('does not move when a helper only changed line', () => {
    expect(judgeKey(undefined, [
      indexedHelper({ id: 'ts/helpers.ts:44', line: 44 }),
    ]))
      .toBe(judgeKey(undefined, [
        indexedHelper({ id: 'ts/helpers.ts:19', line: 19 }),
      ]))
  })
})

describe('no-needless-helper, remembering a decision', () => {
  const CACHED = {
    simplicity: {
      ignores: ['**/*.config.ts'],
    },
  }

  let cwd: string
  let nameLengthLine: number

  beforeEach(async () => {
    cwd = await createWorkspace()
    nameLengthLine = fixtureHelper(await createFixtureIndex(), 'ts/needless.ts', 'nameLength').line
    findings = [
      { helper: 1, name: 'nameLength', reason: 'Reads one property; `entry.name.length` says the same thing.' },
    ]
  })

  afterEach(async () => {
    await rm(cwd, { force: true, recursive: true })
  })

  it('does not ask twice about helpers nobody touched', async () => {
    const first = createRun(cwd)
    await lint(first, 'ts/needless.ts', CACHED)

    expect(requests).toHaveLength(1)
    expect(first.diagnostics).toHaveLength(1)

    // A new run means a cold in-memory cache, so only the cache on disk can carry the decision across.
    const second = createRun(cwd)
    await lint(second, 'ts/needless.ts', CACHED)

    expect(requests).toHaveLength(1)
    expect(second.diagnostics).toHaveLength(1)
    expect(second.diagnostics[0].message).toBe(first.diagnostics[0].message)
    expect(second.diagnostics[0].loc?.start.line).toBe(nameLengthLine)
    expect(second.debug.join('\n')).toContain('was judged on these helpers already')
  })

  it('reports a remembered decision at the line the helper stands on now', async () => {
    const first = createRun(cwd)
    await lint(first, 'ts/needless.ts', CACHED)

    expect(first.diagnostics[0].loc?.start.line).toBe(nameLengthLine)

    const path = resolve(cwd, 'ts/needless.ts')
    await writeFile(path, `\n\n${await readFile(path, 'utf8')}`, 'utf8')

    const second = createRun(cwd)
    await lint(second, 'ts/needless.ts', CACHED)

    expect(requests).toHaveLength(1)
    expect(second.diagnostics).toHaveLength(1)
    expect(second.diagnostics[0].loc?.start.line).toBe(nameLengthLine + 2)
  })

  it('judges again when a helper the file was judged on changed', async () => {
    const first = createRun(cwd)
    await lint(first, 'ts/needless.ts', CACHED)

    const path = resolve(cwd, 'ts/needless.ts')
    const text = await readFile(path, 'utf8')
    await writeFile(path, text.replace('return JSON.parse(text)', 'return JSON.parse(text.trim())'), 'utf8')

    const second = createRun(cwd)
    await lint(second, 'ts/needless.ts', CACHED)

    expect(requests).toHaveLength(2)
    expect(second.diagnostics).toHaveLength(1)
  })

  it('judges every run when the cache is turned off', async () => {
    const off = {
      simplicity: {
        cache: false,
        ignores: ['**/*.config.ts'],
      },
    }

    await lint(createRun(cwd), 'ts/needless.ts', off)
    await lint(createRun(cwd), 'ts/needless.ts', off)

    expect(requests).toHaveLength(2)
  })
})

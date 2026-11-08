import type { Buffer } from 'node:buffer'
import type { AddressInfo } from 'node:net'

import type { DiagnosticDescriptor, FileTarget, RuleContext } from '@alint-js/plugin'

import type { ReinventedHelperOptions } from './rule'

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createFixtureContext, createFixtureRuntime } from '../../repo/fixtures'
import { reinventedHelperRule } from './rule'

interface Finding {
  exportName: string
  helper: number
  library: string
  name: string
  reason: string
}

/* A real server answers the model call rather than a stub, so the request the rule sends stays under test. */
let baseURL: string
let close: () => Promise<void>
let requests: Record<string, unknown>[]
let findings: Finding[]
let cwd: string

/*
 * A workspace with its own library. Its `exports` map has only an `import` condition, so
 * `require.resolve` rejects it and the rule must read the entry from the manifest.
 */
const WORKSPACE: Record<string, string> = {
  'node_modules/tiny-utils/index.js': [
    'export const clamp = (value, min, max) => Math.min(Math.max(value, min), max)',
    'export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))',
  ].join('\n'),
  'node_modules/tiny-utils/package.json': JSON.stringify({
    exports: {
      '.': { import: './index.js' },
    },
    name: 'tiny-utils',
    type: 'module',
  }),
  'package.json': JSON.stringify({ name: 'repo', type: 'module' }),
  'src/helpers.ts': [
    'export function clampValue(value: number, min: number, max: number): number {',
    '  return Math.min(Math.max(value, min), max)',
    '}',
    '',
    'export function greeting(name: string): string {',
    '  return name.trim().replace(/\\s+/g, \' \') + \' is back\'',
    '}',
  ].join('\n'),
}

beforeEach(async () => {
  requests = []
  findings = []
  cwd = await mkdtemp(join(tmpdir(), 'simplicity-reinvented-'))
  for (const [path, text] of Object.entries(WORKSPACE)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true })
    await writeFile(join(cwd, path), text)
  }

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
  await rm(cwd, { force: true, recursive: true })
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

async function lint(libraries: string[], settings: Record<string, unknown> = {
  simplicity: { cache: false },
}) {
  const diagnostics: DiagnosticDescriptor[] = []
  const context = createFixtureContext({
    cwd,
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
    src: createFixtureRuntime(),
  }) as unknown as RuleContext<readonly [ReinventedHelperOptions]>
  const path = join(cwd, 'src/helpers.ts')
  const target: FileTarget = {
    file: { contentHash: 'unused', language: 'typescript', path },
    identity: `file:${path}`,
    kind: 'file',
    language: 'typescript',
  }

  await reinventedHelperRule.create({
    ...context,
    options: [
      { libraries },
    ],
  }).onTargetFile?.(target)

  return diagnostics
}

function userPrompt(): string {
  const messages = requests[0].messages as { content: string, role: string }[]
  return messages.filter(message => message.role === 'user').map(message => message.content).join('\n')
}

describe('no-reinvented-helper', () => {
  it('lists the real exports of the library and the helpers of the file', async () => {
    await lint(['tiny-utils'])

    expect(requests).toHaveLength(1)
    const prompt = userPrompt()
    expect(prompt).toContain('Exports of `tiny-utils`:\nclamp, sleep')
    expect(prompt).toContain('Helper 1: `clampValue`')
    expect(prompt).toContain('Helper 2: `greeting`')
  })

  it('reports a helper that the model matches to a listed export', async () => {
    findings = [
      {
        exportName: 'clamp',
        helper: 1,
        library: 'tiny-utils',
        name: 'clampValue',
        reason: 'Both bound a number to a range.',
      },
    ]

    const diagnostics = await lint(['tiny-utils'])

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0].loc?.start.line).toBe(1)
    expect(diagnostics[0].message).toBe('Helper "clampValue" reimplements `clamp` from `tiny-utils`. Both bound a number to a range.')
    expect(diagnostics[0].evidence).toEqual({ export: 'clamp', library: 'tiny-utils', reason: 'Both bound a number to a range.' })
  })

  it('drops a finding that names an export, a library, or a helper that does not exist', async () => {
    findings = [
      {
        exportName: 'clampNumber',
        helper: 1,
        library: 'tiny-utils',
        name: 'clampValue',
        reason: 'Invented export.',
      },
      {
        exportName: 'clamp',
        helper: 1,
        library: 'other-utils',
        name: 'clampValue',
        reason: 'Invented library.',
      },
      {
        exportName: 'clamp',
        helper: 3,
        library: 'tiny-utils',
        name: 'boundValue',
        reason: 'Invented helper.',
      },
    ]

    expect(await lint(['tiny-utils'])).toEqual([])
  })

  it('asks nothing when no listed library can be loaded', async () => {
    expect(await lint(['missing-utils'])).toEqual([])
    expect(requests).toEqual([])
  })

  it('asks nothing when settings.simplicity.judge is false', async () => {
    expect(await lint(['tiny-utils'], {
      simplicity: { cache: false, judge: false },
    })).toEqual([])
    expect(requests).toEqual([])
  })
})

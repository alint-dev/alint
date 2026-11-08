import type { Buffer } from 'node:buffer'
import type { AddressInfo } from 'node:net'

import type { DiagnosticDescriptor, FileTarget, RuleContext } from '@alint-js/plugin'

import type { MixedLibrariesOptions } from './rule'

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createSourceRuntime } from '@alint-js/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mixedLibrariesRule } from './rule'

interface Group {
  alternatives: { name: string, reason: string }[]
  canonical: string
  purpose: string
}

/* A real server answers the model call rather than a stub, so the request the rule sends stays under test. */
let baseURL: string
let close: () => Promise<void>
let requests: Record<string, unknown>[]
let groups: Group[]
let cwd: string

const WORKSPACE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'repo' }),
  'packages/api/src/order.ts': 'import { object } from \'valibot\'\n',
  'packages/api/src/user.ts': 'import * as v from \'valibot\'\nimport type { Node } from \'@types/node\'\n',
  'packages/app/package.json': JSON.stringify({ name: '@repo/app' }),
  'packages/app/src/form.ts': 'import { object, string } from \'valibot\'\nimport type { Buffer } from \'node:buffer\'\n',
  'packages/app/src/schema.ts': [
    'import { z } from \'zod\'',
    'import { shared } from \'@repo/app/shared\'',
    '',
    'export const user = z.object({ name: z.string() })',
    'export const again = await import(\'zod\')',
  ].join('\n'),
}

beforeEach(async () => {
  requests = []
  groups = []
  cwd = await mkdtemp(join(tmpdir(), 'mixed-libraries-'))
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
      response.end(JSON.stringify(completion(groups)))
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

function completion(reported: Group[]): unknown {
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
                arguments: JSON.stringify({ groups: reported }),
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

/** One context is one run: the review is shared through `src`. */
function createRun(options: { allow?: string[][], preferred?: string[] } = {}) {
  const diagnostics: DiagnosticDescriptor[] = []
  const context: RuleContext<readonly [MixedLibrariesOptions]> = {
    cwd,
    id: 'js/no-mixed-libraries',
    localId: 'no-mixed-libraries',
    logger: {
      debug: () => {},
    },
    metering: {
      recordUsage: () => {},
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
    options: [
      { allow: options.allow ?? [], preferred: options.preferred ?? [] },
    ],
    report: diagnostic => void diagnostics.push(diagnostic),
    settings: {},
    src: createSourceRuntime({
      readFile: async () => { throw new Error('the rule reads files from disk') },
    }),
  }
  const rule = mixedLibrariesRule.create(context)

  return {
    diagnostics,
    lint: async (relativePath: string) => {
      const path = join(cwd, relativePath)
      const target: FileTarget = {
        file: { contentHash: 'unused', language: 'typescript', path },
        identity: `file:${path}`,
        kind: 'file',
        language: 'typescript',
      }
      await rule.onTargetFile?.(target)
    },
  }
}

function userPrompt(): string {
  const messages = requests[0].messages as { content: string, role: string }[]
  return messages.filter(message => message.role === 'user').map(message => message.content).join('\n')
}

const ZOD_AND_VALIBOT: Group = {
  alternatives: [
    { name: 'valibot', reason: 'Both validate schemas.' },
  ],
  canonical: 'zod',
  purpose: 'schema validation',
}

describe('no-mixed-libraries', () => {
  it('reports every import of the replaced package in the linted file', async () => {
    groups = [ZOD_AND_VALIBOT]
    const run = createRun({
      preferred: ['valibot'],
    })

    await run.lint('packages/app/src/schema.ts')

    // The preferred package wins over the canonical package that the model chose.
    expect(run.diagnostics.map(diagnostic => diagnostic.loc?.start.line)).toEqual([1, 5])
    expect(run.diagnostics[0].message).toContain('`zod` duplicates `valibot` (schema validation)')
    expect(run.diagnostics[0].message).toContain('`valibot` has 3 importing files and `zod` has 1')
    expect(run.diagnostics[0].evidence).toEqual({ canonical: 'valibot', suggestion: 'Use `valibot` instead of `zod`.' })
  })

  it('asks the model one time for a run, and reports nothing in a file that imports only the canonical package', async () => {
    groups = [ZOD_AND_VALIBOT]
    const run = createRun({
      preferred: ['valibot'],
    })

    await run.lint('packages/app/src/form.ts')
    await run.lint('packages/app/src/schema.ts')
    await run.lint('packages/api/src/user.ts')

    expect(requests).toHaveLength(1)
    expect(run.diagnostics.every(diagnostic => diagnostic.filePath?.endsWith('schema.ts'))).toBe(true)
  })

  it('lists only external packages, with their file counts and directories', async () => {
    const run = createRun({
      preferred: ['valibot'],
    })

    await run.lint('packages/app/src/form.ts')

    const prompt = userPrompt()
    expect(prompt).toContain('Preferred packages: valibot')
    expect(prompt).toContain('valibot: 3 files (packages/api 2, packages/app 1)')
    expect(prompt).toContain('zod: 1 files (packages/app 1)')
    // Workspace packages, type packages, and built-in modules are not library choices.
    expect(prompt).not.toContain('@repo/app')
    expect(prompt).not.toContain('@types/node')
    expect(prompt).not.toContain('node:buffer')
  })

  it('drops a group that names a package no file imports', async () => {
    groups = [
      {
        ...ZOD_AND_VALIBOT,
        alternatives: [
          ...ZOD_AND_VALIBOT.alternatives,
          { name: 'yup', reason: 'Invented.' },
        ],
      },
    ]
    const run = createRun()

    await run.lint('packages/app/src/form.ts')

    expect(run.diagnostics).toEqual([])
  })

  it('reports nothing for a group that an allow set covers', async () => {
    groups = [ZOD_AND_VALIBOT]
    const run = createRun({
      allow: [
        ['valibot', 'zod'],
      ],
      preferred: ['valibot'],
    })

    await run.lint('packages/app/src/schema.ts')

    expect(run.diagnostics).toEqual([])
  })
})

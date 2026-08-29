import type { RunResult } from '@alint-js/core'

import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getGlobalSetupConfigPath, getProjectSetupConfigPath, writeSetupConfig } from '@alint-js/config'
import { describe, expect, it, vi } from 'vitest'

import * as alintCore from '@alint-js/core'

import packageJson from '../../package.json'

import { executeCli } from './cli'
import { createProviderId, providerSetupSources } from './provider-registry'
import { formatProbeModelsFailure, isBackInput, withBackOption } from './tui/provider-editor/prompts'

interface TestIo {
  cwd: string
  env?: NodeJS.ProcessEnv
  stderr: { columns?: number, isTTY?: boolean, rows?: number, write: (chunk: string) => void }
  stderrText: string
  stdout: { write: (chunk: string) => void }
  stdoutText: string
}

// Remove CI signals so the stats writer still works in the CI environment.
function clearCiEnv(env: NodeJS.ProcessEnv | undefined): void {
  if (!env) {
    return
  }

  for (const key of ['BUILDKITE', 'CI', 'CIRCLECI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'TF_BUILD']) {
    delete env[key]
  }
}

async function createDirectoryPlugin(cwd: string, name: string): Promise<void> {
  const pluginRoot = join(cwd, 'plugins', name)
  await mkdir(pluginRoot, { recursive: true })
  await writeFile(join(pluginRoot, 'index.mjs'), 'export default { rules: {} }\n', 'utf8')
  await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
    exports: './index.mjs',
    name,
    type: 'module',
    version: '1.0.0',
  }), 'utf8')
}

async function createTestIo(): Promise<TestIo> {
  const cwd = await mkdtemp(join(tmpdir(), 'alint-cli-'))
  const configHome = await mkdtemp(join(tmpdir(), 'alint-config-home-'))
  const io: TestIo = {
    cwd,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
    },
    stderr: {
      write: (chunk: string) => {
        io.stderrText += chunk
      },
    },
    stderrText: '',
    stdout: {
      write: (chunk: string) => {
        io.stdoutText += chunk
      },
    },
    stdoutText: '',
  }

  return io
}

function statsDirOf(io: { env?: NodeJS.ProcessEnv }): string {
  return join(io.env?.XDG_CONFIG_HOME ?? '', 'alint', 'stats')
}

async function withModelsServer(
  handler: (request: { headers: NodeJS.Dict<string | string[] | undefined>, url?: string }) => { body: unknown, status?: number },
): Promise<{ close: () => Promise<void>, endpoint: string }> {
  const server = createServer((request, response) => {
    const result = handler({ headers: request.headers, url: request.url })
    response.statusCode = result.status ?? 200
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(result.body))
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()

  if (address === null || typeof address === 'string') {
    throw new Error('Expected TCP test server address.')
  }

  return {
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    }),
    endpoint: `http://127.0.0.1:${address.port}/v1/`,
  }
}

async function writeCacheFixture(cwd: string, runnerConfig = ''): Promise<void> {
  await writeFile(join(cwd, 'demo.ts'), 'export function load() {}\n')
  const callKey = `__alintCacheFixtureCalls_${cwd}`
  await writeFile(join(cwd, 'alint.config.ts'), `
const callKey = ${JSON.stringify(callKey)}
globalThis[callKey] = globalThis[callKey] ?? 0

export default [
  {
    files: ['**/*.ts'],
    plugins: {
      company: {
        rules: {
          cached: {
            languages: 'any',
            create: (ctx) => ({
              onTargetFunction: async (target) => {
                globalThis[callKey] += 1
                ctx.report({
                  filePath: target.file.path,
                  message: 'checked ' + globalThis[callKey],
                })
              },
            }),
          },
        },
      },
    },
    rules: {
      'company/cached': 'warn',
    },
    ${runnerConfig}
  },
]
`)
}

async function writeCauseFailureFixture(cwd: string): Promise<void> {
  await writeFile(join(cwd, 'demo.ts'), 'export function load() {}\n')
  await writeFile(join(cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    plugins: {
      company: {
        rules: {
          review: {
            create: () => ({
              onTargetFile: () => {
                const socketError = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
                throw new TypeError('fetch failed', { cause: socketError })
              },
            }),
          },
        },
      },
    },
    rules: {
      'company/review': 'warn',
    },
  },
]
`)
}

async function writeOutputLanguageFixture(cwd: string): Promise<void> {
  await writeFile(join(cwd, 'demo.ts'), 'export function load() {}\n')
  await writeFile(join(cwd, 'alint.config.ts'), `
export default [
  {
    plugins: {
      review: {
        rules: {
          language: {
            create: ctx => ({
              onTargetFile: target => {
                if (target.kind !== 'file') return
                ctx.report({
                  filePath: target.file.path,
                  message: 'answer in ' + ctx.outputLanguage,
                })
              },
            }),
          },
        },
      },
    },
    rules: {
      'review/language': 'warn',
    },
  },
]
`)
}

async function writePartialFailureFixture(cwd: string): Promise<void> {
  await writeFile(join(cwd, 'demo.ts'), 'export function load() {}\n')
  await writeFile(join(cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    plugins: {
      company: {
        rules: {
          finding: {
            create: ctx => ({
              onTargetFile: target => ctx.report({
                filePath: target.file.path,
                message: 'Partial finding',
              }),
            }),
          },
          review: {
            create: () => ({
              onTargetFile: () => {
                throw new Error('Remote sent 403 response: {"error":{"message":"The request is prohibited due to a violation of provider Terms Of Service.","code":403},"user_id":"secret"}')
              },
            }),
          },
        },
      },
    },
    rules: {
      'company/finding': 'warn',
      'company/review': 'warn',
    },
  },
]
`)
}

async function writeProgressFixture(cwd: string): Promise<void> {
  await writeFile(join(cwd, 'demo.ts'), [
    'export function load() {',
    '  return 1',
    '}',
    '',
  ].join('\n'))

  await writeFile(join(cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    plugins: {
      company: {
        rules: {
          'prefer-load': {
            languages: 'any',
            create: (ctx) => ({
              onTargetFunction: async (target) => {
                ctx.report({
                  filePath: target.file.path,
                  message: 'Problem found',
                  loc: target.loc,
                })
              },
            }),
          },
        },
      },
    },
    rules: {
      'company/prefer-load': 'warn',
    },
  },
]
`)
}

async function writeRuleConcurrencyFailureFixture(cwd: string, callKey: string): Promise<void> {
  await writeFile(join(cwd, 'demo.ts'), 'export function load() {}\n')
  const rules = Array.from({ length: 6 }, (_, index) => `
          'concurrent-${index}': {
            create: () => ({
              onTargetFile: async () => {
                const state = globalThis[${JSON.stringify(callKey)}]
                state.active += 1
                state.maxActive = Math.max(state.maxActive, state.active)
                // Keep the concurrent state alive across the bounded renderer's 120ms frame.
                await new Promise(resolve => setTimeout(resolve, 180))
                state.active -= 1
                if (${index} === 0) throw new Error('controlled handler failure')
              },
            }),
          },`).join('')
  const enabled = Array.from({ length: 6 }, (_, index) => `
      'company/concurrent-${index}': 'warn',`).join('')

  await writeFile(join(cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    plugins: {
      company: {
        rules: {${rules}
        },
      },
    },
    rules: {${enabled}
    },
  },
]
`)
}

// A run fixture whose rule records inference usage directly via ctx.metering, so a full lint
// run produces usage records (with an `operation` tag) without any model/provider HTTP.
async function writeStatsFixture(cwd: string): Promise<void> {
  await writeFile(join(cwd, 'demo.ts'), 'export function load() {}\n')
  await writeFile(join(cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    plugins: {
      company: {
        rules: {
          judge: {
            languages: 'any',
            create: ctx => ({
              onTargetFunction: (target) => {
                ctx.metering.recordUsage({
                  filePath: target.file.path,
                  inputTokens: 100,
                  metadata: { operation: 'judge' },
                  modelId: 'gpt-4o',
                  outputTokens: 20,
                  providerId: 'openai',
                  totalTokens: 120,
                })
                ctx.report({ filePath: target.file.path, message: 'checked' })
              },
            }),
          },
        },
      },
    },
    rules: {
      'company/judge': 'warn',
    },
  },
]
`)
}

describe('createProviderId', () => {
  it('creates endpoint-based provider ids and avoids collisions', () => {
    expect(createProviderId('https://openrouter.ai/api/v1', new Set())).toBe('openrouter')
    expect(createProviderId('https://openrouter.ai/api/v1', new Set(['openrouter']))).toBe('openrouter-2')
    expect(createProviderId('not a url', new Set())).toBe('provider')
  })

  it('uses lower-case built-in provider ids and avoids collisions', () => {
    expect(createProviderId('http://127.0.0.1:8317/v1', new Set())).toBe('cliproxyapi')
    expect(createProviderId('http://127.0.0.1:8317/v1', new Set(['cliproxyapi']))).toBe('cliproxyapi-2')
    expect(createProviderId('http://127.0.0.1:8317/v1', new Set(['cliproxyapi', 'cliproxyapi-2']))).toBe('cliproxyapi-3')
    expect(createProviderId('http://localhost:11434/v1', new Set())).toBe('ollama')
    expect(createProviderId('https://api.cerebras.ai/v1', new Set())).toBe('cerebras')
    expect(createProviderId('https://api.groq.com/openai/v1', new Set())).toBe('groq')
  })
})

describe('interactive setup navigation', () => {
  it('provides documented ACP presets for supported coding-agent CLIs', () => {
    expect(providerSetupSources).toContainEqual({
      args: ['-y', '@agentclientprotocol/claude-agent-acp'],
      command: 'npx',
      defaultProviderId: 'claude-code',
      kind: 'acp',
      label: 'Claude Code (ACP)',
      model: { id: 'claude-code', name: 'Claude Code' },
      value: 'claudeCodeAcp',
    })
    expect(providerSetupSources).toContainEqual({
      args: ['-y', '@agentclientprotocol/codex-acp'],
      command: 'npx',
      defaultProviderId: 'codex',
      kind: 'acp',
      label: 'Codex (ACP)',
      model: { id: 'codex', name: 'Codex' },
      value: 'codexAcp',
    })
    expect(providerSetupSources).toContainEqual({
      args: ['-y', '@google/gemini-cli', '--acp'],
      command: 'npx',
      defaultProviderId: 'gemini-cli',
      kind: 'acp',
      label: 'Gemini CLI (ACP)',
      model: { id: 'gemini-cli', name: 'Gemini CLI' },
      value: 'geminiCliAcp',
    })
    expect(providerSetupSources).toContainEqual({
      args: ['acp'],
      command: 'kimi',
      defaultProviderId: 'kimi-code',
      kind: 'acp',
      label: 'Kimi Code CLI (ACP)',
      model: { id: 'kimi-code', name: 'Kimi Code CLI' },
      value: 'kimiCliAcp',
    })
    expect(providerSetupSources).toContainEqual({
      args: ['acp'],
      command: 'opencode',
      defaultProviderId: 'opencode',
      kind: 'acp',
      label: 'OpenCode (ACP)',
      model: { id: 'opencode', name: 'OpenCode' },
      value: 'openCodeAcp',
    })
  })

  it('keeps built-in provider setup defaults in the provider registry', () => {
    expect(providerSetupSources).toContainEqual({
      benchmarkConcurrency: 2,
      defaultEndpoint: 'http://127.0.0.1:8317/v1',
      defaultProviderId: 'CLIProxyAPI',
      kind: 'openai-compatible',
      label: 'CLIProxyAPI',
      probeModels: true,
      value: 'cliProxyApi',
    })
    expect(providerSetupSources).toContainEqual({
      benchmarkConcurrency: 2,
      defaultEndpoint: 'http://localhost:11434/v1',
      kind: 'openai-compatible',
      label: 'Ollama',
      probeModels: true,
      value: 'ollama',
    })
    expect(providerSetupSources).toContainEqual({
      benchmarkConcurrency: 2,
      defaultEndpoint: 'https://api.cerebras.ai/v1',
      defaultProviderId: 'cerebras',
      kind: 'openai-compatible',
      label: 'Cerebras',
      probeModels: true,
      value: 'cerebras',
    })
    expect(providerSetupSources).toContainEqual({
      benchmarkConcurrency: 2,
      defaultEndpoint: 'https://api.groq.com/openai/v1',
      defaultProviderId: 'groq',
      kind: 'openai-compatible',
      label: 'Groq',
      probeModels: true,
      value: 'groq',
    })
    expect(providerSetupSources).toContainEqual({
      benchmarkConcurrency: 20,
      defaultEndpoint: 'https://openrouter.ai/api/v1',
      defaultProviderId: 'openrouter',
      kind: 'openai-compatible',
      label: 'OpenRouter',
      probeModels: true,
      value: 'openrouter',
    })
  })

  it('adds an explicit back option and recognizes text back input', () => {
    expect(withBackOption([{ label: 'Ollama', value: 'ollama' }])).toEqual([
      { label: 'Ollama', value: 'ollama' },
      { label: 'Back', value: '__alint_back__' },
    ])
    expect(isBackInput('..')).toBe(true)
    expect(isBackInput(' .. ')).toBe(true)
    expect(isBackInput('qwen:8b')).toBe(false)
  })

  it('explains likely Ollama HTTPS probe failures', () => {
    expect(formatProbeModelsFailure('https://localhost:11434/v1', new Error('fetch failed'))).toBe(
      'Could not probe models: fetch failed. Ollama usually uses http://localhost:11434/v1.',
    )
  })
})

describe('executeCli', () => {
  async function writeRunOutputFixture(
    cwd: string,
    fileName = 'alint-output.json',
    severity: 'error' | 'warn' = 'warn',
  ): Promise<string> {
    const outputPath = join(cwd, fileName)

    await writeFile(outputPath, JSON.stringify({
      diagnostics: [
        {
          filePath: '/repo/src/demo.ts',
          loc: { start: { column: 3, line: 12 } },
          message: 'Problem found',
          ruleId: 'company/problem',
          severity,
        },
      ],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        records: [],
        totalTokens: 15,
      },
    }, null, 2))

    return outputPath
  }

  it('renders warning-only saved output with the stylish reporter and returns 0', async () => {
    const io = await createTestIo()
    const outputPath = await writeRunOutputFixture(io.cwd)

    const exitCode = await executeCli(['node', 'alint', 'output', 'inspect', outputPath], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('/repo/src/demo.ts')
    expect(io.stdoutText).toContain('12:3')
    expect(io.stdoutText).toContain('warning')
    expect(io.stdoutText).toContain('Problem found')
    expect(io.stdoutText).toContain('company/problem')
    expect(io.stdoutText).toContain('1 warn / 0 error | 15 tokens')
    expect(io.stderrText).toBe('')
  })

  it('returns 1 when saved output contains an error diagnostic', async () => {
    const io = await createTestIo()
    const outputPath = await writeRunOutputFixture(io.cwd, 'alint-output.json', 'error')

    const exitCode = await executeCli(['node', 'alint', 'output', 'inspect', outputPath], io)

    expect(exitCode).toBe(1)
    expect(io.stdoutText).toContain('error')
    expect(io.stdoutText).toContain('Problem found')
    expect(io.stderrText).toBe('')
  })

  it('records a stats line after a lint run', async () => {
    const io = await createTestIo()
    clearCiEnv(io.env)
    await writeStatsFixture(io.cwd)

    const exitCode = await executeCli(['node', 'alint', 'demo.ts'], io)

    expect(exitCode).toBe(0)
    const files = await readdir(statsDirOf(io))
    expect(files).toHaveLength(1)
    const lines = (await readFile(join(statsDirOf(io), files[0]), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0])
    expect(record.cwd).toBe(io.cwd)
    expect(record.ruleCounts.completed).toBeGreaterThanOrEqual(1)
    expect(record.usage.totalTok).toBe(120)
    expect(record.usage.records[0].operation).toBe('judge')
    expect(record.usage.records[0].modelId).toBe('gpt-4o')
  })

  it('does not record stats with --no-stats', async () => {
    const io = await createTestIo()
    clearCiEnv(io.env)
    await writeStatsFixture(io.cwd)

    await executeCli(['node', 'alint', '--no-stats', 'demo.ts'], io)

    // The stats dir is only created on write, so its absence proves nothing was recorded.
    await expect(readdir(statsDirOf(io))).rejects.toThrow()
  })

  it('does not record stats in CI', async () => {
    const io = await createTestIo()
    clearCiEnv(io.env)

    if (io.env) {
      io.env.CI = 'true'
    }

    await writeStatsFixture(io.cwd)

    await executeCli(['node', 'alint', 'demo.ts'], io)

    await expect(readdir(statsDirOf(io))).rejects.toThrow()
  })

  it('reprints saved output with the json reporter', async () => {
    const io = await createTestIo()
    const outputPath = await writeRunOutputFixture(io.cwd)

    const exitCode = await executeCli([
      'node',
      'alint',
      'output',
      'inspect',
      outputPath,
      '--format',
      'json',
    ], io)

    expect(exitCode).toBe(0)
    expect(JSON.parse(io.stdoutText)).toEqual({
      diagnostics: [
        {
          filePath: '/repo/src/demo.ts',
          loc: { start: { column: 3, line: 12 } },
          message: 'Problem found',
          ruleId: 'company/problem',
          severity: 'warn',
        },
      ],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        records: [],
        totalTokens: 15,
      },
    })
    expect(io.stderrText).toBe('')
  })

  it('returns 2 for unknown output inspect formats', async () => {
    const io = await createTestIo()
    const outputPath = await writeRunOutputFixture(io.cwd)

    const exitCode = await executeCli([
      'node',
      'alint',
      'output',
      'inspect',
      outputPath,
      '--format',
      'compact',
    ], io)

    expect(exitCode).toBe(2)
    expect(io.stdoutText).toBe('')
    expect(io.stderrText).toContain('Unknown reporter "compact".')
  })

  it('returns 2 for invalid output json', async () => {
    const io = await createTestIo()
    const outputPath = join(io.cwd, 'broken.json')
    await writeFile(outputPath, '{')

    const exitCode = await executeCli(['node', 'alint', 'output', 'inspect', outputPath], io)

    expect(exitCode).toBe(2)
    expect(io.stdoutText).toBe('')
    expect(io.stderrText).toContain('Could not parse output file')
  })

  it('returns 2 for structurally invalid alint output', async () => {
    const io = await createTestIo()
    const outputPath = join(io.cwd, 'invalid-output.json')
    await writeFile(outputPath, JSON.stringify({ diagnostics: {} }))

    const exitCode = await executeCli(['node', 'alint', 'output', 'inspect', outputPath], io)

    expect(exitCode).toBe(2)
    expect(io.stdoutText).toBe('')
    expect(io.stderrText).toContain('Invalid alint output')
  })

  it('returns 2 when the output file cannot be read', async () => {
    const io = await createTestIo()
    const outputPath = join(io.cwd, 'missing.json')

    const exitCode = await executeCli(['node', 'alint', 'output', 'inspect', outputPath], io)

    expect(exitCode).toBe(2)
    expect(io.stdoutText).toBe('')
    expect(io.stderrText).toContain('Could not read output file')
  })

  it('prints available subcommands when a command group is missing a subcommand', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli(['node', 'alint', 'output'], io)

    expect(exitCode).toBe(2)
    expect(io.stdoutText).toBe('')
    expect(io.stderrText).toBe([
      'missing subcommand for "output"',
      '',
      'available subcommands:',
      '  inspect',
      '',
      'run `alint output --help` for more information',
      '',
    ].join('\n'))
  })

  it('prints output inspect in output command help', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli(['node', 'alint', 'output', '--help'], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('Inspect saved alint run outputs without rerunning rules or model calls.')
    expect(io.stdoutText).toContain('Use this when you already have JSON from `alint --format json`')
    expect(io.stdoutText).toContain('Usage:')
    expect(io.stdoutText).toContain('$ alint output')
    expect(io.stdoutText).toContain('Commands:')
    expect(io.stdoutText).toContain('output inspect <file>')
    expect(io.stdoutText).toContain('Inspect saved alint JSON output')
    expect(io.stdoutText).not.toContain('--cache-location')
    expect(io.stderrText).toBe('')
  })

  it('prints output inspect usage and options in output inspect help', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli(['node', 'alint', 'output', 'inspect', '--help'], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('Read a saved alint JSON run result and render it with a reporter.')
    expect(io.stdoutText).toContain('Defaults to the human-friendly stylish reporter')
    expect(io.stdoutText).toContain('Examples:')
    expect(io.stdoutText).toContain('# Pretty-print saved JSON output')
    expect(io.stdoutText).toContain('alint output inspect alint-output.json')
    expect(io.stdoutText).toContain('# Validate and reprint normalized JSON')
    expect(io.stdoutText).toContain('alint output inspect alint-output.json --format json')
    expect(io.stdoutText).toContain('Usage:')
    expect(io.stdoutText).toContain('$ alint output inspect <file>')
    expect(io.stdoutText).toContain('Options:')
    expect(io.stdoutText).toContain('-f, --format <format>')
    expect(io.stdoutText).not.toContain('--cache-location')
    expect(io.stderrText).toBe('')
  })

  it('prints only direct config subcommands in config command help', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli(['node', 'alint', 'config', '--help'], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('Inspect and update alint setup/configuration state.')
    expect(io.stdoutText).toContain('Examples:')
    expect(io.stdoutText).toContain('alint config inspect src/index.ts')
    expect(io.stdoutText).toContain('alint config providers list')
    expect(io.stdoutText).toContain('alint config models list')
    expect(io.stdoutText).toContain('alint config models probe --endpoint https://openrouter.ai/api/v1')
    expect(io.stdoutText).toContain('Commands:')
    expect(io.stdoutText).toContain('config inspect <path>')
    expect(io.stdoutText).toContain('config models')
    expect(io.stdoutText).toContain('config providers')
    expect(io.stderrText).toBe('')
  })

  it('prints description for config inspect help', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli(['node', 'alint', 'config', 'inspect', '--help'], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('Inspect resolved config for a file')
    expect(io.stdoutText).toContain('Usage:')
    expect(io.stdoutText).toContain('$ alint config inspect <path>')
    expect(io.stderrText).toBe('')
  })

  it('installs static plugins as a no-op when the config has no static plugin references', async () => {
    const io = await createTestIo()
    await writeFile(join(io.cwd, 'empty.config.ts'), 'export default [{ rules: {} }]\n', 'utf8')

    const exitCode = await executeCli(['node', 'alint', '--config', 'empty.config.ts', 'plugin', 'install'], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toBe('No static plugins configured. Wrote empty plugin lock.\n')
    expect(io.stderrText).toBe('')
  })

  it('reports one installed local plugin directory', async () => {
    const io = await createTestIo()
    await createDirectoryPlugin(io.cwd, 'local-plugin')
    await writeFile(join(io.cwd, 'alint.config.toml'), `
[[config.group]]
[config.group.plugins]
local = "./plugins/local-plugin"
`, 'utf8')

    const exitCode = await executeCli(['node', 'alint', 'plugin', 'install'], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toBe('Installed packages: 0, local directories: 1.\n')
    expect(io.stderrText).toBe('')
  })

  it('documents local directory installation in plugin help', async () => {
    const io = await createTestIo()

    await executeCli(['node', 'alint', 'plugin', '--help'], io)

    expect(io.stdoutText).toContain('[[config.group]]')
  })

  it('prints contextual help when global options come before the command', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli([
      'node',
      'alint',
      '--config',
      'alint.config.ts',
      'config',
      'inspect',
      '--help',
    ], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('Inspect resolved config for a file')
    expect(io.stdoutText).toContain('Usage:')
    expect(io.stdoutText).toContain('$ alint config inspect <path>')
    expect(io.stdoutText).not.toContain('$ alint [...files]')
    expect(io.stderrText).toBe('')
  })

  it('prints only direct nested config subcommands in config models help', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli(['node', 'alint', 'config', 'models', '--help'], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('Inspect, list, and probe model entries from alint setup configuration.')
    expect(io.stdoutText).toContain('Commands:')
    expect(io.stdoutText).toContain('config models probe')
    expect(io.stdoutText).toContain('config models list')
    expect(io.stdoutText).toContain('config models show <model>')
    expect(io.stdoutText).not.toContain('config providers')
    expect(io.stdoutText).not.toContain('--provider-header')
    expect(io.stderrText).toBe('')
  })

  it('prints nested command usage and options in config models probe help', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli(['node', 'alint', 'config', 'models', 'probe', '--help'], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('Probe an OpenAI-compatible models endpoint before saving it in setup config.')
    expect(io.stdoutText).toContain('Examples:')
    expect(io.stdoutText).toContain('alint config models probe --endpoint https://openrouter.ai/api/v1')
    expect(io.stdoutText).toContain('Usage:')
    expect(io.stdoutText).toContain('$ alint config models probe')
    expect(io.stdoutText).toContain('Options:')
    expect(io.stdoutText).toContain('--endpoint <url>')
    expect(io.stdoutText).toContain('--provider-header <Key=Value>')
    expect(io.stdoutText).not.toContain('--cache-location')
    expect(io.stderrText).toBe('')
  })

  it('prints the live benchmark option in config models list help', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli(['node', 'alint', 'config', 'models', 'list', '--help'], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('$ alint config models list')
    expect(io.stdoutText).toContain('--with-speed')
    expect(io.stdoutText).toContain('--with-speed-concurrency <provider-id=limit>')
    expect(io.stdoutText).toContain('Benchmark configured models with live requests')
    expect(io.stderrText).toBe('')
  })

  it('writes local setup config and returns 0 for non-interactive setup', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli([
      'node',
      'alint',
      'setup',
      '-N',
      '--local',
      '--provider-id',
      'ollama',
      '--provider-endpoint',
      'http://localhost:11434/v1',
      '--provider-model',
      'qwen:8b',
    ], io)

    expect(exitCode).toBe(0)

    const toml = await readFile(getProjectSetupConfigPath(io.cwd), 'utf8')
    expect(toml).toContain('id = "ollama"')
    expect(toml).toContain('endpoint = "http://localhost:11434/v1"')
    expect(toml).toContain('id = "qwen:8b"')
  })

  it('treats --no-interactive as equivalent to -N', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli([
      'node',
      'alint',
      'setup',
      '--no-interactive',
      '--local',
      '--provider-id',
      'ollama',
      '--provider-endpoint',
      'http://localhost:11434/v1',
      '--provider-model',
      'qwen:8b',
    ], io)

    expect(exitCode).toBe(0)
    expect(await readFile(getProjectSetupConfigPath(io.cwd), 'utf8')).toContain('id = "qwen:8b"')
  })

  it('writes provider id from --provider-id during non-interactive setup', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli([
      'node',
      'alint',
      'setup',
      '-N',
      '--local',
      '--provider-id',
      'ollama',
      '--provider-endpoint',
      'http://localhost:11434/v1',
      '--provider-model',
      'qwen:8b',
    ], io)

    expect(exitCode).toBe(0)

    const toml = await readFile(getProjectSetupConfigPath(io.cwd), 'utf8')
    expect(toml).toContain('id = "ollama"')
    expect(toml).toContain('endpoint = "http://localhost:11434/v1"')
    expect(toml).toContain('id = "qwen:8b"')
  })

  it('keeps repeated setup providers separate when provider ids differ', async () => {
    const io = await createTestIo()

    const firstExitCode = await executeCli([
      'node',
      'alint',
      'setup',
      '-N',
      '--local',
      '--provider-id',
      'first',
      '--provider-endpoint',
      'http://localhost:11434/v1',
      '--provider-model',
      'first-model',
      '--provider-header',
      'Authorization=Bearer first',
    ], io)

    expect(firstExitCode).toBe(0)

    const secondExitCode = await executeCli([
      'node',
      'alint',
      'setup',
      '-N',
      '--local',
      '--provider-id',
      'second',
      '--provider-endpoint',
      'http://localhost:11434/v1',
      '--provider-model',
      'second-model',
      '--provider-header',
      'Authorization=Bearer second',
    ], io)

    expect(secondExitCode).toBe(0)

    const toml = await readFile(getProjectSetupConfigPath(io.cwd), 'utf8')
    expect(toml).toContain('id = "first"')
    expect(toml).toContain('id = "second"')
    expect(toml).toContain('id = "first-model"')
    expect(toml).toContain('id = "second-model"')
    expect(toml).toContain('Authorization = "Bearer first"')
    expect(toml).toContain('Authorization = "Bearer second"')
  })

  it('writes global setup config under XDG_CONFIG_HOME with repeated models and headers', async () => {
    const io = await createTestIo()
    const configHome = await mkdtemp(join(tmpdir(), 'alint-config-home-'))
    io.env = {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
    }

    const exitCode = await executeCli([
      'node',
      'alint',
      'setup',
      '-N',
      '--provider-id',
      'ollama',
      '--provider-endpoint',
      'http://localhost:11434/v1',
      '--provider-model',
      'qwen:8b',
      '--provider-model',
      'qwen:32b',
      '--provider-header',
      'Authorization=Bearer token',
      '--provider-header',
      'X-Test=true',
    ], io)

    expect(exitCode).toBe(0)

    const toml = await readFile(join(configHome, 'alint/config.toml'), 'utf8')
    expect(toml).toContain('id = "qwen:8b"')
    expect(toml).toContain('id = "qwen:32b"')
    expect(toml).toContain('Authorization = "Bearer token"')
    expect(toml).toContain('X-Test = "true"')
  })

  it('prints discovered models from config models probe', async () => {
    const io = await createTestIo()
    const server = await withModelsServer(({ headers, url }) => {
      expect(url).toBe('/v1/models')
      expect(headers.authorization).toBe('Bearer probe')

      return {
        body: {
          data: [
            { id: 'qwen:8b' },
            { id: 'qwen:32b' },
          ],
        },
      }
    })

    try {
      const exitCode = await executeCli([
        'node',
        'alint',
        'config',
        'models',
        'probe',
        '--endpoint',
        server.endpoint,
        '--provider-header',
        'Authorization=Bearer probe',
      ], io)

      expect(exitCode).toBe(0)
      expect(io.stdoutText).toBe('qwen:8b\nqwen:32b\n')
      expect(io.stderrText).toBe('')
    }
    finally {
      await server.close()
    }
  })

  it('returns 2 when config models probe cannot read OpenAI-compatible models', async () => {
    const io = await createTestIo()
    const server = await withModelsServer(() => ({ body: { data: [] }, status: 500 }))

    try {
      const exitCode = await executeCli([
        'node',
        'alint',
        'config',
        'models',
        'probe',
        '--endpoint',
        server.endpoint,
      ], io)

      expect(exitCode).toBe(2)
      expect(io.stderrText).toContain('failed to probe models:')
      expect(io.stdoutText).toBe('')
    }
    finally {
      await server.close()
    }
  })

  it('returns 2 when config models probe receives a malformed response', async () => {
    const io = await createTestIo()
    const server = await withModelsServer(() => ({ body: {} }))

    try {
      const exitCode = await executeCli([
        'node',
        'alint',
        'config',
        'models',
        'probe',
        '--endpoint',
        server.endpoint,
      ], io)

      expect(exitCode).toBe(2)
      expect(io.stderrText).toContain('failed to probe models:')
      expect(io.stdoutText).toBe('')
    }
    finally {
      await server.close()
    }
  })

  it('lists flattened configured models', async () => {
    const io = await createTestIo()

    await writeSetupConfig(getProjectSetupConfigPath(io.cwd), {
      providers: [
        {
          endpoint: 'http://localhost:11434/v1',
          id: 'ollama',
          models: [
            { id: 'local:qwen-8b', name: 'qwen:8b' },
            { id: 'local:qwen-32b' },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    })

    const exitCode = await executeCli([
      'node',
      'alint',
      'config',
      'models',
      'ls',
    ], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toBe([
      'id              provider  name            ',
      'local:qwen-8b   ollama    qwen:8b         ',
      'local:qwen-32b  ollama    local:qwen-32b  ',
      '',
    ].join('\n'))
  })

  it('shows one configured model by alias without printing header values', async () => {
    const io = await createTestIo()

    await writeSetupConfig(getProjectSetupConfigPath(io.cwd), {
      providers: [
        {
          endpoint: 'http://localhost:11434/v1',
          headers: { Authorization: 'Bearer secret' },
          id: 'ollama',
          models: [
            {
              aliases: ['default'],
              capabilities: ['code-review'],
              contextWindow: 32768,
              defaultParams: { temperature: 0.1 },
              id: 'local:qwen-8b',
              name: 'qwen:8b',
              size: 'small',
            },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    })

    const exitCode = await executeCli([
      'node',
      'alint',
      'config',
      'models',
      'show',
      'default',
    ], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('id: local:qwen-8b\n')
    expect(io.stdoutText).toContain('name: qwen:8b\n')
    expect(io.stdoutText).toContain('provider: ollama\n')
    expect(io.stdoutText).toContain('aliases: default\n')
    expect(io.stdoutText).toContain('capabilities: code-review\n')
    expect(io.stdoutText).toContain('contextWindow: 32768\n')
    expect(io.stdoutText).toContain('defaultParams: {"temperature":0.1}\n')
    expect(io.stdoutText).not.toContain('secret')
  })

  it('returns 2 when model is unknown', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli([
      'node',
      'alint',
      'config',
      'models',
      'show',
      'missing',
    ], io)

    expect(exitCode).toBe(2)
    expect(io.stderrText).toBe('unknown model "missing".\n')
  })

  it('lists merged config providers without printing header values', async () => {
    const io = await createTestIo()

    await writeSetupConfig(getProjectSetupConfigPath(io.cwd), {
      providers: [
        {
          endpoint: 'http://localhost:11434/v1',
          headers: { Authorization: 'Bearer secret' },
          id: 'ollama',
          models: [{ id: 'qwen:8b' }, { id: 'qwen:32b' }],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    })

    const exitCode = await executeCli([
      'node',
      'alint',
      'config',
      'providers',
      'ls',
    ], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toBe([
      'id      type               endpoint                   models  ',
      'ollama  openai-compatible  http://localhost:11434/v1  2       ',
      '',
    ].join('\n'))
    expect(io.stdoutText).not.toContain('secret')
  })

  it('shows one provider with header keys only', async () => {
    const io = await createTestIo()

    await writeSetupConfig(getProjectSetupConfigPath(io.cwd), {
      providers: [
        {
          endpoint: 'https://openrouter.ai/api/v1',
          headers: {
            'Authorization': 'Bearer secret',
            'HTTP-Referer': 'https://example.test',
          },
          id: 'openrouter',
          models: [{ id: 'openai/gpt-4.1-mini' }],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    })

    const exitCode = await executeCli([
      'node',
      'alint',
      'config',
      'providers',
      'show',
      'openrouter',
    ], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('id: openrouter\n')
    expect(io.stdoutText).toContain('endpoint: https://openrouter.ai/api/v1\n')
    expect(io.stdoutText).toContain('models: openai/gpt-4.1-mini\n')
    expect(io.stdoutText).toContain('headers: Authorization, HTTP-Referer\n')
    expect(io.stdoutText).not.toContain('secret')
    expect(io.stdoutText).not.toContain('example.test')
  })

  it('returns 2 when provider is unknown', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli([
      'node',
      'alint',
      'config',
      'providers',
      'show',
      'missing',
    ], io)

    expect(exitCode).toBe(2)
    expect(io.stderrText).toBe('unknown provider "missing".\n')
  })

  it('probes provider reachability and model count', async () => {
    const io = await createTestIo()
    const server = await withModelsServer(() => ({
      body: { data: [{ id: 'one' }, { id: 'two' }] },
    }))

    try {
      const exitCode = await executeCli([
        'node',
        'alint',
        'config',
        'providers',
        'probe',
        '--endpoint',
        server.endpoint,
      ], io)

      expect(exitCode).toBe(0)
      expect(io.stdoutText).toBe(`endpoint: ${server.endpoint}\nmodels: 2\n`)
    }
    finally {
      await server.close()
    }
  })

  it('prints effective config details for a file', async () => {
    const io = await createTestIo()
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  { name: 'ignore dist', ignores: ['dist/**'] },
  {
    name: 'go files',
    files: ['**/*.go'],
    language: 'plaintext',
    rules: {
      'review/file': 'warn',
      'review/disabled': 'off',
    },
  },
]
`)

    const code = await executeCli([
      'node',
      'alint',
      'config',
      'inspect',
      'main.go',
    ], io)

    expect(code).toBe(0)
    expect(io.stdoutText).toContain('file: main.go')
    expect(io.stdoutText).toContain('ignored: no')
    expect(io.stdoutText).toContain('  - go files')
    expect(io.stdoutText).toContain('language: plaintext')
    expect(io.stdoutText).toContain('  review/file: warn')
    expect(io.stdoutText).toContain('  review/disabled: off')
    expect(io.stderrText).toBe('')
  })

  it('prints inferred language for config inspect when language is unset', async () => {
    const io = await createTestIo()
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    name: 'all files',
    files: ['**/*.txt'],
    rules: {
      'review/file': 'warn',
    },
  },
]
`)

    const code = await executeCli([
      'node',
      'alint',
      'config',
      'inspect',
      'notes.txt',
    ], io)

    expect(code).toBe(0)
    expect(io.stdoutText).toContain('file: notes.txt')
    expect(io.stdoutText).toContain('  - all files')
    expect(io.stdoutText).toContain('language: <inferred>')
    expect(io.stderrText).toBe('')
  })

  it('inspects directory config using the directory target matcher', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'crates/auv-cli-invoke'), { recursive: true })
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    name: 'component architecture',
    directories: ['crates/*'],
    rules: {
      'review/component': 'warn',
    },
  },
  {
    name: 'manifest files',
    files: ['**/Cargo.toml'],
    rules: {
      'review/manifest': 'warn',
    },
  },
]
`)

    const code = await executeCli([
      'node',
      'alint',
      'config',
      'inspect',
      'crates/auv-cli-invoke',
    ], io)

    expect(code).toBe(0)
    expect(io.stdoutText).toContain('directory: crates/auv-cli-invoke')
    expect(io.stdoutText).toContain('  - component architecture')
    expect(io.stdoutText).toContain('  review/component: warn')
    expect(io.stdoutText).not.toContain('manifest files')
    expect(io.stdoutText).not.toContain('review/manifest')
  })

  it('uses global custom config for config inspect', async () => {
    const io = await createTestIo()
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    name: 'default config',
    files: ['**/*.go'],
    language: 'plaintext',
    rules: {
      'default/file': 'warn',
    },
  },
]
`)
    await writeFile(join(io.cwd, 'custom.config.ts'), `
export default [
  {
    name: 'custom config',
    files: ['**/*.go'],
    language: 'markdown',
    rules: {
      'custom/file': 'error',
    },
  },
]
`)

    const code = await executeCli([
      'node',
      'alint',
      '--config',
      'custom.config.ts',
      'config',
      'inspect',
      'main.go',
    ], io)

    expect(code).toBe(0)
    expect(io.stdoutText).toContain('  - custom config')
    expect(io.stdoutText).toContain('language: markdown')
    expect(io.stdoutText).toContain('  custom/file: error')
    expect(io.stdoutText).not.toContain('default config')
    expect(io.stdoutText).not.toContain('default/file')
    expect(io.stderrText).toBe('')
  })

  it('uses the -c alias as the global custom config option', async () => {
    const io = await createTestIo()
    await writeFile(join(io.cwd, 'custom.config.ts'), `
export default [
  {
    name: 'custom config',
    files: ['**/*.go'],
    language: 'markdown',
    rules: {
      'custom/file': 'error',
    },
  },
]
`)

    const code = await executeCli([
      'node',
      'alint',
      '-c',
      'custom.config.ts',
      'config',
      'inspect',
      'main.go',
    ], io)

    expect(code).toBe(0)
    expect(io.stdoutText).toContain('  - custom config')
    expect(io.stdoutText).toContain('language: markdown')
    expect(io.stdoutText).toContain('  custom/file: error')
    expect(io.stderrText).toBe('')
  })

  it('prints help and returns 0', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli(['node', 'alint', '--help'], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('alint')
    expect(io.stdoutText).toContain('Examples:')
    expect(io.stdoutText).toContain('alint setup')
    expect(io.stdoutText).toContain('alint src')
    expect(io.stdoutText).toContain('alint --format json src > alint-output.json')
    expect(io.stdoutText).toContain('alint output inspect alint-output.json')
    expect(io.stdoutText).toContain('alint config inspect src/index.ts')
    expect(io.stdoutText).toContain('--no-cache')
    expect(io.stdoutText).toContain('-l, --lang <language>')
    expect(io.stdoutText).not.toMatch(/(^|\n)\s*--cache(?:\s|,)/)
    expect(io.stdoutText).not.toContain('-L')
    expect(io.stdoutText).not.toContain('--output-language')
  })

  it('prints setup examples in setup help', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli(['node', 'alint', 'setup', '--help'], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('Examples:')
    expect(io.stdoutText).toContain('alint setup')
    expect(io.stdoutText).toContain('alint setup --local -N --provider-id openrouter')
    expect(io.stdoutText).toContain('--provider-model z-ai/glm-5.2')
    expect(io.stdoutText).toContain('--provider-header "Authorization=Bearer $OPENROUTER_API_KEY"')
    expect(io.stderrText).toBe('')
  })

  it('returns 2 when non-interactive setup is missing provider endpoint', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli([
      'node',
      'alint',
      'setup',
      '-N',
      '--local',
      '--provider-model',
      'qwen:8b',
    ], io)

    expect(exitCode).toBe(2)
    expect(io.stderrText).toBe('setup requires --provider-endpoint in --no-interactive mode.\n')
  })

  it('returns 2 when non-interactive setup is missing provider id', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli([
      'node',
      'alint',
      'setup',
      '-N',
      '--local',
      '--provider-endpoint',
      'http://localhost:11434/v1',
      '--provider-model',
      'qwen:8b',
    ], io)

    expect(exitCode).toBe(2)
    expect(io.stderrText).toBe('setup requires --provider-id in --no-interactive mode.\n')
  })

  it('returns 2 when interactive setup is requested without a TTY', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli([
      'node',
      'alint',
      'setup',
    ], io)

    expect(exitCode).toBe(2)
    expect(io.stderrText).toBe('interactive setup requires a TTY. Use -N/--no-interactive with --provider-id and --provider-endpoint.\n')
  })

  it('formats warning diagnostics for the default run command and returns 0', async () => {
    const io = await createTestIo()

    await writeFile(join(io.cwd, 'demo.ts'), [
      'export function load() {',
      '  return 1',
      '}',
      '',
    ].join('\n'))

    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    plugins: {
      company: {
        rules: {
        'prefer-load': {
          languages: 'any',
          create: (ctx) => ({
            onTargetFunction: async (target) => {
              ctx.report({
                filePath: target.file.path,
                message: 'Problem found',
                loc: target.loc,
              })
            },
          }),
        },
      },
    },
    },
    rules: {
      'company/prefer-load': 'warn',
    },
  },
]
`)

    const exitCode = await executeCli([
      'node',
      'alint',
      'demo.ts',
    ], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('Problem found')
    expect(io.stdoutText).toContain('company/prefer-load')
  })

  it('returns 1 when the default run command reports an error diagnostic', async () => {
    const io = await createTestIo()

    await writeFile(join(io.cwd, 'demo.ts'), [
      'export function load() {',
      '  return 1',
      '}',
      '',
    ].join('\n'))

    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    plugins: {
      company: {
        rules: {
          'prefer-load': {
            languages: 'any',
            create: (ctx) => ({
              onTargetFunction: async (target) => {
                ctx.report({
                  filePath: target.file.path,
                  message: 'Problem found',
                  loc: target.loc,
                })
              },
            }),
          },
        },
      },
    },
    rules: {
      'company/prefer-load': 'error',
    },
  },
]
`)

    const exitCode = await executeCli(['node', 'alint', 'demo.ts'], io)

    expect(exitCode).toBe(1)
    expect(io.stdoutText).toContain('Problem found')
    expect(io.stdoutText).toContain('company/prefer-load')
  })

  it('returns 2 when a positional file path does not exist', async () => {
    const io = await createTestIo()

    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    rules: {},
  },
]
`)

    const exitCode = await executeCli([
      'node',
      'alint',
      'missing.ts',
    ], io)

    expect(exitCode).toBe(2)
    expect(io.stderrText).toBe('No files matching "missing.ts" were found.\n')
    expect(io.stdoutText).toBe('')
  })

  it('returns 2 when a positional file path traverses through a file', async () => {
    const io = await createTestIo()

    await writeFile(join(io.cwd, 'package.json'), '{}\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    rules: {},
  },
]
`)

    const exitCode = await executeCli([
      'node',
      'alint',
      'package.json/missing.ts',
    ], io)

    expect(exitCode).toBe(2)
    expect(io.stderrText).toBe('No files matching "package.json/missing.ts" were found.\n')
    expect(io.stdoutText).toBe('')
  })

  it('discovers files from flat config files patterns when no positional files are passed', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'src'), { recursive: true })
    await writeFile(join(io.cwd, 'src/main.go'), 'package main\n')
    await writeFile(join(io.cwd, 'README.md'), '# demo\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    files: ['src/**/*.go'],
    language: 'plaintext',
    plugins: {
      review: {
        rules: {
          file: {
            create: ctx => ({
              onTargetFile: target => ctx.report({
                filePath: target.file.path,
                message: 'checked ' + target.language,
              }),
            }),
          },
        },
      },
    },
    rules: {
      'review/file': 'warn',
    },
  },
]
`)

    const code = await executeCli(['node', 'alint'], io)

    expect(code).toBe(0)
    expect(io.stdoutText).toContain('checked plaintext')
    expect(io.stdoutText).toContain('src/main.go')
    expect(io.stdoutText).not.toContain('README.md')
  })

  it('returns 0 without walking directories when config has no files patterns', async () => {
    const io = await createTestIo()
    const blockedDir = join(io.cwd, 'blocked')
    await mkdir(blockedDir)
    await writeFile(join(blockedDir, 'demo.ts'), 'export const visited = true\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    plugins: {
      review: {
        rules: {
          file: {
            create: ctx => ({
              onTargetFile: target => ctx.report({
                filePath: target.file.path,
                message: 'visited ' + target.file.path,
              }),
            }),
          },
        },
      },
    },
    rules: {
      'review/file': 'warn',
    },
  },
]
`)
    let blockedDirLocked = false

    try {
      await chmod(blockedDir, 0o000)
      blockedDirLocked = true

      const code = await executeCli(['node', 'alint'], io)

      expect(code).toBe(0)
      expect(io.stdoutText).toBe('')
      expect(io.stderrText).toBe('')
    }
    finally {
      if (blockedDirLocked) {
        await chmod(blockedDir, 0o700)
      }
    }
  })

  it('expands positional directories using flat config files patterns', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'src'), { recursive: true })
    await writeFile(join(io.cwd, 'src/main.go'), 'package main\n')
    await writeFile(join(io.cwd, 'src/README.md'), '# demo\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    files: ['src/**/*.go'],
    language: 'plaintext',
    plugins: {
      review: {
        rules: {
          file: {
            create: ctx => ({
              onTargetFile: target => ctx.report({
                filePath: target.file.path,
                message: 'checked ' + target.language,
              }),
            }),
          },
        },
      },
    },
    rules: {
      'review/file': 'warn',
    },
  },
]
`)

    const code = await executeCli(['node', 'alint', 'src'], io)

    expect(code).toBe(0)
    expect(io.stdoutText).toContain('checked plaintext')
    expect(io.stdoutText).toContain('src/main.go')
    expect(io.stdoutText).not.toContain('src/README.md')
  })

  it('passes an explicit directory to directory rules without requiring files', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'crates/auv-cli-invoke'), { recursive: true })
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    directories: ['crates/*'],
    plugins: {
      review: {
        rules: {
          component: {
            create: ctx => ({
              onTargetDirectory: target => ctx.report({
                filePath: target.path,
                message: 'checked component directory',
              }),
            }),
          },
        },
      },
    },
    rules: {
      'review/component': 'warn',
    },
  },
]
`)

    const code = await executeCli(['node', 'alint', 'crates/auv-cli-invoke'], io)

    expect(code).toBe(0)
    expect(io.stdoutText).toContain('checked component directory')
    expect(io.stdoutText).toContain('crates/auv-cli-invoke')
  })

  it('expands positional glob patterns using config files patterns', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'src/nested'), { recursive: true })
    await writeFile(join(io.cwd, 'src/main.ts'), 'export const main = 1\n')
    await writeFile(join(io.cwd, 'src/nested/feature.ts'), 'export const feature = 1\n')
    await writeFile(join(io.cwd, 'src/nested/feature.test.ts'), 'export const test = 1\n')
    await writeFile(join(io.cwd, 'src/readme.md'), '# demo\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    language: 'plaintext',
    plugins: {
      review: {
        rules: {
          file: {
            create: ctx => ({
              onTargetFile: target => ctx.report({
                filePath: target.file.path,
                message: 'visited ' + target.file.path,
              }),
            }),
          },
        },
      },
    },
    rules: {
      'review/file': 'warn',
    },
  },
  {
    files: [['src/**/*.ts', '!src/**/*.test.ts']],
  },
]
`)

    const code = await executeCli(['node', 'alint', '--format', 'json', 'src/**/*.ts'], io)
    const diagnostics = JSON.parse(io.stdoutText).diagnostics

    expect(code).toBe(0)
    expect(diagnostics.map((diagnostic: { filePath: string }) => diagnostic.filePath).sort()).toEqual([
      join(io.cwd, 'src/main.ts'),
      join(io.cwd, 'src/nested/feature.ts'),
    ])
  })

  it('expands absolute positional glob patterns using config files patterns', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'src'), { recursive: true })
    await writeFile(join(io.cwd, 'src/main.ts'), 'export const main = 1\n')
    await writeFile(join(io.cwd, 'src/main.test.ts'), 'export const test = 1\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    language: 'plaintext',
    plugins: {
      review: {
        rules: {
          file: {
            create: ctx => ({
              onTargetFile: target => ctx.report({
                filePath: target.file.path,
                message: 'visited ' + target.file.path,
              }),
            }),
          },
        },
      },
    },
    rules: {
      'review/file': 'warn',
    },
  },
  {
    files: [['src/**/*.ts', '!src/**/*.test.ts']],
  },
]
`)

    const code = await executeCli(['node', 'alint', '--format', 'json', join(io.cwd, 'src/**/*.ts')], io)
    const diagnostics = JSON.parse(io.stdoutText).diagnostics

    expect(code).toBe(0)
    expect(diagnostics.map((diagnostic: { filePath: string }) => diagnostic.filePath)).toEqual([
      join(io.cwd, 'src/main.ts'),
    ])
  })

  it('expands positional glob patterns when config has no files patterns', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'src'), { recursive: true })
    await writeFile(join(io.cwd, 'src', 'demo.ts'), 'export const demo = 1\n')
    await writeFile(join(io.cwd, 'README.md'), '# demo\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    language: 'plaintext',
    plugins: {
      review: {
        rules: {
          file: {
            create: ctx => ({
              onTargetFile: target => ctx.report({
                filePath: target.file.path,
                message: 'visited ' + target.file.path,
              }),
            }),
          },
        },
      },
    },
    rules: {
      'review/file': 'warn',
    },
  },
]
`)

    const code = await executeCli(['node', 'alint', '--format', 'json', 'src/*.ts'], io)
    const diagnostics = JSON.parse(io.stdoutText).diagnostics

    expect(code).toBe(0)
    expect(diagnostics.map((diagnostic: { filePath: string }) => diagnostic.filePath)).toEqual([
      join(io.cwd, 'src', 'demo.ts'),
    ])
  })

  it('returns 2 when a positional glob pattern has no matches', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'src'), { recursive: true })
    await writeFile(join(io.cwd, 'src/main.ts'), 'export const main = 1\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    files: ['src/**/*.ts'],
    rules: {},
  },
]
`)

    const exitCode = await executeCli([
      'node',
      'alint',
      'src/**/*.missing.ts',
    ], io)

    expect(exitCode).toBe(2)
    expect(io.stderrText).toBe('No files matching "src/**/*.missing.ts" were found.\n')
    expect(io.stdoutText).toBe('')
  })

  it('preserves explicit file order and dedupes directory and glob results', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'src'), { recursive: true })
    await writeFile(join(io.cwd, 'first.ts'), 'export const first = 1\n')
    await writeFile(join(io.cwd, 'src/second.ts'), 'export const second = 1\n')
    await writeFile(join(io.cwd, 'src/third.ts'), 'export const third = 1\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    language: 'plaintext',
    plugins: {
      review: {
        rules: {
          file: {
            create: ctx => ({
              onTargetFile: target => ctx.report({
                filePath: target.file.path,
                message: 'visited ' + target.file.path,
              }),
            }),
          },
        },
      },
    },
    rules: {
      'review/file': 'warn',
    },
  },
]
`)

    const code = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'first.ts',
      'src',
      'src/**/*.ts',
    ], io)
    const diagnostics = JSON.parse(io.stdoutText).diagnostics

    expect(code).toBe(0)
    expect(diagnostics.map((diagnostic: { filePath: string }) => diagnostic.filePath)).toEqual([
      join(io.cwd, 'first.ts'),
      join(io.cwd, 'src/second.ts'),
      join(io.cwd, 'src/third.ts'),
    ])
  })

  it('passes --lang to rule context', async () => {
    const io = await createTestIo()
    await writeOutputLanguageFixture(io.cwd)

    const code = await executeCli([
      'node',
      'alint',
      '--lang',
      '日本語',
      'demo.ts',
    ], io)

    expect(code).toBe(0)
    expect(io.stdoutText).toContain('answer in 日本語')
  })

  it('passes short language flag to rule context', async () => {
    const io = await createTestIo()
    await writeOutputLanguageFixture(io.cwd)

    const code = await executeCli([
      'node',
      'alint',
      '-l',
      'English',
      'demo.ts',
    ], io)

    expect(code).toBe(0)
    expect(io.stdoutText).toContain('answer in English')
  })

  it('discovers files from nested AND files patterns when no positional files are passed', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'src'), { recursive: true })
    await writeFile(join(io.cwd, 'src/main.ts'), 'export const main = 1\n')
    await writeFile(join(io.cwd, 'src/main.test.ts'), 'export const test = 1\n')
    await writeFile(join(io.cwd, 'main.test.ts'), 'export const rootTest = 1\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    language: 'plaintext',
    plugins: {
      review: {
        rules: {
          file: {
            create: ctx => ({
              onTargetFile: target => ctx.report({
                filePath: target.file.path,
                message: 'visited ' + target.file.path,
              }),
            }),
          },
        },
      },
    },
    rules: {
      'review/file': 'warn',
    },
  },
  {
    files: [['src/**/*.ts', '**/*.test.ts']],
  },
]
`)

    const code = await executeCli(['node', 'alint', '--format', 'json'], io)
    const diagnostics = JSON.parse(io.stdoutText).diagnostics

    expect(code).toBe(0)
    expect(diagnostics.map((diagnostic: { filePath: string }) => diagnostic.filePath).sort()).toEqual([
      join(io.cwd, 'src/main.test.ts'),
    ])
  })

  it('discovers files from basePath config files patterns when no positional files are passed', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'packages/core/src'), { recursive: true })
    await mkdir(join(io.cwd, 'packages/cli/src'), { recursive: true })
    await writeFile(join(io.cwd, 'packages/core/src/demo.ts'), 'export const core = 1\n')
    await writeFile(join(io.cwd, 'packages/cli/src/demo.ts'), 'export const cli = 1\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    basePath: 'packages/core',
    files: ['src/**/*.ts'],
    language: 'plaintext',
    plugins: {
      review: {
        rules: {
          file: {
            create: ctx => ({
              onTargetFile: target => ctx.report({
                filePath: target.file.path,
                message: 'visited ' + target.file.path,
              }),
            }),
          },
        },
      },
    },
    rules: {
      'review/file': 'warn',
    },
  },
]
`)

    const code = await executeCli(['node', 'alint', '--format', 'json'], io)
    const diagnostics = JSON.parse(io.stdoutText).diagnostics

    expect(code).toBe(0)
    expect(diagnostics.map((diagnostic: { filePath: string }) => diagnostic.filePath)).toEqual([
      join(io.cwd, 'packages/core/src/demo.ts'),
    ])
  })

  it('discovers files from inline extends files patterns when no positional files are passed', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'generated'), { recursive: true })
    await writeFile(join(io.cwd, 'generated/demo.txt'), 'generated\n')
    await writeFile(join(io.cwd, 'manual.txt'), 'manual\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    extends: [
      {
        files: ['generated/**/*.txt'],
      },
    ],
    language: 'plaintext',
    plugins: {
      review: {
        rules: {
          file: {
            create: ctx => ({
              onTargetFile: target => ctx.report({
                filePath: target.file.path,
                message: 'visited ' + target.file.path,
              }),
            }),
          },
        },
      },
    },
    rules: {
      'review/file': 'warn',
    },
  },
]
`)

    const code = await executeCli(['node', 'alint', '--format', 'json'], io)
    const diagnostics = JSON.parse(io.stdoutText).diagnostics

    expect(code).toBe(0)
    expect(diagnostics.map((diagnostic: { filePath: string }) => diagnostic.filePath)).toEqual([
      join(io.cwd, 'generated/demo.txt'),
    ])
  })

  it('discovers files from plugin extends inherited matcher scopes when no positional files are passed', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'src'), { recursive: true })
    await writeFile(join(io.cwd, 'src/main.go'), 'package main\n')
    await writeFile(join(io.cwd, 'main.go'), 'package main\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
const review = {
  configs: {
    recommended: [
      {
        language: 'plaintext',
        rules: {
          'review/file': 'warn',
        },
      },
    ],
  },
  rules: {
    file: {
      create: ctx => ({
        onTargetFile: target => ctx.report({
          filePath: target.file.path,
          message: 'visited ' + target.file.path,
        }),
      }),
    },
  },
}

export default [
  {
    extends: ['review/recommended'],
    files: ['src/**/*.go'],
    plugins: { review },
  },
]
`)

    const code = await executeCli(['node', 'alint', '--format', 'json'], io)
    const diagnostics = JSON.parse(io.stdoutText).diagnostics

    expect(code).toBe(0)
    expect(diagnostics.map((diagnostic: { filePath: string }) => diagnostic.filePath)).toEqual([
      join(io.cwd, 'src/main.go'),
    ])
  })

  it('discovers files from nested AND files patterns with negated entries', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'src'), { recursive: true })
    await writeFile(join(io.cwd, 'src/demo.ts'), 'export const demo = 1\n')
    await writeFile(join(io.cwd, 'src/demo.test.ts'), 'export const test = 1\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    language: 'plaintext',
    plugins: {
      review: {
        rules: {
          file: {
            create: ctx => ({
              onTargetFile: target => ctx.report({
                filePath: target.file.path,
                message: 'visited ' + target.file.path,
              }),
            }),
          },
        },
      },
    },
    rules: {
      'review/file': 'warn',
    },
  },
  {
    files: [['src/**/*.ts', '!src/**/*.test.ts']],
  },
]
`)

    const code = await executeCli(['node', 'alint', '--format', 'json'], io)
    const diagnostics = JSON.parse(io.stdoutText).diagnostics

    expect(code).toBe(0)
    expect(diagnostics.map((diagnostic: { filePath: string }) => diagnostic.filePath)).toEqual([
      join(io.cwd, 'src/demo.ts'),
    ])
  })

  it('does not discover files under ignored directories when no positional files are passed', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'src'), { recursive: true })
    await mkdir(join(io.cwd, 'ignored'), { recursive: true })
    await mkdir(join(io.cwd, 'gitignored'), { recursive: true })
    await mkdir(join(io.cwd, 'node_modules/pkg'), { recursive: true })
    await writeFile(join(io.cwd, '.gitignore'), 'gitignored/\n')
    await writeFile(join(io.cwd, 'src/demo.txt'), 'demo\n')
    await writeFile(join(io.cwd, 'ignored/demo.txt'), 'ignored\n')
    await writeFile(join(io.cwd, 'gitignored/demo.txt'), 'gitignored\n')
    await writeFile(join(io.cwd, 'node_modules/pkg/demo.txt'), 'dependency\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    ignores: ['ignored/**', 'node_modules/**'],
  },
  {
    ignore: {
      gitignore: true,
    },
  },
  {
    files: ['**/*.txt'],
    language: 'plaintext',
    plugins: {
      review: {
        rules: {
          file: {
            create: ctx => ({
              onTargetFile: target => ctx.report({
                filePath: target.file.path,
                message: 'visited ' + target.file.path,
              }),
            }),
          },
        },
      },
    },
    rules: {
      'review/file': 'warn',
    },
  },
]
`)

    const code = await executeCli(['node', 'alint', '--format', 'json'], io)
    const diagnostics = JSON.parse(io.stdoutText).diagnostics

    expect(code).toBe(0)
    expect(diagnostics.map((diagnostic: { filePath: string }) => diagnostic.filePath)).toEqual([
      join(io.cwd, 'src/demo.txt'),
    ])
  })

  it('prunes ignored directories for positional directory inputs', async () => {
    const io = await createTestIo()
    const ignoredDir = join(io.cwd, 'src/ignored')
    const gitignoredDir = join(io.cwd, 'src/gitignored')
    await mkdir(join(io.cwd, 'src'), { recursive: true })
    await mkdir(ignoredDir, { recursive: true })
    await mkdir(gitignoredDir, { recursive: true })
    await writeFile(join(io.cwd, '.gitignore'), 'src/gitignored/\n')
    await writeFile(join(io.cwd, 'src/demo.txt'), 'demo\n')
    await writeFile(join(ignoredDir, 'demo.txt'), 'ignored\n')
    await writeFile(join(gitignoredDir, 'demo.txt'), 'gitignored\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    ignores: ['src/ignored/**'],
  },
  {
    ignore: {
      gitignore: true,
    },
  },
  {
    files: ['src/**/*.txt'],
    language: 'plaintext',
    plugins: {
      review: {
        rules: {
          file: {
            create: ctx => ({
              onTargetFile: target => ctx.report({
                filePath: target.file.path,
                message: 'visited ' + target.file.path,
              }),
            }),
          },
        },
      },
    },
    rules: {
      'review/file': 'warn',
    },
  },
]
`)
    let ignoredDirLocked = false
    let gitignoredDirLocked = false

    try {
      await chmod(ignoredDir, 0o000)
      ignoredDirLocked = true
      await chmod(gitignoredDir, 0o000)
      gitignoredDirLocked = true

      const code = await executeCli(['node', 'alint', '--format', 'json', 'src'], io)
      const diagnostics = JSON.parse(io.stdoutText).diagnostics

      expect(code).toBe(0)
      expect(diagnostics.map((diagnostic: { filePath: string }) => diagnostic.filePath)).toEqual([
        join(io.cwd, 'src/demo.txt'),
      ])
    }
    finally {
      if (ignoredDirLocked) {
        await chmod(ignoredDir, 0o700)
      }
      if (gitignoredDirLocked) {
        await chmod(gitignoredDir, 0o700)
      }
    }
  })

  it('prunes ignored positional directory roots before reading them', async () => {
    const io = await createTestIo()
    const ignoredDir = join(io.cwd, 'ignored')
    const gitignoredDir = join(io.cwd, 'gitignored')
    await mkdir(ignoredDir)
    await mkdir(gitignoredDir)
    await writeFile(join(ignoredDir, 'demo.txt'), 'ignored\n')
    await writeFile(join(gitignoredDir, 'demo.txt'), 'gitignored\n')
    await writeFile(join(io.cwd, '.gitignore'), 'gitignored/\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    ignores: ['ignored/**'],
  },
  {
    ignore: {
      gitignore: true,
    },
  },
  {
    files: ['**/*.txt'],
    rules: {},
  },
]
`)
    let ignoredDirLocked = false
    let gitignoredDirLocked = false

    try {
      await chmod(ignoredDir, 0o000)
      ignoredDirLocked = true
      await chmod(gitignoredDir, 0o000)
      gitignoredDirLocked = true

      const code = await executeCli(['node', 'alint', 'ignored', 'gitignored'], io)

      expect(code).toBe(0)
      expect(io.stdoutText).toBe('')
      expect(io.stderrText).toBe('')
    }
    finally {
      if (ignoredDirLocked) {
        await chmod(ignoredDir, 0o700)
      }
      if (gitignoredDirLocked) {
        await chmod(gitignoredDir, 0o700)
      }
    }
  })

  it('discovers explicitly configured files under node_modules when not ignored', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'node_modules/pkg'), { recursive: true })
    await writeFile(join(io.cwd, 'node_modules/pkg/demo.txt'), 'dependency\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    files: ['node_modules/pkg/**/*.txt'],
    language: 'plaintext',
    plugins: {
      review: {
        rules: {
          file: {
            create: ctx => ({
              onTargetFile: target => ctx.report({
                filePath: target.file.path,
                message: 'visited ' + target.file.path,
              }),
            }),
          },
        },
      },
    },
    rules: {
      'review/file': 'warn',
    },
  },
]
`)

    const code = await executeCli(['node', 'alint', '--format', 'json'], io)
    const diagnostics = JSON.parse(io.stdoutText).diagnostics

    expect(code).toBe(0)
    expect(diagnostics.map((diagnostic: { filePath: string }) => diagnostic.filePath)).toEqual([
      join(io.cwd, 'node_modules/pkg/demo.txt'),
    ])
  })

  it('lints gitignored positional files when gitignore filtering is not enabled', async () => {
    const io = await createTestIo()

    await mkdir(join(io.cwd, 'src'), { recursive: true })
    await writeFile(join(io.cwd, 'src/.gitignore'), 'generated.ts\n')
    await writeFile(join(io.cwd, 'src/included.ts'), 'export const included = 1\n')
    await writeFile(join(io.cwd, 'src/generated.ts'), 'export const generated = 1\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    plugins: {
      company: {
        rules: {
        'visit-file': {
          create: (ctx) => ({
            onTargetFile: async (target) => {
              ctx.report({
                filePath: target.file.path,
                message: 'visited ' + target.file.path,
              })
            },
          }),
        },
      },
    },
    },
    rules: {
      'company/visit-file': 'warn',
    },
  },
]
`)

    const exitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'src/included.ts',
      'src/generated.ts',
    ], io)

    const diagnostics = JSON.parse(io.stdoutText).diagnostics

    expect(exitCode).toBe(0)
    expect(diagnostics.map((diagnostic: { filePath: string }) => diagnostic.filePath).sort()).toEqual([
      join(io.cwd, 'src/generated.ts'),
      join(io.cwd, 'src/included.ts'),
    ])
  })

  it('skips gitignored positional files when gitignore filtering is enabled', async () => {
    const io = await createTestIo()

    await mkdir(join(io.cwd, 'src'), { recursive: true })
    await writeFile(join(io.cwd, 'src/.gitignore'), 'generated.ts\n')
    await writeFile(join(io.cwd, 'src/included.ts'), 'export const included = 1\n')
    await writeFile(join(io.cwd, 'src/generated.ts'), 'export const generated = 1\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    ignore: {
      gitignore: true,
    },
  },
  {
    files: ['**/*.ts'],
    plugins: {
      company: {
        rules: {
        'visit-file': {
          create: (ctx) => ({
            onTargetFile: async (target) => {
              ctx.report({
                filePath: target.file.path,
                message: 'visited ' + target.file.path,
              })
            },
          }),
        },
      },
    },
    },
    rules: {
      'company/visit-file': 'warn',
    },
  },
]
`)

    const exitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'src/included.ts',
      'src/generated.ts',
    ], io)

    const diagnostics = JSON.parse(io.stdoutText).diagnostics

    expect(exitCode).toBe(0)
    expect(diagnostics.map((diagnostic: { filePath: string }) => diagnostic.filePath)).toEqual([
      join(io.cwd, 'src/included.ts'),
    ])
  })

  it('does not let rule console output corrupt json reporter stdout', async () => {
    const io = await createTestIo()

    await writeFile(join(io.cwd, 'demo.ts'), 'export function load() {}\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    plugins: {
      company: {
        rules: {
        'noisy': {
          languages: 'any',
          create: (ctx) => ({
            onTargetFunction: async (target) => {
              console.debug('debug noise')
              console.dir({ dir: 'noise' })
              console.info('info noise')
              console.log('log noise')
              ctx.report({
                filePath: target.file.path,
                message: 'Problem found',
              })
            },
          }),
        },
      },
    },
    },
    rules: {
      'company/noisy': 'warn',
    },
  },
]
`)

    const exitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'demo.ts',
    ], io)

    expect(exitCode).toBe(0)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('Problem found')
    expect(io.stdoutText).not.toContain('debug noise')
    expect(io.stdoutText).not.toContain('dir')
    expect(io.stdoutText).not.toContain('info noise')
    expect(io.stdoutText).not.toContain('log noise')
    expect(io.stderrText).toContain('debug noise')
    expect(io.stderrText).toContain('dir')
    expect(io.stderrText).toContain('info noise')
    expect(io.stderrText).toContain('log noise')
  })

  it('keeps json stdout clean when progress is not explicitly enabled', async () => {
    const io = await createTestIo()

    await writeProgressFixture(io.cwd)

    const exitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'demo.ts',
    ], io)

    expect(exitCode).toBe(0)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('Problem found')
    expect(io.stderrText).toBe('')
  })

  it('writes plain progress to stderr when --progress is explicit in non-tty mode', async () => {
    const io = await createTestIo()

    await writeProgressFixture(io.cwd)

    const exitCode = await executeCli([
      'node',
      'alint',
      '--progress',
      'demo.ts',
    ], io)

    expect(exitCode).toBe(0)
    expect(io.stderrText).toContain('alint preparing')
    expect(io.stderrText).toContain('alint prepared: 1 files')
    expect(io.stderrText).toContain('scan ')
    expect(io.stderrText).toContain('alint finished')
    expect(io.stdoutText).toContain('Problem found')
    expect(io.stdoutText).toContain('company/prefer-load')
  })

  it('threads stderr rows into bounded TTY progress rendering', async () => {
    const io = await createTestIo()
    io.stderr.columns = 120
    io.stderr.isTTY = true
    io.stderr.rows = 1

    await writeProgressFixture(io.cwd)

    const exitCode = await executeCli([
      'node',
      'alint',
      '--progress',
      'demo.ts',
    ], io)

    expect(exitCode).toBe(0)
    expect(io.stderrText).toContain('/')
    expect(io.stderrText).toContain('->')
    expect(io.stderrText).not.toContain('\n')
    expect(io.stderrText).not.toContain('company/prefer-load')
  })

  it('runs the real scheduler, bounded TTY progress, and aggregate failure path in one invocation', async () => {
    const io = await createTestIo()
    io.stderr.columns = 120
    io.stderr.isTTY = true
    io.stderr.rows = 4
    const callKey = `__alintConcurrentCliFixture_${io.cwd}`
    const state = { active: 0, maxActive: 0 }
    ;(globalThis as Record<string, unknown>)[callKey] = state

    try {
      await writeRuleConcurrencyFailureFixture(io.cwd, callKey)

      const exitCode = await executeCli([
        'node',
        'alint',
        '--rule-concurrency',
        '3',
        '--progress',
        'demo.ts',
      ], io)

      expect(state.maxActive).toBe(3)
      const frames = io.stderrText.split(/\r\u001B\[K(?:\r\u001B\[1A\u001B\[K)*/u)
      expect(frames.some(frame =>
        frame.includes('3 more running') && frame.includes('3 concurrency'),
      )).toBe(true)
      expect(io.stderrText).toContain('[handler]')
      expect(exitCode).toBe(2)
    }
    finally {
      delete (globalThis as Record<string, unknown>)[callKey]
    }
  })

  it('does not create progress output when --no-progress is explicit', async () => {
    const io = await createTestIo()
    io.stderr.isTTY = true

    await writeProgressFixture(io.cwd)

    const exitCode = await executeCli([
      'node',
      'alint',
      '--no-progress',
      'demo.ts',
    ], io)

    expect(exitCode).toBe(0)
    expect(io.stderrText).toBe('')
    expect(io.stdoutText).toContain('Problem found')
  })

  it('rejects the removed per-file concurrency option', async () => {
    const io = await createTestIo()

    await writeProgressFixture(io.cwd)

    const removedOption = `--${['file', 'concurrency'].join('-')}`

    await expect(executeCli([
      'node',
      'alint',
      removedOption,
      '2',
      'demo.ts',
    ], io)).rejects.toThrow('Unknown option')
  })

  it('passes CLI rule concurrency to the core run', async () => {
    const io = await createTestIo()
    const runAlint = vi.spyOn(alintCore, 'runAlint')

    try {
      await writeProgressFixture(io.cwd)

      await executeCli([
        'node',
        'alint',
        '--rule-concurrency',
        '6',
        'demo.ts',
      ], io)

      expect(runAlint).toHaveBeenCalledWith(expect.objectContaining({
        runner: { ruleConcurrency: 6 },
      }))
    }
    finally {
      runAlint.mockRestore()
    }
  })

  it('passes the CLI runtime cancellation signal to the core run', async () => {
    const io = await createTestIo()
    const runAlint = vi.spyOn(alintCore, 'runAlint')
    const controller = new AbortController()

    try {
      await writeProgressFixture(io.cwd)

      await executeCli([
        'node',
        'alint',
        'demo.ts',
      ], io, { signal: controller.signal })

      expect(runAlint).toHaveBeenCalledWith(expect.objectContaining({
        signal: controller.signal,
      }))
    }
    finally {
      runAlint.mockRestore()
    }
  })

  it('passes the system default separately from an explicit model override', async () => {
    const io = await createTestIo()
    const runAlint = vi.spyOn(alintCore, 'runAlint')

    try {
      await writeProgressFixture(io.cwd)

      await executeCli([
        'node',
        'alint',
        'demo.ts',
      ], io)

      expect(runAlint).toHaveBeenLastCalledWith(expect.objectContaining({
        defaultModel: 'default',
        modelOverride: undefined,
      }))

      await executeCli([
        'node',
        'alint',
        '--model',
        'override',
        'demo.ts',
      ], io)

      expect(runAlint).toHaveBeenLastCalledWith(expect.objectContaining({
        defaultModel: 'default',
        modelOverride: 'override',
      }))
    }
    finally {
      runAlint.mockRestore()
    }
  })

  it('writes the default cache and reuses it on the next run', async () => {
    const io = await createTestIo()

    await writeCacheFixture(io.cwd)

    const firstExitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'demo.ts',
    ], io)

    expect(firstExitCode).toBe(0)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked 1')
    await expect(readFile(join(io.cwd, '.alintcache'), 'utf8')).resolves.toContain('"entries"')

    io.stdoutText = ''
    io.stderrText = ''
    const secondExitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'demo.ts',
    ], io)

    expect(secondExitCode).toBe(0)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked 1')
  })

  it('reports nothing and writes no cache when --cache-only misses', async () => {
    const io = await createTestIo()

    await writeCacheFixture(io.cwd)

    const exitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      '--cache-only',
      'demo.ts',
    ], io)

    expect(exitCode).toBe(0)
    const result = JSON.parse(io.stdoutText)
    expect(result.diagnostics).toEqual([])
    expect(result.execution.skipped).toBeGreaterThanOrEqual(1)
    // cacheOnly is read-only: a cold run must call no model and leave no cache file behind.
    await expect(readFile(join(io.cwd, '.alintcache'), 'utf8')).rejects.toThrow()
  })

  it('replays cached diagnostics under --cache-only without re-running the rule', async () => {
    const io = await createTestIo()

    await writeCacheFixture(io.cwd)

    // Warm the cache with a normal run; the rule increments its call counter to 1.
    const warmExitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'demo.ts',
    ], io)

    expect(warmExitCode).toBe(0)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked 1')

    io.stdoutText = ''
    io.stderrText = ''
    const exitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      '--cache-only',
      'demo.ts',
    ], io)

    expect(exitCode).toBe(0)
    const result = JSON.parse(io.stdoutText)
    // Still "checked 1", not "checked 2": the diagnostic was replayed, the rule never re-ran.
    expect(result.diagnostics[0].message).toBe('checked 1')
    expect(result.diagnostics[0].cached).toBe(true)
    expect(result.execution.cached).toBeGreaterThanOrEqual(1)
  })

  it('writes and reads the requested cache location', async () => {
    const io = await createTestIo()
    const cachePath = join(io.cwd, 'custom-cache.json')

    await writeCacheFixture(io.cwd)

    const firstExitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      '--cache-location',
      cachePath,
      'demo.ts',
    ], io)

    expect(firstExitCode).toBe(0)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked 1')
    const cacheText = await readFile(cachePath, 'utf8')
    expect(cacheText.startsWith('{"alintVersion"')).toBe(true)
    expect(cacheText).toContain('"type":"metadata"')
    expect(cacheText).toContain('"type":"replace-owner"')

    io.stdoutText = ''
    io.stderrText = ''
    const secondExitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      '--cache-location',
      cachePath,
      'demo.ts',
    ], io)

    expect(secondExitCode).toBe(0)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked 1')
  })

  it('forces execution with --no-cache even when cache entries exist', async () => {
    const io = await createTestIo()

    await writeCacheFixture(io.cwd)

    const firstExitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'demo.ts',
    ], io)

    expect(firstExitCode).toBe(0)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked 1')

    io.stdoutText = ''
    io.stderrText = ''
    const secondExitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      '--no-cache',
      'demo.ts',
    ], io)

    expect(secondExitCode).toBe(0)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked 2')
  })

  it('preserves disabled setup cache when project config only overrides cache location', async () => {
    const io = await createTestIo()
    const cachePath = join(io.cwd, 'custom.json')

    await writeSetupConfig(getProjectSetupConfigPath(io.cwd), {
      providers: [],
      runner: {
        cache: { enabled: false },
      },
      version: 1,
    })
    await writeCacheFixture(io.cwd, `
  runner: {
    cache: { location: 'custom.json' },
  },`)

    const firstExitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'demo.ts',
    ], io)

    expect(firstExitCode).toBe(0)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked 1')

    io.stdoutText = ''
    io.stderrText = ''
    const secondExitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'demo.ts',
    ], io)

    expect(secondExitCode).toBe(0)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked 2')
    await expect(readFile(cachePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lets project config disable setup cache location', async () => {
    const io = await createTestIo()
    const cachePath = join(io.cwd, 'setup-cache.json')

    await writeSetupConfig(getProjectSetupConfigPath(io.cwd), {
      providers: [],
      runner: {
        cache: { location: 'setup-cache.json' },
      },
      version: 1,
    })
    await writeCacheFixture(io.cwd, `
  runner: {
    cache: { enabled: false },
  },`)

    const firstExitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'demo.ts',
    ], io)

    expect(firstExitCode).toBe(0)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked 1')

    io.stdoutText = ''
    io.stderrText = ''
    const secondExitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'demo.ts',
    ], io)

    expect(secondExitCode).toBe(0)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked 2')
    await expect(readFile(cachePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lets --cache-location override the merged config cache location', async () => {
    const io = await createTestIo()
    const setupCachePath = join(io.cwd, 'setup-cache.json')
    const projectCachePath = join(io.cwd, 'project-cache.json')
    const cliCachePath = join(io.cwd, 'cli-cache.json')

    await writeSetupConfig(getProjectSetupConfigPath(io.cwd), {
      providers: [],
      runner: {
        cache: { location: 'setup-cache.json' },
      },
      version: 1,
    })
    await writeCacheFixture(io.cwd, `
  runner: {
    cache: { location: 'project-cache.json' },
  },`)

    const firstExitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      '--cache-location',
      cliCachePath,
      'demo.ts',
    ], io)

    expect(firstExitCode).toBe(0)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked 1')
    await expect(readFile(cliCachePath, 'utf8')).resolves.toContain('"entries"')

    io.stdoutText = ''
    io.stderrText = ''
    const secondExitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      '--cache-location',
      cliCachePath,
      'demo.ts',
    ], io)

    expect(secondExitCode).toBe(0)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked 1')
    await expect(readFile(setupCachePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(projectCachePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('prints lint results before cache persistence errors and returns 1', async () => {
    const io = await createTestIo()
    const writes: string[] = []
    io.stdout.write = (chunk) => {
      writes.push(`stdout:${chunk}`)
      io.stdoutText += chunk
    }
    io.stderr.write = (chunk) => {
      writes.push(`stderr:${chunk}`)
      io.stderrText += chunk
    }
    const result: RunResult = {
      diagnostics: [{ filePath: join(io.cwd, 'demo.ts'), message: 'completed finding', ruleId: 'company/review', severity: 'warn' }],
      execution: { cached: 0, cancelled: 0, completed: 1, failed: 0, planned: 1, queued: 0, running: 0, skipped: 0 },
      usage: { inputTokens: 0, outputTokens: 0, records: [], totalTokens: 0 },
    }
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockRejectedValue(
      new alintCore.AlintCachePersistenceError(result, new Error('cache lease unavailable')),
    )

    try {
      await writeFile(join(io.cwd, 'demo.ts'), 'export function load() {}\n')
      await writeFile(join(io.cwd, 'alint.config.ts'), 'export default [{ files: [\'**/*.ts\'] }]\n')

      const exitCode = await executeCli(['node', 'alint', '--format', 'json', 'demo.ts'], io)

      expect(exitCode).toBe(1)
      expect(JSON.parse(io.stdoutText)).toEqual(result)
      expect(io.stderrText).toBe('Cache persistence failed: cache lease unavailable\n')
      expect(writes.map(write => write.slice(0, write.indexOf(':')))).toEqual(['stdout', 'stderr'])
    }
    finally {
      runAlint.mockRestore()
    }
  })

  it('formats rule execution failures without interpreting provider payloads', async () => {
    const io = await createTestIo()
    clearCiEnv(io.env)

    await writePartialFailureFixture(io.cwd)

    const exitCode = await executeCli([
      'node',
      'alint',
      '--progress',
      'demo.ts',
    ], io)

    expect(exitCode).toBe(2)
    expect(io.stderrText).toContain('scan ')
    expect(io.stderrText).toContain('1 failed, 0 cancelled')
    expect(io.stderrText).toContain('Failed Rules 1')
    expect(io.stderrText).toContain('FAIL company/review 1 target')
    expect(io.stderrText).toContain('demo.ts > file')
    expect(io.stderrText).toContain('[handler] Remote sent 403 response:')
    expect(io.stderrText).toContain('Remote sent 403 response:')
    expect(io.stderrText).toContain('"error"')
    expect(io.stderrText).toContain('user_id')
    expect(io.stdoutText).toContain('Partial finding')
    expect(io.stdoutText).toContain('company/finding')
    expect(io.stderrText).not.toContain('Partial finding')
    const statsFiles = await readdir(statsDirOf(io))
    const statsRecord = JSON.parse((await readFile(join(statsDirOf(io), statsFiles[0]!), 'utf8')).trim())
    expect(statsRecord.ruleCounts.failed).toBe(1)
    expect(statsRecord.ruleCounts.cancelled).toBe(0)
  })

  it('renders the cause of a rule execution failure', async () => {
    const io = await createTestIo()

    await writeCauseFailureFixture(io.cwd)

    const exitCode = await executeCli([
      'node',
      'alint',
      'demo.ts',
    ], io)

    expect(exitCode).toBe(2)
    expect(io.stderrText).toContain('    [handler] fetch failed\n      Caused by: [UND_ERR_SOCKET] other side closed')
  })

  it('keeps JSON stdout parseable when a rule execution fails after partial diagnostics', async () => {
    const io = await createTestIo()
    clearCiEnv(io.env)

    await writePartialFailureFixture(io.cwd)

    const exitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'demo.ts',
    ], io)

    expect(exitCode).toBe(2)
    expect(io.stdoutText).not.toBe('')
    const output: RunResult = JSON.parse(io.stdoutText)
    expect(output.diagnostics).toHaveLength(1)
    expect(output.diagnostics[0]?.message).toBe('Partial finding')
    expect(output.diagnostics[0]?.ruleId).toBe('company/finding')
    expect(io.stderrText).toContain('Failed Rules 1')
    expect(io.stderrText).not.toContain('Partial finding')
  })

  it('propagates progress reporter failures through the generic CLI error path', async () => {
    const io = await createTestIo()
    clearCiEnv(io.env)
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockRejectedValue(new Error('render failed'))

    try {
      await writeFile(join(io.cwd, 'demo.ts'), 'export function load() {}\n')

      await expect(executeCli(['node', 'alint', 'demo.ts'], io)).rejects.toThrow('render failed')
    }
    finally {
      runAlint.mockRestore()
    }
  })

  it('returns execution-failure exit code for cancelled runs', async () => {
    const io = await createTestIo()
    clearCiEnv(io.env)
    const result: RunResult = {
      diagnostics: [{
        filePath: join(io.cwd, 'demo.ts'),
        message: 'Finding before cancellation',
        ruleId: 'company/review',
        severity: 'warn',
      }],
      execution: { cached: 0, cancelled: 1, completed: 0, failed: 0, planned: 1, queued: 0, running: 0, skipped: 0 },
      usage: { inputTokens: 0, outputTokens: 0, records: [], totalTokens: 0 },
    }
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockRejectedValue(new alintCore.AlintRunCancelledError(result))

    try {
      await writeFile(join(io.cwd, 'demo.ts'), 'export function load() {}\n')

      const exitCode = await executeCli(['node', 'alint', 'demo.ts'], io)

      expect(exitCode).toBe(2)
      expect(io.stderrText).toContain('error Alint run cancelled.')
      expect(io.stdoutText).toContain('Finding before cancellation')
      expect(io.stdoutText).toContain('company/review')
      expect(io.stderrText).not.toContain('Finding before cancellation')
      const statsFiles = await readdir(statsDirOf(io))
      const statsRecord = JSON.parse((await readFile(join(statsDirOf(io), statsFiles[0]!), 'utf8')).trim())
      expect(statsRecord.ruleCounts).toEqual({ cached: 0, cancelled: 1, completed: 0, failed: 0, planned: 1 })
    }
    finally {
      runAlint.mockRestore()
    }
  })

  it('prioritizes project-local setup models over global defaults', async () => {
    const io = await createTestIo()
    const configHome = await mkdtemp(join(tmpdir(), 'alint-config-home-'))
    io.env = {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
    }

    await writeSetupConfig(getGlobalSetupConfigPath(io.env), {
      providers: [
        {
          endpoint: 'http://global.example/v1',
          id: 'global',
          models: [
            {
              capabilities: ['code-review'],
              id: 'global-model',
            },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    })
    await writeSetupConfig(getProjectSetupConfigPath(io.cwd), {
      providers: [
        {
          endpoint: 'http://project.example/v1',
          id: 'project',
          models: [
            {
              capabilities: ['code-review'],
              id: 'project-model',
            },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    })
    await writeFile(join(io.cwd, 'demo.ts'), 'export function load() {}\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    plugins: {
      company: {
        rules: {
        'prefer-local': {
          model: { capabilities: ['code-review'] },
          languages: 'any',
          create: (ctx) => ({
            onTargetFunction: async (target) => {
              const model = await ctx.model()
              ctx.report({
                filePath: target.file.path,
                message: 'checked with ' + model.id,
              })
            },
          }),
        },
      },
    },
    },
    rules: {
      'company/prefer-local': 'warn',
    },
  },
]
`)

    const exitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'demo.ts',
    ], io)

    expect(exitCode).toBe(0)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked with project-model')
  })

  it('forwards config model and format options to the run command', async () => {
    const io = await createTestIo()
    const configHome = await mkdtemp(join(tmpdir(), 'alint-config-home-'))
    const configFileName = 'custom.alint.config.ts'
    const configPath = join(io.cwd, configFileName)
    io.env = {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
    }

    await executeCli([
      'node',
      'alint',
      'setup',
      '-N',
      '--provider-id',
      'global',
      '--provider-endpoint',
      'http://localhost:11434/v1',
      '--provider-model',
      'global-model',
    ], io)
    await executeCli([
      'node',
      'alint',
      'setup',
      '-N',
      '--local',
      '--provider-id',
      'project',
      '--provider-endpoint',
      'http://localhost:11434/v1',
      '--provider-model',
      'project-model',
    ], io)
    await writeFile(join(io.cwd, 'demo.ts'), 'export function load() {}\n')
    await writeFile(configPath, `
export default [
  {
    files: ['**/*.ts'],
    plugins: {
      company: {
        rules: {
        'prefer-load': {
          languages: 'any',
          create: (ctx) => ({
            onTargetFunction: async (target) => {
              const model = await ctx.model('global-model')
              ctx.report({
                filePath: target.file.path,
                message: 'checked with ' + model.id,
              })
            },
          }),
        },
      },
    },
    },
    rules: {
      'company/prefer-load': 'warn',
    },
  },
]
`)

    io.stdoutText = ''
    const exitCode = await executeCli([
      'node',
      'alint',
      '--config',
      configFileName,
      '--model',
      'project-model',
      '--format',
      'json',
      'demo.ts',
    ], io)

    const output = JSON.parse(io.stdoutText)

    expect(exitCode).toBe(0)
    expect(output.diagnostics[0]).toMatchObject({
      message: 'checked with project-model',
      model: {
        requested: 'project-model',
        resolvedId: 'project-model',
      },
      ruleId: 'company/prefer-load',
    })
  })

  it('rejects missing explicit config paths', async () => {
    const io = await createTestIo()

    await expect(executeCli([
      'node',
      'alint',
      '--config',
      join(io.cwd, 'missing.alint.config.ts'),
      'demo.ts',
    ], io)).rejects.toThrow(`Config file "${join(io.cwd, 'missing.alint.config.ts')}" does not exist.`)
  })

  it('prints only the bare package version to stdout for --version', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli(['node', 'alint', '--version'], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toBe(`${packageJson.version}\n`)
    expect(io.stderrText).toBe('')
  })

  it('prints only the bare package version to stdout for the -v alias', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli(['node', 'alint', '-v'], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toBe(`${packageJson.version}\n`)
    expect(io.stderrText).toBe('')
  })

  it('lists --version in the root help output', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli(['node', 'alint', '--help'], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('-v, --version')
    expect(io.stderrText).toBe('')
  })
})

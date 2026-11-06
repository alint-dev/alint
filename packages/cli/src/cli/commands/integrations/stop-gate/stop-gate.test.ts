import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { x } from 'tinyexec'
import { describe, expect, it } from 'vitest'

import { executeCli } from '../../../cli'

describe('integrations stop-gate', () => {
  it('writes an English usage error before exiting non-zero', async () => {
    let stderr = ''
    let stdout = ''
    const exitCode = await executeCli([
      'node',
      'alint',
      'integrations',
      'stop-gate',
    ], {
      cwd: process.cwd(),
      stderr: {
        write: chunk => stderr += chunk,
      },
      stdout: {
        write: chunk => stdout += chunk,
      },
    })

    expect(exitCode).toBe(2)
    expect(stdout).toBe('')
    expect(stderr).toBe('Stop Gate requires --session-id.\n')
  })

  it('is inactive until the repository explicitly enables Stop Gate', async () => {
    const cwd = await createRepository(ruleConfig('warn', false))

    const result = await run(cwd, `inactive-${randomUUID()}`)

    expect(result.exitCode).toBe(0)
    expect(result.envelope.status).toBe('inactive')
  })

  it('returns warning diagnostics without retaining hook lifecycle state', async () => {
    const cwd = await createRepository(ruleConfig('warn'))
    const sessionId = `warnings-${randomUUID()}`

    const first = await run(cwd, sessionId)
    const second = await run(cwd, sessionId)

    expect(first.envelope.message).toBeUndefined()
    expect(first.exitCode).toBe(0)
    expect(first.envelope.status).toBe('warnings')
    expect(first.envelope.warningCount).toBe(1)
    expect(first.envelope.findingsHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(first.envelope.reportPath).toContain(sessionId)
    expect(second.exitCode).toBe(0)
    expect(second.envelope.status).toBe('warnings')
    expect(second.envelope.warningCount).toBe(1)
    expect(second.envelope.findingsHash).toBe(first.envelope.findingsHash)
  })

  it('returns error diagnostics', async () => {
    const cwd = await createRepository(ruleConfig('error'))
    const sessionId = `errors-${randomUUID()}`
    const result = await run(cwd, sessionId)

    expect(result.exitCode).toBe(0)
    expect(result.envelope.status).toBe('errors')
    expect(result.envelope.findingsHash).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('returns runtime configuration errors', async () => {
    const cwd = await createRepository([
      '[[config.group]]',
      'files = ["**/*.unknown"]',
      '',
      '[config.group.integrations.stopGate]',
      'target = "all"',
      '',
    ].join('\n'))
    const sessionId = `runtime-${randomUUID()}`

    const result = await run(cwd, sessionId)

    expect(result.exitCode).toBe(1)
    expect(result.envelope.message).not.toMatch(/^Stop Gate runtime error:/u)
    expect(result.envelope.status).toBe('runtime-error')
  })

  it('reports every failed rule execution with its causes and a structured report', async () => {
    const cwd = await createRepository(failingRuleConfig())
    const sessionId = `rule-failures-${randomUUID()}`

    const result = await run(cwd, sessionId)

    expect(result.exitCode).toBe(1)
    expect(result.envelope.status).toBe('runtime-error')
    expect(result.envelope.reportPath).toContain(sessionId)
    expect(result.envelope.message).toBe('2 rule executions failed.')

    const report = JSON.parse(await readFile(result.envelope.reportPath!, 'utf8')) as RuntimeFailureReport
    expect(report.failure.message).toBe('2 rule executions failed.')
    expect(report.failure.details).toHaveLength(2)
    expect(report.failure.details[0]?.job.ruleId).toBe('test/first')
    expect(report.failure.details[0]?.causes).toEqual([
      {
        code: 'MODEL_OFFLINE',
        message: 'model provider unavailable',
      },
    ])
    expect(report.failure.details[1]?.job.ruleId).toBe('test/second')
    expect(report.execution.failed).toBe(2)

    if (process.platform !== 'win32') {
      expect((await stat(result.envelope.reportPath!)).mode & 0o777).toBe(0o644)
    }
  })

  it('silently allows a repository without dirty files', async () => {
    const cwd = await createRepository([
      '[[config.group]]',
      'name = "stop gate"',
      '',
      '[config.group.integrations.stopGate]',
      'enabled = true',
      '',
      '[[config.group]]',
      'files = ["**/*.unknown"]',
      '',
    ].join('\n'), false)

    const result = await run(cwd, `clean-${randomUUID()}`)

    expect(result.exitCode).toBe(0)
    expect(result.envelope.status).toBe('no-dirty-files')
  })

  it('counts only changed-line and locationless diagnostics for dirty files', async () => {
    const cwd = await createRepository(locatedRuleConfig())
    await writeFile(join(cwd, 'input.ts'), 'first\noriginal\nthird\n', 'utf8')
    await git(cwd, ['add', 'input.ts'])
    await git(cwd, ['commit', '-m', 'add line fixture'])
    await writeFile(join(cwd, 'input.ts'), 'first\nchanged\nthird\n', 'utf8')

    const result = await run(cwd, `changed-lines-${randomUUID()}`)

    expect(result.exitCode).toBe(0)
    expect(result.envelope.status).toBe('warnings')
    expect(result.envelope.warningCount).toBe(2)
  })

  it('does not filter diagnostics for the all target', async () => {
    const cwd = await createRepository(locatedRuleConfig('all'))

    const result = await run(cwd, `all-lines-${randomUUID()}`)

    expect(result.exitCode).toBe(0)
    expect(result.envelope.status).toBe('warnings')
    expect(result.envelope.warningCount).toBe(3)
  })

  it('records Stop Gate runs through the ordinary stats store', async () => {
    const cwd = await createRepository(ruleConfig('warn'))
    const configHome = await mkdtemp(join(tmpdir(), 'alint-stop-gate-stats-'))
    const env = {
      ...process.env,
      BUILDKITE: '',
      CI: '',
      CIRCLECI: '',
      GITHUB_ACTIONS: '',
      GITLAB_CI: '',
      TF_BUILD: '',
      XDG_CONFIG_HOME: configHome,
    }

    const result = await run(cwd, `stats-${randomUUID()}`, env)
    const statsDir = join(configHome, 'alint', 'stats')
    const files = await readdir(statsDir)
    const lines = (await readFile(join(statsDir, files[0]), 'utf8')).trim().split('\n')
    const stat = JSON.parse(lines[0]) as Record<string, unknown>

    expect(result.exitCode).toBe(0)
    expect(files).toHaveLength(1)
    expect(lines).toHaveLength(1)
    expect(stat.cwd).toBe(cwd)
    expect(stat).not.toHaveProperty('mode')
  })
})

interface Envelope {
  errorCount: number
  findingsHash?: string
  message?: string
  reportPath?: string
  status: string
  warningCount: number
}

interface RuntimeFailureReport {
  execution: { failed: number }
  failure: {
    details: Array<{
      causes: Array<{ code?: string, message: string }>
      job: { ruleId: string }
    }>
    message: string
  }
}

async function createRepository(config: string, dirty = true): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'alint-stop-gate-command-'))
  await git(cwd, ['init'])
  await git(cwd, ['config', 'user.email', 'test@example.com'])
  await git(cwd, ['config', 'user.name', 'Test'])
  const configFile = config.startsWith('export default')
    ? 'alint.config.ts'
    : 'alint.config.toml'
  await writeFile(join(cwd, configFile), config, 'utf8')
  await writeFile(join(cwd, 'input.ts'), 'original\n', 'utf8')
  await git(cwd, ['add', '.'])
  await git(cwd, ['commit', '-m', 'initial'])

  if (dirty) {
    await writeFile(join(cwd, 'input.ts'), 'changed\n', 'utf8')
  }

  return cwd
}

function failingRuleConfig(): string {
  return `export default [{
    integrations: { stopGate: { enabled: true } },
  }, {
    files: ['**/*.ts'],
    plugins: {
      test: {
        rules: {
          first: {
            create: () => ({
              onTargetFile: () => {
                const cause = Object.assign(new Error('model provider unavailable'), { code: 'MODEL_OFFLINE' })
                throw new Error('first rule failed', { cause })
              },
            }),
          },
          second: {
            create: () => ({
              onTargetFile: () => {
                throw new Error('second rule failed')
              },
            }),
          },
        },
      },
    },
    rules: {
      'test/first': 'error',
      'test/second': 'error',
    },
  }]\n`
}

async function git(cwd: string, args: string[]): Promise<void> {
  await x('git', args, {
    nodeOptions: { cwd },
    nodePath: false,
    throwOnError: true,
  })
}

function locatedRuleConfig(target: 'all' | 'dirty-files' = 'dirty-files'): string {
  return `export default [{
    integrations: { stopGate: { enabled: true, target: '${target}' } },
  }, {
    files: ['input.ts'],
    plugins: {
      test: {
        rules: {
          finding: {
            create: context => ({
              onTargetFile: target => {
                context.report({
                  filePath: target.file.path,
                  loc: { start: { column: 0, line: 1 } },
                  message: 'unchanged line',
                })
                context.report({
                  filePath: target.file.path,
                  loc: { start: { column: 0, line: 2 } },
                  message: 'changed line',
                })
                context.report({
                  filePath: target.file.path,
                  message: 'file-wide finding',
                })
              },
            }),
          },
        },
      },
    },
    rules: { 'test/finding': 'warn' },
  }]\n`
}

function ruleConfig(severity: 'error' | 'warn', enabled = true): string {
  return `export default [{
    integrations: { stopGate: { enabled: ${enabled} } },
  }, {
    files: ['**/*.ts'],
    plugins: {
      test: {
        rules: {
          finding: {
            create: context => ({
              onTargetFile: target => context.report({
                filePath: target.file.path,
                message: 'Stop Gate test finding',
              }),
            }),
          },
        },
      },
    },
    rules: { 'test/finding': '${severity}' },
  }]\n`
}

async function run(
  cwd: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = { ...process.env, CI: 'true' },
): Promise<{
  envelope: Envelope
  exitCode: number
  stderr: string
}> {
  let stderr = ''
  let stdout = ''
  const exitCode = await executeCli([
    'node',
    'alint',
    'integrations',
    'stop-gate',
    '--session-id',
    sessionId,
  ], {
    cwd,
    env,
    stderr: {
      write: chunk => stderr += chunk,
    },
    stdout: {
      write: chunk => stdout += chunk,
    },
  })

  return {
    envelope: JSON.parse(stdout) as Envelope,
    exitCode,
    stderr,
  }
}

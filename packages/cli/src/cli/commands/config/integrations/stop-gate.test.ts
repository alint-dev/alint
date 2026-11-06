import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { maximumStopGateTimeoutMs } from '@alint-js/core'
import { describe, expect, it } from 'vitest'

import { executeCli } from '../../../cli'

async function run(cwd: string, args: string[]) {
  let stderr = ''
  let stdout = ''
  const exitCode = await executeCli(['node', 'alint', ...args], {
    cwd,
    stderr: {
      write: chunk => stderr += chunk,
    },
    stdout: {
      write: chunk => stdout += chunk,
    },
  })

  return { exitCode, stderr, stdout }
}

describe('config integrations stop-gate', () => {
  it('shows defaults when no config exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-stop-gate-cli-'))

    const result = await run(cwd, [
      'config',
      'integrations',
      'stop-gate',
      'show',
    ])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe([
      'config: <not found>',
      'enabled: false (default)',
      'target: dirty-files (default)',
      'timeoutMs: 900000 (default)',
      '',
    ].join('\n'))
  })

  it('explicitly enables and disables Stop Gate for the repository', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-stop-gate-cli-'))

    const enabled = await run(cwd, [
      'config',
      'integrations',
      'stop-gate',
      'enable',
    ])

    expect(enabled.exitCode).toBe(0)
    expect(enabled.stderr).toBe('')
    expect(enabled.stdout).toContain('enabled: true\n')
    expect(await readFile(join(cwd, 'alint.config.toml'), 'utf8')).toContain('enabled = true')

    const disabled = await run(cwd, [
      'config',
      'integrations',
      'stop-gate',
      'disable',
    ])

    expect(disabled.exitCode).toBe(0)
    expect(disabled.stderr).toBe('')
    expect(disabled.stdout).toContain('enabled: false (default)\n')
    expect(await readFile(join(cwd, 'alint.config.toml'), 'utf8')).not.toContain('enabled =')
  })

  it('writes non-default TOML overrides', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-stop-gate-cli-'))

    const result = await run(cwd, [
      'config',
      'integrations',
      'stop-gate',
      'set',
      '--target',
      'all',
      '--timeout-ms',
      '30000',
    ])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('target: all\n')
    expect(result.stdout).toContain('timeoutMs: 30000\n')
    expect(await readFile(join(cwd, 'alint.config.toml'), 'utf8')).toContain('target = "all"')
  })

  it('returns exit 2 for executable config writes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-stop-gate-cli-'))
    await writeFile(join(cwd, 'alint.config.ts'), 'export default []\n', 'utf8')

    const result = await run(cwd, [
      'config',
      'integrations',
      'stop-gate',
      'set',
      '--target',
      'all',
    ])

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Stop Gate config writes require an alint.config.toml file.\n')
  })

  it('returns exit 2 when the timeout exceeds the hook budget', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-stop-gate-cli-'))

    const result = await run(cwd, [
      'config',
      'integrations',
      'stop-gate',
      'set',
      '--timeout-ms',
      String(maximumStopGateTimeoutMs + 1),
    ])

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(`Stop Gate timeout must be an integer from 1 to ${maximumStopGateTimeoutMs}.\n`)
  })
})

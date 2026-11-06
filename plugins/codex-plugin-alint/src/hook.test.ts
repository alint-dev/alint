import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { x } from 'tinyexec'
import { describe, expect, it, onTestFinished } from 'vitest'

const bundledHook = fileURLToPath(new URL('../dist/stop-gate.mjs', import.meta.url))
const bundledLauncher = fileURLToPath(new URL('../dist/stop-gate-launcher.mjs', import.meta.url))
const hookManifest = fileURLToPath(new URL('../hooks/hooks.json', import.meta.url))

type RepositoryActivation
  = | 'config-empty'
    | 'config-stderr-exit-one'
    | 'disabled'
    | 'enabled'
    | 'enabled-all'
    | 'enabled-errors'
    | 'enabled-errors-exit-one'
    | 'enabled-silent-exit-one'
    | 'enabled-stderr-exit-one'
    | 'none'

describe('bundled Stop hook', () => {
  it('uses the supported command-string hook schema', async () => {
    const manifest = JSON.parse(await readFile(hookManifest, 'utf8')) as {
      hooks: { Stop: Array<{ hooks: Array<Record<string, unknown>> }> }
    }
    const handler = manifest.hooks.Stop[0]?.hooks[0]

    // Codex defines CLAUDE_PLUGIN_ROOT as an official compatibility alias for its PLUGIN_ROOT variable.
    expect(handler?.command).toBe(`node "${'$'}{CLAUDE_PLUGIN_ROOT}/dist/stop-gate-launcher.mjs"`)
    expect(handler).not.toHaveProperty('args')
  })

  it('contains no external runtime imports', async () => {
    const sources = await Promise.all([
      readFile(bundledHook, 'utf8'),
      readFile(bundledLauncher, 'utf8'),
    ])
    const imports = sources.flatMap(source => [
      ...source.matchAll(/^import .*? from ["'](.+?)["'];?$/gmu),
    ])
      .map(match => match[1])
      .filter(specifier => !specifier?.startsWith('node:'))

    expect(imports).toEqual([])
  })

  it('records stderr when the hook bundle fails before its runtime starts', async () => {
    const systemTemp = await mkdtemp(join(tmpdir(), 'alint-hook-system-temp-'))
    const launcherDirectory = await mkdtemp(join(tmpdir(), 'alint-hook-launcher-'))
    onTestFinished(() => rm(systemTemp, { force: true, recursive: true }))
    onTestFinished(() => rm(launcherDirectory, { force: true, recursive: true }))
    const isolatedLauncher = join(launcherDirectory, 'stop-gate-launcher.mjs')
    await copyFile(bundledLauncher, isolatedLauncher)

    const result = await runLauncher(isolatedLauncher, systemTemp)
    const fatalDirectory = join(systemTemp, 'alint-stop-gate', 'fatal')
    const fatalEntries = await readdir(fatalDirectory)
    const fatalContent = await readFile(join(fatalDirectory, fatalEntries[0] ?? ''), 'utf8')

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Stop Gate child process exited before returning a hook decision')
    expect(fatalEntries).toHaveLength(1)
    expect(fatalContent).toContain('context: Stop Gate child process exited before returning a hook decision')
    expect(fatalContent).toContain('exit code: 1')
    expect(fatalContent).toContain('MODULE_NOT_FOUND')
    expect(fatalContent).toContain('stop-gate.mjs')
  })

  it('is silent when the Git repository has no alint project config', async () => {
    const cwd = await createRepository('none')
    const pluginData = await mkdtemp(join(tmpdir(), 'alint-hook-data-'))

    const result = await runHook(cwd, pluginData, `inactive-${randomUUID()}`)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  it('is silent when the repository has not explicitly enabled Stop Gate', async () => {
    const cwd = await createRepository('disabled')
    const pluginData = await mkdtemp(join(tmpdir(), 'alint-hook-data-'))

    const result = await runHook(cwd, pluginData, `inactive-${randomUUID()}`)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  it('skips dirty-file lint when Git HEAD is detached', async () => {
    const cwd = await createRepository('enabled')
    const pluginData = await mkdtemp(join(tmpdir(), 'alint-hook-data-'))
    await detachHead(cwd)

    const result = await runHook(cwd, pluginData, `detached-${randomUUID()}`)
    const decision = JSON.parse(result.stdout) as { decision?: string, systemMessage?: string }

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(decision.decision).toBeUndefined()
    expect(decision.systemMessage).toBe('alint-plugin: Stop Gate skipped because Git HEAD is detached. You may need to let the user know that. Run `alint --dirty` manually if this checkout should be reviewed.')
  })

  it('runs all-target lint when Git HEAD is detached', async () => {
    const cwd = await createRepository('enabled-all')
    const pluginData = await mkdtemp(join(tmpdir(), 'alint-hook-data-'))
    await detachHead(cwd)

    const result = await runHook(cwd, pluginData, `detached-all-${randomUUID()}`)
    const decision = JSON.parse(result.stdout) as { decision?: string, reason?: string }

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(decision.decision).toBe('block')
    expect(decision.reason).toContain('alint-plugin: 0 error(s), 1 warning(s).')
  })

  it('reports malformed Codex hook input in English before exiting non-zero', async () => {
    const systemTemp = await mkdtemp(join(tmpdir(), 'alint-hook-system-temp-'))
    onTestFinished(() => rm(systemTemp, { force: true, recursive: true }))
    const fatalDirectory = join(systemTemp, 'alint-stop-gate', 'fatal')
    const result = await runMalformedHook(systemTemp)
    const entriesAfter = await readDirectoryOrEmpty(fatalDirectory)
    const fatalEntry = entriesAfter[0]
    const fatalPath = join(fatalDirectory, fatalEntry ?? '')
    const fatalContent = await readFile(fatalPath, 'utf8')
    const fatalLines = fatalContent.trimEnd().split('\n')
    const detail = fatalLines[2]?.slice('detail: '.length)

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(fatalEntry).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+\.log$/u)
    expect(result.stderr).toBe([
      `alint-plugin: Stop Gate hook runtime error. Could not read Codex hook input: ${detail}.`,
      `Read the error details at "${fatalPath}", then explain to the user how to fix the hook failure.`,
      '',
    ].join('\n'))
    expect(fatalLines[0]).toMatch(/^timestamp: .+$/u)
    expect(fatalLines[1]).toBe('context: Could not read Codex hook input')
    expect(fatalLines[2]).toMatch(/^detail: .+$/u)

    if (process.platform !== 'win32') {
      expect((await stat(fatalPath)).mode & 0o777).toBe(0o644)
    }
  })

  it('explains when a fatal diagnostic cannot be saved', async () => {
    const systemTemp = await mkdtemp(join(tmpdir(), 'alint-hook-system-temp-'))
    onTestFinished(() => rm(systemTemp, { force: true, recursive: true }))
    await writeFile(join(systemTemp, 'alint-stop-gate'), 'blocks the diagnostic directory', 'utf8')

    const result = await runMalformedHook(systemTemp)

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^alint-plugin: Stop Gate hook runtime error\. Could not read Codex hook input: .+\.\nThe error diagnostic could not be saved: .+\. Explain this failure to the user\.\n$/u)
  })

  it('keeps fatal diagnostics within the 10 MiB aggregate budget', async () => {
    const systemTemp = await mkdtemp(join(tmpdir(), 'alint-hook-system-temp-'))
    onTestFinished(() => rm(systemTemp, { force: true, recursive: true }))
    const fatalDirectory = join(systemTemp, 'alint-stop-gate', 'fatal')
    const oldestPath = join(fatalDirectory, 'oldest.log')
    const recentPath = join(fatalDirectory, 'recent.log')
    await mkdir(fatalDirectory, { recursive: true })
    await writeFile(oldestPath, Buffer.alloc(6 * 1024 * 1024))
    await writeFile(recentPath, Buffer.alloc(5 * 1024 * 1024))
    await utimes(oldestPath, new Date(0), new Date(0))
    await utimes(recentPath, new Date(1), new Date(1))

    const result = await runMalformedHook(systemTemp)
    const entries = await readdir(fatalDirectory)
    const sizes = await Promise.all(entries.map(async entry => (await stat(join(fatalDirectory, entry))).size))

    expect(result.exitCode).toBe(1)
    expect(entries).not.toContain('oldest.log')
    expect(entries).toContain('recent.log')
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(10 * 1024 * 1024)
  })

  it('discovers the package manager from a non-executable lockfile', async () => {
    const cwd = await createRepository('enabled')
    const pluginData = await mkdtemp(join(tmpdir(), 'alint-hook-data-'))
    const binDirectory = await mkdtemp(join(tmpdir(), 'alint-hook-bin-'))
    const executable = join(binDirectory, process.platform === 'win32'
      ? 'pnpm.cmd'
      : 'pnpm')
    await rm(join(cwd, 'node_modules'), { recursive: true })
    await writeFile(join(cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', { encoding: 'utf8', mode: 0o644 })
    await writeFile(executable, fakePackageManager(), 'utf8')
    await chmod(executable, 0o755)

    const result = await runHook(cwd, pluginData, `package-manager-${randomUUID()}`, false, {
      PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ''}`,
    })
    expect(result.stdout).not.toBe('')
    const decision = JSON.parse(result.stdout) as { decision?: string }

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(decision.decision).toBe('block')
  })

  it('explains when a successful config probe produces no output', async () => {
    const cwd = await createRepository('config-empty')
    const pluginData = await mkdtemp(join(tmpdir(), 'alint-hook-data-'))

    const result = await runHook(cwd, pluginData, `config-empty-${randomUUID()}`)
    const decision = JSON.parse(result.stdout) as { decision?: string, reason?: string }

    expect(result.exitCode).toBe(0)
    expect(decision.decision).toBe('block')
    expect(decision.reason).toContain('alint exited successfully but produced no Stop Gate configuration output')
    expect(decision.reason).toContain('Run `alint config integrations stop-gate show` manually')
  })

  it('includes the repository-local config probe failure reason', async () => {
    const cwd = await createRepository('config-stderr-exit-one')
    const pluginData = await mkdtemp(join(tmpdir(), 'alint-hook-data-'))

    const result = await runHook(cwd, pluginData, `config-stderr-${randomUUID()}`)
    const decision = JSON.parse(result.stdout) as { decision?: string, reason?: string }

    expect(result.exitCode).toBe(0)
    expect(decision.decision).toBe('block')
    expect(decision.reason).toBe([
      'alint-plugin: Runtime error: The repository-local alint could not read Stop Gate configuration due to exit code 1: Error: config probe failed. Run `alint config integrations stop-gate show` manually.',
      'Do not attempt to fix it yourself. Explain the error to the user and suggest how to fix it.',
    ].join('\n'))
  })

  it('blocks the first warning round and emits a system reminder on the next round', async () => {
    const cwd = await createRepository('enabled')
    const pluginData = await mkdtemp(join(tmpdir(), 'alint-hook-data-'))
    const sessionId = `warnings-${randomUUID()}`

    const first = await runHook(cwd, pluginData, sessionId)
    const second = await runHook(cwd, pluginData, sessionId, true)

    expect(first.exitCode).toBe(0)
    expect(first.stderr).toBe('')
    expect(first.stdout).not.toBe('')
    expect(second.exitCode).toBe(0)
    expect(second.stderr).toBe('')
    expect(second.stdout).not.toBe('')

    const firstDecision = JSON.parse(first.stdout) as { decision?: string, reason?: string }
    const secondDecision = JSON.parse(second.stdout) as { decision?: string, systemMessage?: string }

    expect(firstDecision.decision).toBe('block')
    expect(firstDecision.reason).toContain('alint-plugin: 0 error(s), 1 warning(s).')
    expect(secondDecision.decision).toBeUndefined()
    expect(secondDecision.systemMessage).toBe('alint-plugin: The same 0 error(s) and 1 warning(s) remain unchanged from the previous automatic lint. Stop Gate is allowing this turn to finish. The report remains at "/tmp/alint-stop-gate/report.json".')
  })

  it('allows errors when the second consecutive lint returns identical findings', async () => {
    const cwd = await createRepository('enabled-errors')
    const pluginData = await mkdtemp(join(tmpdir(), 'alint-hook-data-'))
    const sessionId = `errors-${randomUUID()}`

    const first = await runHook(cwd, pluginData, sessionId)
    const second = await runHook(cwd, pluginData, sessionId, true)
    const firstDecision = JSON.parse(first.stdout) as { decision?: string }
    const secondDecision = JSON.parse(second.stdout) as { decision?: string, systemMessage?: string }

    expect(first.exitCode).toBe(0)
    expect(firstDecision.decision).toBe('block')
    expect(second.exitCode).toBe(0)
    expect(secondDecision.decision).toBeUndefined()
    expect(secondDecision.systemMessage).toContain('The same 1 error(s) and 0 warning(s) remain unchanged')
  })

  it('treats an alint exit 1 with a findings envelope as a runtime failure', async () => {
    const cwd = await createRepository('enabled-errors-exit-one')
    const pluginData = await mkdtemp(join(tmpdir(), 'alint-hook-data-'))
    const result = await runHook(cwd, pluginData, `abnormal-${randomUUID()}`)
    const decision = JSON.parse(result.stdout) as { decision?: string, reason?: string }

    expect(result.exitCode).toBe(0)
    expect(decision.decision).toBe('block')
    expect(decision.reason).toContain('alint Stop Gate returned status "errors" with unexpected exit code 1')
  })

  it('reports bounded stderr when alint exits 1 without an envelope', async () => {
    const cwd = await createRepository('enabled-stderr-exit-one')
    const pluginData = await mkdtemp(join(tmpdir(), 'alint-hook-data-'))
    const result = await runHook(cwd, pluginData, `stderr-${randomUUID()}`)
    const decision = JSON.parse(result.stdout) as { decision?: string, reason?: string }
    const error = decision.reason
      ?.split('alint-plugin: Runtime error: ', 2)[1]
      ?.split('\nDo not attempt to fix it yourself.', 2)[0] ?? ''
    const stderr = error.split('exit code 1: ', 2)[1] ?? ''

    expect(result.exitCode).toBe(0)
    expect(decision.decision).toBe('block')
    expect(error).toContain('stderr-head-')
    expect(error).toContain('-stderr-tail')
    expect(error).toContain('... stderr truncated ...')
    expect(error).not.toContain('stderr-middle')
    expect(stderr).not.toContain('\uFFFD')
    expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(4 * 1024)
  })

  it('reports a fixed error when alint exits 1 without output', async () => {
    const cwd = await createRepository('enabled-silent-exit-one')
    const pluginData = await mkdtemp(join(tmpdir(), 'alint-hook-data-'))
    const result = await runHook(cwd, pluginData, `silent-${randomUUID()}`)
    const decision = JSON.parse(result.stdout) as { decision?: string, reason?: string }

    expect(result.exitCode).toBe(0)
    expect(decision.decision).toBe('block')
    expect(decision.reason).toContain('alint Stop Gate exited abnormally with exit code 1 and produced no stderr output.')
  })
})

async function createRepository(
  activation: RepositoryActivation,
): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'alint-hook-repo-'))
  await x('git', ['init'], {
    nodeOptions: { cwd },
    nodePath: false,
    throwOnError: true,
  })

  if (activation === 'none') {
    return cwd
  }

  await writeFile(join(cwd, 'alint.config.toml'), '[[config.group]]\nname = "rules"\n', 'utf8')
  const binDirectory = join(cwd, 'node_modules', '.bin')
  const executable = join(binDirectory, process.platform === 'win32'
    ? 'alint.cmd'
    : 'alint')
  await mkdir(binDirectory, { recursive: true })
  await writeFile(executable, fakeAlint(activation), 'utf8')
  await chmod(executable, 0o755)
  return cwd
}

async function detachHead(cwd: string): Promise<void> {
  await x('git', ['config', 'user.email', 'test@example.com'], {
    nodeOptions: { cwd },
    nodePath: false,
    throwOnError: true,
  })
  await x('git', ['config', 'user.name', 'Test'], {
    nodeOptions: { cwd },
    nodePath: false,
    throwOnError: true,
  })
  await x('git', ['add', '.'], {
    nodeOptions: { cwd },
    nodePath: false,
    throwOnError: true,
  })
  await x('git', ['commit', '-m', 'initial'], {
    nodeOptions: { cwd },
    nodePath: false,
    throwOnError: true,
  })
  await x('git', ['checkout', '--detach'], {
    nodeOptions: { cwd },
    nodePath: false,
    throwOnError: true,
  })
}

function fakeAlint(activation: Exclude<RepositoryActivation, 'none'>): string {
  const enabled = activation !== 'disabled'
  const emptyConfig = activation === 'config-empty'
  const configStderrExit = activation === 'config-stderr-exit-one'
  const errors = activation === 'enabled-errors' || activation === 'enabled-errors-exit-one'
  const abnormalExit = activation === 'enabled-errors-exit-one'
  const stderrExit = activation === 'enabled-stderr-exit-one'
  const silentExit = activation === 'enabled-silent-exit-one'
  const target = activation === 'enabled-all'
    ? 'all'
    : 'dirty-files'

  return `#!/usr/bin/env node
const { writeSync } = require('node:fs')
const args = process.argv.slice(2)
if (args.join(' ') === 'config integrations stop-gate show') {
  if (${configStderrExit}) {
    writeSync(2, 'Error: config probe failed')
    process.exitCode = 1
  } else if (!${emptyConfig}) {
    writeSync(1, 'config: alint.config.toml\\nenabled: ${enabled}\\ntarget: ${target}\\ntimeoutMs: 900000 (default)\\n')
  }
} else if (args[0] === 'integrations' && args[1] === 'stop-gate') {
  if (${stderrExit}) {
    writeSync(2, 'stderr-head-' + '界'.repeat(1500) + 'stderr-middle' + '文'.repeat(1500) + '-stderr-tail')
    process.exitCode = 1
  } else if (${silentExit}) {
    process.exitCode = 1
  } else {
    writeSync(1, JSON.stringify({
      errorCount: ${errors ? 1 : 0},
      findingsHash: 'a'.repeat(64),
      reportPath: '/tmp/alint-stop-gate/report.json',
      schemaVersion: 2,
      status: '${errors ? 'errors' : 'warnings'}',
      warningCount: ${errors ? 0 : 1},
    }) + '\\n')
    process.exitCode = ${abnormalExit ? 1 : 0}
  }
} else {
  process.exitCode = 2
}
`
}

function fakePackageManager(): string {
  return `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.join(' ') === 'exec alint config integrations stop-gate show') {
  process.stdout.write('config: alint.config.toml\\nenabled: true\\ntarget: dirty-files (default)\\ntimeoutMs: 900000 (default)\\n')
} else if (args[0] === 'exec' && args[1] === 'alint' && args[2] === 'integrations' && args[3] === 'stop-gate') {
  process.stdout.write(JSON.stringify({
    errorCount: 0,
    findingsHash: 'a'.repeat(64),
    reportPath: '/tmp/alint-stop-gate/report.json',
    schemaVersion: 2,
    status: 'warnings',
    warningCount: 1,
  }) + '\\n')
} else {
  process.exitCode = 2
}
`
}

async function readDirectoryOrEmpty(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return []
    }

    throw error
  }
}

async function runHook(
  cwd: string,
  pluginData: string,
  sessionId: string,
  stopHookActive = false,
  env: NodeJS.ProcessEnv = {},
) {
  return x(process.execPath, [bundledLauncher], {
    nodeOptions: {
      // NOTICE: Codex defines CLAUDE_PLUGIN_DATA as an official compatibility alias for its PLUGIN_DATA variable.
      env: {
        ...process.env,
        ...env,
        CLAUDE_PLUGIN_DATA: pluginData,
      },
    },
    nodePath: false,
    stdin: JSON.stringify({
      cwd,
      hook_event_name: 'Stop',
      session_id: sessionId,
      stop_hook_active: stopHookActive,
      turn_id: randomUUID(),
    }),
    throwOnError: false,
  })
}

function runLauncher(launcher: string, systemTemp: string) {
  return x(process.execPath, [launcher], {
    nodeOptions: {
      env: {
        ...process.env,
        // NOTICE: Codex defines CLAUDE_PLUGIN_DATA as an official compatibility alias for its PLUGIN_DATA variable.
        CLAUDE_PLUGIN_DATA: systemTemp,
        TEMP: systemTemp,
        TMP: systemTemp,
        TMPDIR: systemTemp,
      },
    },
    stdin: JSON.stringify({
      cwd: systemTemp,
      hook_event_name: 'Stop',
      session_id: `launcher-${randomUUID()}`,
      stop_hook_active: false,
      turn_id: randomUUID(),
    }),
    throwOnError: false,
  })
}

function runMalformedHook(systemTemp: string) {
  return x(process.execPath, [bundledLauncher], {
    nodeOptions: {
      env: {
        ...process.env,
        // NOTICE: Codex defines CLAUDE_PLUGIN_DATA as an official compatibility alias for its PLUGIN_DATA variable.
        CLAUDE_PLUGIN_DATA: systemTemp,
        TEMP: systemTemp,
        TMP: systemTemp,
        TMPDIR: systemTemp,
      },
    },
    stdin: '{',
    throwOnError: false,
  })
}

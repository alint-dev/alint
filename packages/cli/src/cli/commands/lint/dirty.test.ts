import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { x } from 'tinyexec'
import { describe, expect, it } from 'vitest'

import { executeCli } from '../../cli'

describe('lint --dirty', () => {
  it('lints staged, unstaged, and untracked files only', async () => {
    const io = await createRepository()
    await writeFile(join(io.cwd, 'staged.ts'), 'staged\n', 'utf8')
    await git(io.cwd, ['add', 'staged.ts'])
    await writeFile(join(io.cwd, 'unstaged.ts'), 'unstaged\n', 'utf8')
    await writeFile(join(io.cwd, 'untracked.ts'), 'untracked\n', 'utf8')
    await writeFile(join(io.cwd, 'ignored.ts'), 'ignored\n', 'utf8')

    const exitCode = await executeCli([
      'node',
      'alint',
      '--dirty',
      '--format',
      'json',
    ], io)
    const diagnostics = JSON.parse(io.stdoutText).diagnostics as Array<{ filePath: string }>

    expect(exitCode).toBe(0)
    expect(diagnostics.map(diagnostic => diagnostic.filePath).sort()).toEqual([
      join(io.cwd, 'staged.ts'),
      join(io.cwd, 'unstaged.ts'),
      join(io.cwd, 'untracked.ts'),
    ])
  })

  it('uses the Git root when invoked from a nested directory', async () => {
    const io = await createRepository()
    await writeFile(join(io.cwd, 'unstaged.ts'), 'unstaged\n', 'utf8')
    const root = io.cwd
    const nested = join(root, 'nested')
    await mkdir(nested)
    io.cwd = nested

    const exitCode = await executeCli([
      'node',
      'alint',
      '--dirty',
      '--format',
      'json',
    ], io)
    const diagnostics = JSON.parse(io.stdoutText).diagnostics as Array<{ filePath: string }>

    expect(exitCode).toBe(0)
    expect(diagnostics.map(diagnostic => diagnostic.filePath)).toEqual([
      join(root, 'unstaged.ts'),
    ])
  })

  it('exits successfully without running when the repository is clean', async () => {
    const io = await createRepository()

    const exitCode = await executeCli(['node', 'alint', '--dirty'], io)

    expect(exitCode).toBe(0)
    expect(io.stderrText).toBe('')
    expect(io.stdoutText).toBe('')
  })

  it('rejects positional file arguments', async () => {
    const io = await createRepository()

    const exitCode = await executeCli(['node', 'alint', '--dirty', 'clean.ts'], io)

    expect(exitCode).toBe(2)
    expect(io.stderrText).toBe('The --dirty option does not accept file arguments.\n')
    expect(io.stdoutText).toBe('')
  })

  it('shows changed-line and locationless diagnostics only', async () => {
    const io = await createRepository(locatedConfig())
    await writeFile(join(io.cwd, 'clean.ts'), 'first\noriginal\nthird\n', 'utf8')
    await git(io.cwd, ['add', 'clean.ts'])
    await git(io.cwd, ['commit', '-m', 'add line fixture'])
    await writeFile(join(io.cwd, 'clean.ts'), 'first\nchanged\nthird\n', 'utf8')

    const exitCode = await executeCli([
      'node',
      'alint',
      '--dirty',
      '--format',
      'json',
    ], io)
    const diagnostics = JSON.parse(io.stdoutText).diagnostics as Array<{ message: string }>

    expect(exitCode).toBe(0)
    expect(diagnostics.map(diagnostic => diagnostic.message)).toEqual([
      'changed line',
      'file-wide finding',
    ])
  })

  it('filters the partial result from AlintRunError', async () => {
    const io = await createRepository(locatedConfig(true))
    await writeFile(join(io.cwd, 'clean.ts'), 'first\noriginal\nthird\n', 'utf8')
    await git(io.cwd, ['add', 'clean.ts'])
    await git(io.cwd, ['commit', '-m', 'add line fixture'])
    await writeFile(join(io.cwd, 'clean.ts'), 'first\nchanged\nthird\n', 'utf8')

    const exitCode = await executeCli([
      'node',
      'alint',
      '--dirty',
      '--format',
      'json',
    ], io)
    const diagnostics = JSON.parse(io.stdoutText).diagnostics as Array<{ message: string }>

    expect(exitCode).toBe(2)
    expect(diagnostics.map(diagnostic => diagnostic.message)).toEqual([
      'changed line',
      'file-wide finding',
    ])
  })
})

interface TestIo {
  cwd: string
  env: NodeJS.ProcessEnv
  stderr: { write: (chunk: string) => void }
  stderrText: string
  stdout: { write: (chunk: string) => void }
  stdoutText: string
}

function config(): string {
  return `export default [{
    files: ['**/*.ts'],
    language: 'plaintext',
    plugins: {
      test: {
        rules: {
          visit: {
            create: context => ({
              onTargetFile: target => context.report({
                filePath: target.file.path,
                message: 'visited',
              }),
            }),
          },
        },
      },
    },
    rules: { 'test/visit': 'warn' },
  }]\n`
}

async function createRepository(configSource = config()): Promise<TestIo> {
  const cwd = await mkdtemp(join(tmpdir(), 'alint-dirty-'))
  const configHome = await mkdtemp(join(tmpdir(), 'alint-dirty-config-'))
  const io: TestIo = {
    cwd,
    env: { ...process.env, CI: 'true', XDG_CONFIG_HOME: configHome },
    stderr: {
      write: chunk => io.stderrText += chunk,
    },
    stderrText: '',
    stdout: {
      write: chunk => io.stdoutText += chunk,
    },
    stdoutText: '',
  }
  await git(cwd, ['init'])
  await git(cwd, ['config', 'user.email', 'test@example.com'])
  await git(cwd, ['config', 'user.name', 'Test'])
  await writeFile(join(cwd, 'alint.config.ts'), configSource, 'utf8')
  await writeFile(join(cwd, '.gitignore'), 'ignored.ts\n', 'utf8')

  for (const file of ['clean.ts', 'staged.ts', 'unstaged.ts']) {
    await writeFile(join(cwd, file), 'original\n', 'utf8')
  }

  await git(cwd, ['add', '.'])
  await git(cwd, ['commit', '-m', 'initial'])
  return io
}

async function git(cwd: string, args: string[]): Promise<void> {
  await x('git', args, {
    nodeOptions: { cwd },
    nodePath: false,
    throwOnError: true,
  })
}

function locatedConfig(throws = false): string {
  return `export default [{
    files: ['**/*.ts'],
    language: 'plaintext',
    plugins: {
      test: {
        rules: {
          visit: {
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
                if (${throws}) throw new Error('rule failed after reporting')
              },
            }),
          },
        },
      },
    },
    rules: { 'test/visit': 'warn' },
  }]\n`
}

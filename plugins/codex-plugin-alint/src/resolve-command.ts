import process from 'node:process'

import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isNodeErrorCode } from '@alint-js/utils/node'

export interface Command {
  args: string[]
  executable: string
  source: 'local' | 'package-manager' | 'path'
}

export async function resolveCommands(gitRoot: string): Promise<Command[]> {
  const commands: Command[] = []
  const local = join(gitRoot, 'node_modules', '.bin', process.platform === 'win32'
    ? 'alint.cmd'
    : 'alint')

  if (await canAccess(local, process.platform === 'win32'
    ? constants.F_OK
    : constants.X_OK)) {
    commands.push({ args: [], executable: local, source: 'local' })
  }

  const packageManager = await detectPackageManager(gitRoot)

  if (packageManager !== undefined) {
    commands.push(packageManager === 'npm'
      ? {
          args: [
            'exec',
            '--offline',
            '--yes=false',
            '--',
            'alint',
          ],
          executable: 'npm',
          source: 'package-manager',
        }
      : packageManager === 'bun'
        ? {
            args: ['x', '--no-install', 'alint'],
            executable: 'bun',
            source: 'package-manager',
          }
        : {
            args: ['exec', 'alint'],
            executable: packageManager,
            source: 'package-manager',
          })
  }

  commands.push({ args: [], executable: 'alint', source: 'path' })
  return commands
}

async function canAccess(path: string, mode: number): Promise<boolean> {
  try {
    await access(path, mode)
    return true
  }
  catch (error) {
    if (isNodeErrorCode(error, 'ENOENT') || isNodeErrorCode(error, 'EACCES')) {
      return false
    }

    throw error
  }
}

async function detectPackageManager(gitRoot: string): Promise<'bun' | 'npm' | 'pnpm' | 'yarn' | undefined> {
  const packageManager = await readPackageManagerField(gitRoot)

  if (packageManager !== undefined) {
    return packageManager
  }

  const lockfiles = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm'],
  ] as const

  for (const [lockfile, manager] of lockfiles) {
    if (await canAccess(join(gitRoot, lockfile), constants.F_OK)) {
      return manager
    }
  }

  return undefined
}

async function readPackageManagerField(gitRoot: string): Promise<'bun' | 'npm' | 'pnpm' | 'yarn' | undefined> {
  try {
    const packageJson = JSON.parse(await readFile(join(gitRoot, 'package.json'), 'utf8')) as { packageManager?: unknown }

    if (typeof packageJson.packageManager !== 'string') {
      return undefined
    }

    const name = packageJson.packageManager.split('@', 1)[0]
    return name === 'bun' || name === 'npm' || name === 'pnpm' || name === 'yarn'
      ? name
      : undefined
  }
  catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return undefined
    }

    throw error
  }
}

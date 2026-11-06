import type { DirectoryPluginSpecifier } from '../../spec'
import type { ParsedDirectoryPluginLockEntry } from '../../types'

import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'

import { parsePluginLockFile } from '../../lock'
import { install, resolve } from './index'

describe('local plugin source', () => {
  const tempRoots: string[] = []

  afterEach(async () => {
    await Promise.all(tempRoots.map(root => rm(root, { force: true, recursive: true })))
    tempRoots.length = 0
  })

  async function createTempProject(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'alint-plugin-package-'))
    tempRoots.push(root)
    return root
  }

  function createDirectorySpecifier(directory: string, raw = directory): DirectoryPluginSpecifier {
    return { directory, raw, type: 'directory' }
  }

  function createDirectoryLockEntry(
    cwd: string,
    specifier: DirectoryPluginSpecifier,
    path: string,
    alias = 'local',
  ): ParsedDirectoryPluginLockEntry {
    return {
      alias,
      cwd,
      lockEntry: {
        alias,
        path,
        specifier: specifier.raw,
        type: 'directory',
      },
      specifier,
      type: 'directory',
    }
  }

  async function writeDirectoryPackage(packageDir: string, entry = './dist/index.mjs'): Promise<void> {
    await mkdir(join(packageDir, 'dist'), { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      exports: { '.': entry },
      name: 'local-plugin',
      type: 'module',
    }), 'utf8')
    await writeFile(join(packageDir, 'dist', 'index.mjs'), 'export default { rules: { local: {} } }\n', 'utf8')
  }

  it('installs, resolves, and imports a directory package', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, 'plugins', 'local')
    await writeDirectoryPackage(packageDir)
    const specifier = createDirectorySpecifier(packageDir, './plugins/local')

    const lockEntry = await install({ alias: 'local', specifier })
    const resolved = await resolve(createDirectoryLockEntry(projectRoot, specifier, lockEntry.path))
    const physicalPackageDir = await realpath(packageDir)

    expect(lockEntry).toEqual({ path: physicalPackageDir, type: 'directory' })
    expect(resolved.entry).toBe(join(physicalPackageDir, 'dist', 'index.mjs'))
    expect(resolved.cache).toBe('content')
    expect(resolved.kind).toBe('module')
    expect(resolved.alias).toBe('local')
  })

  it('installs and resolves a declarative rule directory without package.json', async () => {
    const projectRoot = await createTempProject()
    const pluginRoot = join(projectRoot, 'rules', 'architecture')
    await mkdir(join(pluginRoot, 'semantic'), { recursive: true })
    await writeFile(join(pluginRoot, 'semantic', 'rule.alint.toml'), [
      'name = "semantic-boundary"',
      'builtInAgent = "basic-structured"',
      'instruction = "Find semantic boundary issues."',
    ].join('\n'), 'utf8')
    const specifier = createDirectorySpecifier(pluginRoot, './rules/architecture')

    const lockEntry = await install({ alias: 'arch', specifier })
    const resolved = await resolve(createDirectoryLockEntry(projectRoot, specifier, lockEntry.path, 'arch'))

    expect(lockEntry).toEqual({ path: await realpath(pluginRoot), type: 'directory' })
    expect(resolved.cache).toBe('content')
    expect(resolved.entry).toBe(await realpath(pluginRoot))
    expect(resolved.kind).toBe('declarative')
    expect(resolved.alias).toBe('arch')
  })

  it('rejects a directory without package.json or declarative rule files', async () => {
    const projectRoot = await createTempProject()
    const pluginRoot = join(projectRoot, 'rules', 'empty')
    await mkdir(pluginRoot, { recursive: true })

    await expect(install({
      alias: 'empty',
      specifier: createDirectorySpecifier(pluginRoot),
    }))
      .rejects
      .toThrow('Directory plugin "empty" must contain package.json or rule.alint.* files.')
  })

  it('rejects invalid declarative rule directories during install', async () => {
    const projectRoot = await createTempProject()
    const pluginRoot = join(projectRoot, 'rules', 'invalid')
    await mkdir(pluginRoot, { recursive: true })
    await writeFile(join(pluginRoot, 'rule.alint.toml'), [
      'name = "invalid"',
      'builtInAgent = "unknown-agent"',
      'instruction = "Find issues."',
    ].join('\n'), 'utf8')

    await expect(install({
      alias: 'invalid',
      specifier: createDirectorySpecifier(pluginRoot),
    }))
      .rejects
      .toThrow('Unknown builtInAgent "unknown-agent"')
  })

  it('resolves declarative rule directories without parsing rule content', async () => {
    const projectRoot = await createTempProject()
    const pluginRoot = join(projectRoot, 'rules', 'invalid')
    await mkdir(pluginRoot, { recursive: true })
    await writeFile(join(pluginRoot, 'rule.alint.toml'), [
      'name = "invalid"',
      'builtInAgent = "unknown-agent"',
      'instruction = "Find issues."',
    ].join('\n'), 'utf8')
    const specifier = createDirectorySpecifier(pluginRoot, './rules/invalid')

    const resolved = await resolve(createDirectoryLockEntry(projectRoot, specifier, await realpath(pluginRoot), 'invalid'))

    expect(resolved).toEqual({
      alias: 'invalid',
      cache: 'content',
      entry: await realpath(pluginRoot),
      kind: 'declarative',
    })
  })

  it('keeps package.json priority over declarative rule files', async () => {
    const projectRoot = await createTempProject()
    const pluginRoot = join(projectRoot, 'plugin')
    await writeDirectoryPackage(pluginRoot)
    await mkdir(join(pluginRoot, 'ignored-rule'), { recursive: true })
    await writeFile(join(pluginRoot, 'ignored-rule', 'rule.alint.toml'), [
      'name = "ignored"',
      'builtInAgent = "basic-structured"',
      'instruction = "This file is ignored because package.json wins."',
    ].join('\n'), 'utf8')
    const specifier = createDirectorySpecifier(pluginRoot)

    const lockEntry = await install({ alias: 'local', specifier })
    const resolved = await resolve(createDirectoryLockEntry(projectRoot, specifier, lockEntry.path))

    expect(resolved.kind).toBe('module')
    expect(resolved.entry).toBe(join(await realpath(pluginRoot), 'dist', 'index.mjs'))
  })

  it('installs a directory package without importing its root entry', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, 'plugin')
    const markerPath = join(projectRoot, 'entry-imported')
    await writeDirectoryPackage(packageDir)
    await writeFile(join(packageDir, 'dist', 'index.mjs'), `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(markerPath)}, '')
throw new Error('entry must not be imported during installation')
`, 'utf8')

    await expect(install({
      alias: 'local',
      specifier: createDirectorySpecifier(packageDir),
    }))
      .resolves
      .toMatchObject({ type: 'directory' })
    await expect(access(markerPath))
      .rejects
      .toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a missing directory package', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, 'missing')

    await expect(install({
      alias: 'local',
      specifier: createDirectorySpecifier(packageDir),
    }))
      .rejects
      .toThrow(`Directory plugin "local" does not exist at "${packageDir}".`)
  })

  it('rejects a directory package path that is a file', async () => {
    const projectRoot = await createTempProject()
    const packagePath = join(projectRoot, 'plugin.mjs')
    await writeFile(packagePath, 'export default {}\n', 'utf8')

    await expect(install({
      alias: 'local',
      specifier: createDirectorySpecifier(packagePath),
    }))
      .rejects
      .toThrow(`Directory plugin "local" path "${packagePath}" is not a directory.`)
  })

  it('rejects an invalid directory package manifest', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, 'plugin')
    await mkdir(packageDir)
    await writeFile(join(packageDir, 'package.json'), '{invalid', 'utf8')

    await expect(install({
      alias: 'local',
      specifier: createDirectorySpecifier(packageDir),
    }))
      .rejects
      .toThrow(`Directory plugin "local" has an unreadable or invalid package.json at "${join(await realpath(packageDir), 'package.json')}"`)
  })

  it('rejects a directory package without a root export', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, 'plugin')
    await mkdir(packageDir)
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: 'local-plugin' }), 'utf8')

    await expect(install({
      alias: 'local',
      specifier: createDirectorySpecifier(packageDir),
    }))
      .rejects
      .toThrow('Package "local-plugin" does not define a resolvable "." export.')
  })

  it('rejects a directory package with a missing build entry', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, 'plugin')
    await mkdir(packageDir)
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      exports: { '.': './dist/index.mjs' },
      name: 'local-plugin',
      type: 'module',
    }), 'utf8')

    await expect(install({
      alias: 'local',
      specifier: createDirectorySpecifier(packageDir),
    }))
      .rejects
      .toThrow('Directory plugin "local" entry "dist/index.mjs" does not exist. Build the package and try again.')
  })

  it('rejects an existing root entry that is not a regular file', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, 'plugin')
    await mkdir(join(packageDir, 'dist'), { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      exports: { '.': './dist' },
      name: 'local-plugin',
      type: 'module',
    }), 'utf8')

    await expect(install({
      alias: 'local',
      specifier: createDirectorySpecifier(packageDir),
    }))
      .rejects
      .toThrow('Directory plugin "local" entry "dist" is not a regular file.')
  })

  it('rejects a directory package whose export lexically escapes its root', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, 'plugin')
    await mkdir(packageDir)
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      exports: { '.': '../outside.mjs' },
      name: 'local-plugin',
      type: 'module',
    }), 'utf8')

    await expect(install({
      alias: 'local',
      specifier: createDirectorySpecifier(packageDir),
    }))
      .rejects
      .toThrow('Directory plugin "local" root export escapes the package directory.')
  })

  it('rejects a directory package whose entry symlink physically escapes its root', async () => {
    const projectRoot = await createTempProject()
    const outsideRoot = await createTempProject()
    const packageDir = join(projectRoot, 'plugin')
    await writeDirectoryPackage(packageDir)
    await writeFile(join(outsideRoot, 'index.mjs'), 'export default {}\n', 'utf8')
    await rm(join(packageDir, 'dist', 'index.mjs'))
    await symlink(join(outsideRoot, 'index.mjs'), join(packageDir, 'dist', 'index.mjs'), 'file')

    await expect(install({
      alias: 'local',
      specifier: createDirectorySpecifier(packageDir),
    }))
      .rejects
      .toThrow('Directory plugin "local" entry physically escapes the package directory.')
  })

  it('returns the physical path for an entry symlink contained by the package root', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, 'plugin')
    await writeDirectoryPackage(packageDir)
    const physicalEntry = join(packageDir, 'dist', 'physical.mjs')
    await writeFile(physicalEntry, 'export default { rules: {} }\n', 'utf8')
    await rm(join(packageDir, 'dist', 'index.mjs'))
    await symlink(physicalEntry, join(packageDir, 'dist', 'index.mjs'), 'file')
    const specifier = createDirectorySpecifier(packageDir)
    const lockEntry = await install({ alias: 'local', specifier })

    const resolved = await resolve(createDirectoryLockEntry(projectRoot, specifier, lockEntry.path))

    expect(resolved.entry).toBe(await realpath(physicalEntry))
  })

  it('rejects a retargeted config source through a parsed lock lookup', async () => {
    const projectRoot = await createTempProject()
    const firstRoot = await createTempProject()
    const secondRoot = await createTempProject()
    const linkPath = join(projectRoot, 'local-plugin')
    await writeDirectoryPackage(firstRoot)
    await writeDirectoryPackage(secondRoot)
    await symlink(firstRoot, linkPath, 'dir')
    const specifier = createDirectorySpecifier(linkPath, './local-plugin')
    const lockEntry = await install({ alias: 'local', specifier })
    const lock = parsePluginLockFile({
      plugins: {
        local: {
          alias: 'local',
          path: lockEntry.path,
          specifier: specifier.raw,
          type: 'directory',
        },
      },
      version: 2,
    }, { cwd: projectRoot })

    await rm(linkPath)
    await symlink(secondRoot, linkPath, 'dir')

    const parsedEntry = lock.get({ alias: 'local', specifier })

    if (parsedEntry.type !== 'directory') {
      throw new Error('Expected directory plugin lock entry fixture.')
    }

    await expect(resolve(parsedEntry))
      .rejects
      .toThrow('Directory plugin "local" has moved or its symlink target changed. Run: alint plugin install')
  })

  it('reports a non-missing configured directory realpath failure with its filesystem context', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, 'plugin')
    const loopPath = join(projectRoot, 'loop')
    await writeDirectoryPackage(packageDir)
    await symlink(loopPath, loopPath, 'dir')
    const originalSpecifier = createDirectorySpecifier(packageDir, './local-plugin')
    const lockEntry = await install({ alias: 'local', specifier: originalSpecifier })
    const currentSpecifier = createDirectorySpecifier(loopPath, './local-plugin')
    const lock = parsePluginLockFile({
      plugins: {
        local: {
          alias: 'local',
          path: lockEntry.path,
          specifier: originalSpecifier.raw,
          type: 'directory',
        },
      },
      version: 2,
    }, { cwd: projectRoot })

    const parsedEntry = lock.get({ alias: 'local', specifier: currentSpecifier })

    if (parsedEntry.type !== 'directory') {
      throw new Error('Expected directory plugin lock entry fixture.')
    }

    await expect(resolve(parsedEntry))
      .rejects
      .toMatchObject({
        cause: { code: 'ELOOP' },
        message: `Could not resolve configured directory plugin "local" at "${loopPath}".`,
      })
  })

  it('resolves changed source and export content within the locked physical root', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, 'plugin')
    await writeDirectoryPackage(packageDir)
    const specifier = createDirectorySpecifier(packageDir)
    const lockEntry = await install({ alias: 'local', specifier })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      exports: { '.': './dist/next.mjs' },
      name: 'local-plugin',
      type: 'module',
    }), 'utf8')
    await writeFile(join(packageDir, 'dist', 'next.mjs'), 'export default { rules: { next: {} } }\n', 'utf8')

    const resolved = await resolve(createDirectoryLockEntry(projectRoot, specifier, lockEntry.path))

    expect(resolved.entry).toBe(join(await realpath(packageDir), 'dist', 'next.mjs'))
  })
})

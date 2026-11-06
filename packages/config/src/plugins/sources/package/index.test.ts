import type { ParsedRegistryPluginLockEntry } from '../../types'

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { gzip } from 'node:zlib'

import tar from 'tar-stream'

import { createApp, defineEventHandler, serve, setResponseHeader, setResponseStatus } from 'h3/node'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'

import { install, resolve } from '.'
import { parsePluginSpecifier } from '../../spec'

describe('plugin package resolution', () => {
  const tempRoots: string[] = []
  const servers: Array<{ close: () => Promise<void>, registry: string, tarballRequests: () => number }> = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.close()))
    await Promise.all(tempRoots.map(root => rm(root, { force: true, recursive: true })))
    tempRoots.length = 0
  })

  async function createTempProject(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'alint-plugin-package-'))
    tempRoots.push(root)
    return root
  }

  function registrySpecifier() {
    const specifier = parsePluginSpecifier('@alint-js/plugin-python@0.3.1')
    if (specifier.type !== 'registry')
      throw new Error('Expected registry plugin specifier fixture.')
    return specifier
  }

  async function tarball(entries: Record<string, string>): Promise<Buffer> {
    const pack = tar.pack()
    const chunks: Buffer[] = []
    // `streamx` types `data` as `unknown`; `tar-stream` packs emit Buffers.
    pack.on('data', chunk => chunks.push(chunk as Buffer))
    for (const [name, content] of Object.entries(entries)) pack.entry({ name }, content)
    pack.finalize()
    await new Promise<void>((done, reject) => {
      pack.on('end', done)
      pack.on('error', reject)
    })
    return new Promise((done, reject) => gzip(Buffer.concat(chunks), (error, value) => error
      ? reject(error)
      : done(value)))
  }

  function integrity(value: Buffer, algorithm = 'sha512'): string {
    return `${algorithm}-${createHash(algorithm).update(value).digest('base64')}`
  }

  async function startRegistry(value: Buffer, digest: null | string = integrity(value)) {
    let requests = 0
    const app = createApp()
    app.get('/@alint-js%2fplugin-python', defineEventHandler((event) => {
      const host = event.req.headers.get('host')!
      setResponseHeader(event, 'content-type', 'application/json')
      return {
        versions: {
          '0.3.1': {
            dist: {
              ...(digest === null
                ? {}
                : { integrity: digest }),
              tarball: `http://${host}/plugin.tgz`,
            },
          },
        },
      }
    }))
    app.get('/plugin.tgz', defineEventHandler((event) => {
      requests += 1
      setResponseHeader(event, 'content-type', 'application/octet-stream')
      return value
    }))
    app.all('/**', defineEventHandler((event) => {
      setResponseStatus(event, 404)
      return 'not found'
    }))
    const server = await serve(app, { hostname: '127.0.0.1', port: 0, silent: true }).ready()
    const result = {
      close: () => server.close(true),
      registry: server.url!,
      tarballRequests: () => requests,
    }
    servers.push(result)
    return result
  }

  async function pluginTarball(): Promise<Buffer> {
    return tarball({
      'package/dist/index.mjs': 'export default { rules: {} }\n',
      'package/package.json': JSON.stringify({
        exports: { '.': './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        type: 'module',
        version: '0.3.1',
      }),
    })
  }

  function createParsedLockEntry(cwd: string, entry: string): ParsedRegistryPluginLockEntry {
    const specifier = parsePluginSpecifier('@alint-js/plugin-python@0.3.1')

    if (specifier.type !== 'registry') {
      throw new Error('Expected registry plugin specifier fixture.')
    }

    return {
      alias: 'python',
      cwd,
      lockEntry: {
        alias: 'python',
        entry,
        integrity: 'sha512-test',
        name: '@alint-js/plugin-python',
        registry: 'https://registry.npmjs.org/',
        specifier: '@alint-js/plugin-python@0.3.1',
        tarball: 'https://registry.npmjs.org/plugin.tgz',
        type: 'registry',
        version: '0.3.1',
      },
      specifier,
      type: 'registry',
    }
  }

  async function writeInstalledPackage(projectRoot: string): Promise<string> {
    const packageDir = join(projectRoot, '.alint', 'plugins', 'store', '@alint-js', 'plugin-python', '0.3.1', 'package')
    const distDir = join(packageDir, 'dist')
    await mkdir(distDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      exports: { '.': './dist/index.mjs' },
      name: '@alint-js/plugin-python',
      type: 'module',
      version: '0.3.1',
    }), 'utf8')
    await writeFile(join(distDir, 'index.mjs'), 'export default { rules: {} }\n', 'utf8')

    return packageDir
  }

  async function installFrom(projectRoot: string, registry: string) {
    return install({
      cwd: projectRoot,
      npmRegistry: registry,
      specifier: registrySpecifier(),
    })
  }

  it('downloads, extracts, and resolves the registry package root export', async () => {
    const projectRoot = await createTempProject()
    const value = await pluginTarball()
    const registry = await startRegistry(value)

    const installed = await installFrom(projectRoot, registry.registry)

    expect(installed.entry).toBe('.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs')
    expect(installed.integrity).toBe(integrity(value))
    expect(installed.registry).toBe(registry.registry)
    await expect(readFile(join(projectRoot, installed.entry), 'utf8')).resolves.toBe('export default { rules: {} }\n')
  })

  it('throws when the installed package has no resolvable root export', async () => {
    const projectRoot = await createTempProject()
    const registry = await startRegistry(await tarball({
      'package/package.json': JSON.stringify({ name: 'missing-export', type: 'module', version: '1.0.0' }),
    }))

    await expect(installFrom(projectRoot, registry.registry))
      .rejects
      .toThrow('Package "missing-export" does not define a resolvable "." export.')
  })

  it('rejects downloaded tarballs when npm integrity does not match', async () => {
    const projectRoot = await createTempProject()
    const registry = await startRegistry(await pluginTarball(), integrity(Buffer.from('different')))

    await expect(installFrom(projectRoot, registry.registry))
      .rejects
      .toThrow('Integrity mismatch for "@alint-js/plugin-python@0.3.1".')
  })

  it('rejects npm metadata without usable integrity before downloading', async () => {
    for (const digest of [null, '']) {
      const projectRoot = await createTempProject()
      const registry = await startRegistry(await pluginTarball(), digest)

      await expect(installFrom(projectRoot, registry.registry))
        .rejects
        .toThrow('Npm metadata for "@alint-js/plugin-python" does not include integrity for version 0.3.1.')
      expect(registry.tarballRequests()).toBe(0)
    }
  })

  it('rejects multiple-token integrity when the strongest supported digest does not match', async () => {
    const projectRoot = await createTempProject()
    const value = await pluginTarball()
    const digest = `${integrity(Buffer.from('different'))} ${integrity(value, 'sha256')}`
    const registry = await startRegistry(value, digest)

    await expect(installFrom(projectRoot, registry.registry))
      .rejects
      .toThrow('Integrity mismatch for "@alint-js/plugin-python@0.3.1".')
  })

  it('rejects tarball entries that escape the package directory', async () => {
    const projectRoot = await createTempProject()
    const registry = await startRegistry(await tarball({ 'package/../evil.txt': 'escape', 'package/package.json': '{}' }))

    await expect(installFrom(projectRoot, registry.registry))
      .rejects
      .toThrow('Plugin tarball entry "package/../evil.txt" escapes the package directory.')
  })

  it('keeps an existing package intact when a replacement has a missing export', async () => {
    const projectRoot = await createTempProject()
    const packageDir = await writeInstalledPackage(projectRoot)
    const existingEntry = join(packageDir, 'dist', 'index.mjs')
    await writeFile(existingEntry, 'existing\n', 'utf8')
    const registry = await startRegistry(await tarball({
      'package/dist/index.mjs': 'broken\n',
      'package/package.json': JSON.stringify({ name: '@alint-js/plugin-python', type: 'module', version: '0.3.1' }),
    }))

    await expect(installFrom(projectRoot, registry.registry)).rejects.toThrow('does not define a resolvable "." export')
    await expect(readFile(existingEntry, 'utf8')).resolves.toBe('existing\n')
  })

  it('resolves a locked package entry from the plugin store', async () => {
    const projectRoot = await createTempProject()
    const packageDir = await writeInstalledPackage(projectRoot)

    const resolved = await resolve(createParsedLockEntry(
      projectRoot,
      '.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs',
    ))

    expect(resolved.entry).toBe(join(packageDir, 'dist', 'index.mjs'))
    expect(resolved.cache).toBe('default')
  })

  it('resolves a locked package entry when its export path contains a package directory', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, '.alint', 'plugins', 'store', '@alint-js', 'plugin-python', '0.3.1', 'package')
    const distPackageDir = join(packageDir, 'dist', 'package')
    await mkdir(distPackageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      exports: { '.': './dist/package/index.mjs' },
      name: '@alint-js/plugin-python',
      type: 'module',
      version: '0.3.1',
    }), 'utf8')
    await writeFile(join(distPackageDir, 'index.mjs'), 'export default { rules: {} }\n', 'utf8')

    const resolved = await resolve(createParsedLockEntry(
      projectRoot,
      '.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/package/index.mjs',
    ))

    expect(resolved.entry).toBe(join(distPackageDir, 'index.mjs'))
    expect(resolved.cache).toBe('default')
  })

  it('rejects a lock entry that escapes the project root', async () => {
    const projectRoot = await createTempProject()

    await expect(resolve(createParsedLockEntry(projectRoot, '../outside/index.mjs')))
      .rejects
      .toThrow('Plugin lock entry "python" resolves outside the project root.')
  })

  it('rejects a lock entry that escapes through a symlink', async () => {
    const projectRoot = await createTempProject()
    const outsideRoot = await createTempProject()
    const linkPath = join(projectRoot, '.alint', 'plugins', 'store', 'linked')
    await mkdir(join(projectRoot, '.alint', 'plugins', 'store'), { recursive: true })
    await symlink(outsideRoot, linkPath, 'dir')

    await expect(resolve(createParsedLockEntry(projectRoot, '.alint/plugins/store/linked/package/dist/index.mjs')))
      .rejects
      .toThrow('Plugin lock entry "python" resolves outside the plugin store.')
  })

  it('rejects a lock entry that escapes the locked package through a store symlink', async () => {
    const projectRoot = await createTempProject()
    const pythonPackageDir = await writeInstalledPackage(projectRoot)
    const otherPackageDir = join(projectRoot, '.alint', 'plugins', 'store', '@alint-js', 'plugin-other', '1.0.0', 'package')
    const otherDistDir = join(otherPackageDir, 'dist')

    await rm(pythonPackageDir, { force: true, recursive: true })
    await mkdir(otherDistDir, { recursive: true })
    await writeFile(join(otherPackageDir, 'package.json'), JSON.stringify({
      exports: { '.': './dist/index.mjs' },
      name: '@alint-js/plugin-other',
      type: 'module',
      version: '1.0.0',
    }), 'utf8')
    await writeFile(join(otherDistDir, 'index.mjs'), 'export default { rules: {} }\n', 'utf8')
    await symlink(otherPackageDir, pythonPackageDir, 'dir')

    await expect(resolve(createParsedLockEntry(
      projectRoot,
      '.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs',
    )))
      .rejects
      .toThrow('Plugin lock entry "python" resolves outside the locked package directory.')
  })

  it('rejects a lock entry inside the plugins directory but outside the plugin store', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, '.alint', 'plugins', 'other', 'package')
    const distDir = join(packageDir, 'dist')
    await mkdir(join(projectRoot, '.alint', 'plugins', 'store'), { recursive: true })
    await mkdir(distDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      name: '@alint-js/plugin-python',
      type: 'module',
      version: '0.3.1',
    }), 'utf8')
    await writeFile(join(distDir, 'index.mjs'), 'export default { rules: {} }\n', 'utf8')

    await expect(resolve(createParsedLockEntry(
      projectRoot,
      '.alint/plugins/other/package/dist/index.mjs',
    )))
      .rejects
      .toThrow('Plugin lock entry "python" resolves outside the plugin store.')
  })
})

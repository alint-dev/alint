import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { gzip } from 'node:zlib'

import tar from 'tar-stream'

import { createApp, defineEventHandler, serve, setResponseHeader, setResponseStatus } from 'h3/node'
import { afterEach, describe, expect, it } from 'vitest'

import { loadAlintConfig } from '../config/load'
import { installStaticPlugins } from './install'

interface RegistryServer {
  close: () => Promise<void>
  metadataRequests: () => number
  registry: string
  tarballRequests: () => number
}

describe('static plugin installation', () => {
  const tempRoots: string[] = []
  const servers: RegistryServer[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.close()))
    await Promise.all(tempRoots.splice(0).map(root => rm(root, { force: true, recursive: true })))
  })

  async function createProject(config: string, configFile = 'alint.config.ts'): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'alint-plugin-install-'))
    tempRoots.push(root)
    const configPath = join(root, configFile)
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, config, 'utf8')
    return root
  }

  async function createTarball(entries: Record<string, string>): Promise<Buffer> {
    const pack = tar.pack()
    const chunks: Buffer[] = []

    // `streamx` types `data` as `unknown`; `tar-stream` packs emit Buffers.
    pack.on('data', chunk => chunks.push(chunk as Buffer))

    for (const [name, content] of Object.entries(entries)) {
      pack.entry({ name }, content)
    }

    pack.finalize()
    await new Promise<void>((resolve, reject) => {
      pack.on('end', resolve)
      pack.on('error', reject)
    })

    return new Promise((resolve, reject) => {
      gzip(Buffer.concat(chunks), (error, result) => {
        if (error) {
          reject(error)
          return
        }

        resolve(result)
      })
    })
  }

  function createIntegrity(tarball: Buffer, algorithm = 'sha512'): string {
    return `${algorithm}-${createHash(algorithm).update(tarball).digest('base64')}`
  }

  async function startRegistry(tarball: Buffer, integrity: null | string = createIntegrity(tarball)): Promise<RegistryServer> {
    let metadataRequests = 0
    let tarballRequests = 0

    const app = createApp()

    app.get('/@alint-js%2fplugin-python', defineEventHandler((event) => {
      const host = event.req.headers.get('host')

      if (host === null) {
        setResponseStatus(event, 400)
        return 'missing host'
      }

      metadataRequests += 1
      setResponseHeader(event, 'content-type', 'application/json')
      return {
        versions: {
          '0.3.1': {
            dist: {
              ...(integrity === null
                ? {}
                : { integrity }),
              tarball: `http://${host}/plugin-python-0.3.1.tgz`,
            },
          },
        },
      }
    }))

    app.get('/plugin-python-0.3.1.tgz', defineEventHandler((event) => {
      tarballRequests += 1
      setResponseHeader(event, 'content-type', 'application/octet-stream')
      return tarball
    }))

    app.all('/**', defineEventHandler((event) => {
      setResponseStatus(event, 404)
      return 'not found'
    }))

    const server = await serve(app, {
      hostname: '127.0.0.1',
      port: 0,
      silent: true,
    }).ready()

    const registry = server.url!
    servers.push({
      close: () => server.close(true),
      metadataRequests: () => metadataRequests,
      registry,
      tarballRequests: () => tarballRequests,
    })

    return servers.at(-1)!
  }

  async function createPluginTarball(): Promise<Buffer> {
    return createTarball({
      'package/dist/index.mjs': 'export default { rules: {} }\n',
      'package/package.json': JSON.stringify({
        exports: { '.': './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        type: 'module',
        version: '0.3.1',
      }),
    })
  }

  async function createDirectoryPlugin(projectRoot: string, name = 'local-plugin'): Promise<string> {
    const pluginRoot = join(projectRoot, 'plugins', name)
    await mkdir(join(pluginRoot, 'dist'), { recursive: true })
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
      exports: { '.': './dist/index.mjs' },
      name,
      type: 'module',
      version: '1.0.0',
    }), 'utf8')
    await writeFile(join(pluginRoot, 'dist', 'index.mjs'), 'export default { rules: {} }\n', 'utf8')
    return pluginRoot
  }

  it('installs a local TOML plugin without accessing the registry or plugin store', async () => {
    const projectRoot = await createProject(`
[[config.group]]
[config.group.plugins]
local = "./plugins/local-plugin"
`, 'alint.config.toml')
    const pluginRoot = await createDirectoryPlugin(projectRoot)

    const result = await installStaticPlugins({ cwd: projectRoot, registry: 'http://127.0.0.1:1/' })

    expect(result.configuredPluginCount).toBe(1)
    expect(result.installedPackageCount).toBe(0)
    expect(result.installedLocalDirectoryCount).toBe(1)
    expect(result.lock.plugins.local).toEqual({
      alias: 'local',
      path: relative(projectRoot, pluginRoot),
      specifier: './plugins/local-plugin',
      type: 'directory',
    })
    await expect(access(join(projectRoot, '.alint', 'plugins', 'store')))
      .rejects
      .toMatchObject({ code: 'ENOENT' })
  })

  it('resolves a nested config directory source while keeping project-root lock identity', async () => {
    const projectRoot = await createProject(`
[[config.group]]
[config.group.plugins]
local = "../plugins/local-plugin"
`, join('configs', 'alint.config.toml'))
    const pluginRoot = await createDirectoryPlugin(projectRoot)

    const result = await installStaticPlugins({
      configFile: join('configs', 'alint.config.toml'),
      cwd: projectRoot,
      registry: 'http://127.0.0.1:1/',
    })

    expect(result.lock.plugins.local).toEqual({
      alias: 'local',
      path: relative(projectRoot, pluginRoot),
      specifier: '../plugins/local-plugin',
      type: 'directory',
    })
    await expect(readFile(join(projectRoot, '.alint', 'plugins', 'lock.json'), 'utf8')).resolves.toContain('"local"')
    await expect(loadAlintConfig(projectRoot, join('configs', 'alint.config.toml'))).resolves.toEqual([
      {
        plugins: {
          local: { rules: {} },
        },
      },
    ])
  })

  it('deduplicates aliases that reach one physical directory through a symlink', async () => {
    const projectRoot = await createProject(`
export default [{ plugins: {
  direct: './plugins/local-plugin',
  linked: './plugins/local-link',
} }]
`)
    const pluginRoot = await createDirectoryPlugin(projectRoot)
    await symlink(pluginRoot, join(projectRoot, 'plugins', 'local-link'), 'dir')

    const result = await installStaticPlugins({ cwd: projectRoot })

    expect(result.installedLocalDirectoryCount).toBe(1)
    expect(result.lock.plugins.direct).toMatchObject({
      path: relative(projectRoot, pluginRoot),
      type: 'directory',
    })
    expect(result.lock.plugins.linked).toEqual({
      alias: 'linked',
      path: relative(projectRoot, pluginRoot),
      specifier: './plugins/local-link',
      type: 'directory',
    })
    expect(Object.keys(result.lock.plugins)).toEqual(['direct', 'linked'])
    await expect(loadAlintConfig(projectRoot)).resolves.toEqual([
      {
        plugins: {
          direct: { rules: {} },
          linked: { rules: {} },
        },
      },
    ])
  })

  it('treats path traversal syntax as a directory source without escaping the plugin store', async () => {
    const projectRoot = await createProject(`
export default [
  { plugins: { python: '../../outside@1.0.0' } },
]
`)
    const escapedPath = join(projectRoot, '.alint', 'outside')

    await expect(installStaticPlugins({ cwd: projectRoot }))
      .rejects
      .toThrow('Directory plugin "python" does not exist')
    await expect(access(escapedPath))
      .rejects
      .toMatchObject({ code: 'ENOENT' })
  })

  it('downloads each repeated package specifier once while locking every alias', async () => {
    const projectRoot = await createProject(`
export default [
  { plugins: { python: '@alint-js/plugin-python@0.3.1' } },
  { plugins: { py: '@alint-js/plugin-python@0.3.1' } },
]
`)
    const registry = await startRegistry(await createPluginTarball())

    const result = await installStaticPlugins({ cwd: projectRoot, registry: registry.registry })

    expect(result.installedPackageCount).toBe(1)
    expect(registry.metadataRequests()).toBe(1)
    expect(registry.tarballRequests()).toBe(1)
    expect(Object.keys(result.lock.plugins)).toEqual(['python', 'py'])
    expect(result.lock.plugins.python).toMatchObject({
      entry: result.lock.plugins.py?.type === 'registry'
        ? result.lock.plugins.py.entry
        : undefined,
      type: 'registry',
    })
  })

  it('writes the complete registry lock entry from the installed source result', async () => {
    const projectRoot = await createProject(`
export default [{ plugins: { python: '@alint-js/plugin-python@0.3.1' } }]
`)
    const value = await createPluginTarball()
    const registry = await startRegistry(value)

    const result = await installStaticPlugins({ cwd: projectRoot, registry: registry.registry })
    const written = JSON.parse(await readFile(join(projectRoot, '.alint', 'plugins', 'lock.json'), 'utf8')) as { plugins: Record<string, unknown> }
    const expected = {
      alias: 'python',
      entry: '.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs',
      integrity: createIntegrity(value),
      name: '@alint-js/plugin-python',
      registry: registry.registry,
      specifier: '@alint-js/plugin-python@0.3.1',
      tarball: `${registry.registry}plugin-python-0.3.1.tgz`,
      type: 'registry',
      version: '0.3.1',
    }

    expect(result.lock.plugins.python).toEqual(expected)
    expect(written.plugins.python).toEqual(expected)
  })

  it('counts mixed registry and canonical directory sources once while locking every alias', async () => {
    const projectRoot = await createProject(`
export default [{ plugins: {
  python: '@alint-js/plugin-python@0.3.1',
  local: './plugins/local-plugin',
  localAgain: './plugins/../plugins/local-plugin',
} }]
`)
    await createDirectoryPlugin(projectRoot)
    const registry = await startRegistry(await createPluginTarball())

    const result = await installStaticPlugins({ cwd: projectRoot, registry: registry.registry })

    expect(result.configuredPluginCount).toBe(3)
    expect(result.installedPackageCount).toBe(1)
    expect(result.installedLocalDirectoryCount).toBe(1)
    expect(registry.metadataRequests()).toBe(1)
    expect(Object.keys(result.lock.plugins)).toEqual(['python', 'local', 'localAgain'])
  })

  it('does not replace an existing lock when any configured source fails', async () => {
    const projectRoot = await createProject(`
export default [{ plugins: {
  local: './plugins/local-plugin',
  missing: './plugins/missing',
} }]
`)
    await createDirectoryPlugin(projectRoot)
    const lockPath = join(projectRoot, '.alint', 'plugins', 'lock.json')
    await mkdir(join(lockPath, '..'), { recursive: true })
    await writeFile(lockPath, '{"existing":true}\n', 'utf8')

    await expect(installStaticPlugins({ cwd: projectRoot })).rejects.toThrow('does not exist')
    await expect(readFile(lockPath, 'utf8')).resolves.toBe('{"existing":true}\n')
  })

  it('writes an empty lock file when there are no static plugin references', async () => {
    const projectRoot = await createProject('export default [{ rules: {} }]\n')

    const result = await installStaticPlugins({ cwd: projectRoot })
    const lock = JSON.parse(await readFile(join(projectRoot, '.alint', 'plugins', 'lock.json'), 'utf8')) as unknown

    expect(result.installedPackageCount).toBe(0)
    expect(result.installedLocalDirectoryCount).toBe(0)
    expect(result.configuredPluginCount).toBe(0)
    expect(lock).toEqual({ plugins: {}, version: 2 })
  })
})

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolveConfigForFile } from '@alint-js/core'
import { describe, expect, it } from 'vitest'

import { loadAlintConfig, loadStaticConfig } from './load'

function createLockEntry(alias: string, specifier: string, entry: string) {
  const name = specifier.slice(0, specifier.lastIndexOf('@'))
  const version = specifier.slice(specifier.lastIndexOf('@') + 1)

  return {
    alias,
    entry,
    integrity: 'sha512-test',
    name,
    registry: 'https://registry.npmjs.org/',
    specifier,
    tarball: 'https://registry.npmjs.org/plugin.tgz',
    type: 'registry' as const,
    version,
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
  await writeFile(join(distDir, 'index.mjs'), 'export default { rules: { "semantic-boundary": {} } }\n', 'utf8')

  return packageDir
}

async function writePluginLock(root: string, plugins: Record<string, unknown>): Promise<void> {
  const lockDir = join(root, '.alint', 'plugins')
  await mkdir(lockDir, { recursive: true })
  await writeFile(join(lockDir, 'lock.json'), JSON.stringify({ plugins, version: 2 }), 'utf8')
}

describe('loadAlintConfig', () => {
  it('loads TypeScript-only config syntax through the bundled jiti transform', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-ts-transform-'))
    await writeFile(join(cwd, 'alint.config.ts'), `
const config = [
  {
    files: ['**/*.ts'],
    rules: { 'review/typescript': 'warn' },
  },
] satisfies unknown[]

export default config
`)

    const config = await loadAlintConfig(cwd)

    expect(config).toEqual([
      {
        files: ['**/*.ts'],
        rules: { 'review/typescript': 'warn' },
      },
    ])
  })

  it('loads configs authored through the CLI facade', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-cli-facade-'))
    const cliEntryUrl = pathToFileURL(join(import.meta.dirname, '../../../cli/src/index.ts')).href

    await writeFile(join(cwd, 'alint.config.ts'), `
import { defineConfig, ignorePatternsAIAgents, ignorePatternsCommon } from ${JSON.stringify(cliEntryUrl)}

export default defineConfig([
  {
    name: 'test/global-ignores',
    ignores: [
      ...ignorePatternsCommon,
      ...ignorePatternsAIAgents,
    ],
  },
])
`)

    await mkdir(join(cwd, 'src'))
    const config = await loadAlintConfig(cwd)

    expect(config).toEqual([
      {
        ignores: expect.arrayContaining([
          '**/node_modules/**',
          '**/.agents/**',
        ]),
        name: 'test/global-ignores',
      },
    ])
  })

  it('returns an empty flat config when no config file exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-missing-'))
    const config = await loadAlintConfig(cwd)

    expect(config).toEqual([])
  })

  it('loads TOML config.group as flat config', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-toml-'))
    await writeFile(
      join(cwd, 'alint.config.toml'),
      `
[[config.group]]
name = "python"
files = ["**/*.py"]

[config.group.rules]
"python/semantic-boundary" = "warn"
`,
    )

    const config = await loadAlintConfig(cwd)

    expect(config).toEqual([
      {
        files: ['**/*.py'],
        name: 'python',
        rules: { 'python/semantic-boundary': 'warn' },
      },
    ])
  })

  it('reports static plugin references missing from the lock file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-missing-lock-'))
    await writeFile(join(cwd, 'alint.config.toml'), `
[[config.group]]
name = "python"

[config.group.plugins]
python = "@alint-js/plugin-python@0.3.1"
`)

    await expect(loadAlintConfig(cwd))
      .rejects
      .toThrow('Static plugin references are missing from the lock file: python (@alint-js/plugin-python@0.3.1).\nRun: alint plugin install')
  })

  it('reports locked static plugin references whose package cannot be resolved', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-unresolved-lock-'))
    await writeFile(join(cwd, 'alint.config.toml'), `
[[config.group]]
name = "python"

[config.group.plugins]
python = "@alint-js/plugin-python@0.3.1"
`)
    await mkdir(join(cwd, '.alint', 'plugins', 'store'), { recursive: true })
    await writePluginLock(cwd, {
      python: createLockEntry(
        'python',
        '@alint-js/plugin-python@0.3.1',
        '.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs',
      ),
    })

    await expect(loadAlintConfig(cwd))
      .rejects
      .toThrow('Static plugins could not be resolved from the lock file: python (@alint-js/plugin-python@0.3.1).\nRun: alint plugin install')
  })

  it('surfaces the specific missing build output for a locked directory plugin', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-local-unbuilt-'))
    const pluginRoot = join(cwd, 'plugins', 'local')
    await mkdir(pluginRoot, { recursive: true })
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
      exports: { '.': './dist/index.mjs' },
      name: 'local',
      type: 'module',
      version: '1.0.0',
    }))
    await writeFile(join(cwd, 'alint.config.toml'), `
[[config.group]]
[config.group.plugins]
local = "./plugins/local"
`)
    await writePluginLock(cwd, {
      local: { alias: 'local', path: pluginRoot, specifier: './plugins/local', type: 'directory' },
    })

    try {
      await loadAlintConfig(cwd)
      expect.fail('Expected directory plugin loading to fail.')
    }
    catch (error) {
      expect(error).toBeInstanceOf(Error)

      if (!(error instanceof Error)) {
        throw error
      }

      expect(error.message).toContain('Run: alint plugin install')
      expect(error.cause).toBeInstanceOf(Error)

      if (!(error.cause instanceof Error)) {
        throw error
      }

      expect(error.cause.message).toBe('Directory plugin "local" entry "dist/index.mjs" does not exist. Build the package and try again.')
    }
  })

  it('imports installed locked static plugin packages', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-installed-lock-'))
    const packageDir = await writeInstalledPackage(cwd)
    await writeFile(join(cwd, 'alint.config.toml'), `
[[config.group]]
name = "python"

[config.group.plugins]
python = "@alint-js/plugin-python@0.3.1"
`)
    await writePluginLock(cwd, {
      python: createLockEntry(
        'python',
        '@alint-js/plugin-python@0.3.1',
        join(packageDir, 'dist', 'index.mjs'),
      ),
    })

    const config = await loadAlintConfig(cwd)

    expect(config).toEqual([
      {
        name: 'python',
        plugins: {
          python: {
            rules: {
              'semantic-boundary': {},
            },
          },
        },
      },
    ])
  })

  it('imports current directory plugin content without reinstalling', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-live-local-'))
    const pluginRoot = join(cwd, 'plugins', 'local')
    await mkdir(join(pluginRoot, 'dist'), { recursive: true })
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ exports: { '.': './dist/index.mjs' }, name: 'local', type: 'module' }))
    const entry = join(pluginRoot, 'dist', 'index.mjs')
    await writeFile(entry, 'export default { rules: { first: {} } }\n')
    await writeFile(join(cwd, 'alint.config.toml'), `[[config.group]]\n[config.group.plugins]\nlocal = "./plugins/local"\n`)
    await writePluginLock(cwd, { local: { alias: 'local', path: pluginRoot, specifier: './plugins/local', type: 'directory' } })

    expect(await loadAlintConfig(cwd)).toEqual([{ plugins: { local: { rules: { first: {} } } } }])
    await writeFile(entry, 'export default { rules: { second: {} } }\n')
    expect(await loadAlintConfig(cwd)).toEqual([{ plugins: { local: { rules: { second: {} } } } }])
  })

  it('loads declarative structured rules from a static TOML config and lockfile', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-declarative-local-'))
    const pluginRoot = join(cwd, 'rules', 'architecture')
    const sourcePath = join(cwd, 'src', 'main.py')
    await mkdir(join(pluginRoot, 'semantic'), { recursive: true })
    await mkdir(join(cwd, 'src'), { recursive: true })
    await writeFile(join(pluginRoot, 'semantic', 'rule.alint.toml'), [
      'name = "semantic-boundary"',
      'builtInAgent = "basic-structured"',
      'instruction = "Find semantic boundary issues."',
      'includeFiles = ["src/**/*.py"]',
    ].join('\n'), 'utf8')
    await writeFile(sourcePath, 'def main():\n    return 1\n')
    await writeFile(join(cwd, 'alint.config.toml'), `
[[config.group]]
files = ["src/**/*.py"]
language = "plaintext"

[config.group.plugins]
arch = "./rules/architecture"

[config.group.rules]
"arch/semantic-boundary" = "warn"
`)
    await writePluginLock(cwd, {
      arch: { alias: 'arch', path: pluginRoot, specifier: './rules/architecture', type: 'directory' },
    })

    const config = await loadAlintConfig(cwd)

    expect(config).toMatchObject([
      {
        files: ['src/**/*.py'],
        plugins: {
          arch: {
            rules: {
              'semantic-boundary': { cache: false },
            },
          },
        },
      },
    ])
  })

  it('reports malformed declarative local plugin content without reinstall guidance', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-declarative-local-invalid-'))
    const pluginRoot = join(cwd, 'rules', 'architecture')
    await mkdir(pluginRoot, { recursive: true })
    await writeFile(join(pluginRoot, 'rule.alint.toml'), [
      'name = "semantic-boundary"',
      'builtInAgent = "unknown-agent"',
      'instruction = "Find semantic boundary issues."',
    ].join('\n'), 'utf8')
    await writeFile(join(cwd, 'alint.config.toml'), `
[[config.group]]

[config.group.plugins]
arch = "./rules/architecture"
`)
    await writePluginLock(cwd, {
      arch: { alias: 'arch', path: pluginRoot, specifier: './rules/architecture', type: 'directory' },
    })

    try {
      await loadAlintConfig(cwd)
      expect.fail('Expected declarative plugin loading to fail.')
    }
    catch (error) {
      expect(error).toBeInstanceOf(Error)

      if (!(error instanceof Error)) {
        throw error
      }

      expect(error.message).toContain('Unknown builtInAgent "unknown-agent"')
      expect(error.message).not.toContain('Run: alint plugin install')
      expect(error.message).not.toContain('Static plugins could not be resolved')
    }
  })

  it('loads JS config with plugin objects when the lock file is malformed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-plugin-object-malformed-lock-'))
    await writeFile(join(cwd, 'alint.config.mjs'), `
export default [
  {
    plugins: {
      local: { rules: { example: {} } },
    },
  },
]
`)
    await mkdir(join(cwd, '.alint', 'plugins'), { recursive: true })
    await writeFile(join(cwd, '.alint', 'plugins', 'lock.json'), '{', 'utf8')

    const config = await loadAlintConfig(cwd)

    expect(config).toEqual([
      {
        plugins: {
          local: {
            rules: {
              example: {},
            },
          },
        },
      },
    ])
  })

  it('merges a nested config and scopes it to its directory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-nested-'))
    await mkdir(join(cwd, 'packages', 'app', 'src'), { recursive: true })
    await mkdir(join(cwd, 'src'), { recursive: true })
    await writeFile(join(cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    plugins: { company: { rules: { shared: {} } } },
    rules: { 'company/shared': 'warn' },
  },
]
`)
    await writeFile(join(cwd, 'packages', 'app', 'alint.config.ts'), `
export default [
  {
    plugins: { app: { rules: { 'layer-boundary': {} } } },
    rules: { 'app/layer-boundary': 'error' },
  },
]
`)

    const config = await loadAlintConfig(cwd)
    const inside = resolveConfigForFile(join(cwd, 'packages', 'app', 'src', 'main.ts'), config, { cwd })
    const outside = resolveConfigForFile(join(cwd, 'src', 'main.ts'), config, { cwd })

    expect(config).toEqual([
      {
        files: ['**/*.ts'],
        plugins: { company: { rules: { shared: {} } } },
        rules: { 'company/shared': 'warn' },
      },
      {
        basePath: 'packages/app',
        directories: ['**'],
        files: ['**/*'],
        plugins: { app: { rules: { 'layer-boundary': {} } } },
        rules: { 'app/layer-boundary': 'error' },
      },
    ])
    expect(inside.config.rules).toEqual({
      'app/layer-boundary': 'error',
      'company/shared': 'warn',
    })
    expect(outside.config.rules).toEqual({ 'company/shared': 'warn' })
    expect(outside.ignored).toBe(false)
  })

  it('lets a nested config override an outer one for its own directory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-nested-override-'))
    await mkdir(join(cwd, 'packages', 'app'), { recursive: true })
    await writeFile(join(cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    plugins: { company: { rules: { shared: {} } } },
    rules: { 'company/shared': 'warn' },
  },
]
`)
    // A nested config can restate an outer item's rules: the plugin alias reaches it through the
    // outer item, which still matches the package's files.
    await writeFile(join(cwd, 'packages', 'app', 'alint.config.ts'), `
export default [
  {
    rules: { 'company/shared': 'off' },
  },
]
`)

    const config = await loadAlintConfig(cwd)
    const inside = resolveConfigForFile(join(cwd, 'packages', 'app', 'main.ts'), config, { cwd })

    expect(inside.config.rules).toEqual({ 'company/shared': 'off' })
  })

  it('orders nested configs from the outermost directory inwards', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-nested-order-'))
    await mkdir(join(cwd, 'packages', 'app', 'sub'), { recursive: true })
    await writeFile(join(cwd, 'alint.config.ts'), 'export default []\n')
    await writeFile(join(cwd, 'packages', 'app', 'alint.config.ts'), 'export default [{ name: \'app\' }]\n')
    await writeFile(join(cwd, 'packages', 'app', 'sub', 'alint.config.ts'), 'export default [{ name: \'sub\' }]\n')

    const config = await loadStaticConfig(cwd)

    expect(config.groups.map(group => group.item.basePath)).toEqual([
      'packages/app',
      'packages/app/sub',
    ])
  })

  it('ignores nested config files in hidden, dependency, and build directories', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-nested-skipped-'))
    await mkdir(join(cwd, '.config'), { recursive: true })
    await mkdir(join(cwd, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(cwd, 'dist', 'pkg'), { recursive: true })
    await writeFile(join(cwd, 'alint.config.ts'), 'export default []\n')

    for (const directory of ['.config', join('node_modules', 'pkg'), join('dist', 'pkg')]) {
      await writeFile(join(cwd, directory, 'alint.config.ts'), 'export default [{ name: \'skipped\' }]\n')
    }

    const config = await loadStaticConfig(cwd)

    expect(config.groups).toEqual([])
  })

  it('loads only the named config file when the caller passes one', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-explicit-'))
    await mkdir(join(cwd, 'packages', 'app'), { recursive: true })
    await writeFile(join(cwd, 'alint.config.ts'), 'export default [{ name: \'root\' }]\n')
    await writeFile(join(cwd, 'packages', 'app', 'alint.config.ts'), 'export default [{ name: \'nested\' }]\n')

    const config = await loadStaticConfig(cwd, 'packages/app/alint.config.ts')

    expect(config.groups.map(group => group.item.name)).toEqual(['nested'])
  })

  it('rejects one plugin alias pointing at different specifiers across config files', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-nested-alias-'))
    await mkdir(join(cwd, 'packages', 'app'), { recursive: true })
    await writeFile(join(cwd, 'alint.config.ts'), `
export default [
  { plugins: { local: './plugins/root' } },
]
`)
    await writeFile(join(cwd, 'packages', 'app', 'alint.config.ts'), `
export default [
  { plugins: { local: './plugins/app' } },
]
`)

    await expect(loadStaticConfig(cwd)).rejects.toThrow(
      /Static plugin "local" is configured in .* and .* with different specifiers/,
    )
  })

  it('does not treat a workspace package manifest as a config', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-nested-manifest-'))
    await mkdir(join(cwd, 'packages', 'app'), { recursive: true })
    await writeFile(join(cwd, 'alint.config.ts'), 'export default []\n')
    await writeFile(join(cwd, 'packages', 'app', 'package.json'), JSON.stringify({
      name: '@example/app',
      version: '1.0.0',
    }), 'utf8')
    await writeFile(join(cwd, 'packages', 'app', 'index.ts'), 'export const value = 1\n', 'utf8')

    const config = await loadStaticConfig(cwd)

    expect(config.groups).toEqual([])
  })
})

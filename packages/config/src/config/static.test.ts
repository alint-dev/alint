import { maximumStopGateTimeoutMs } from '@alint-js/core'
import { describe, expect, it } from 'vitest'

import {
  normalizeLoadedAlintConfig,
  parsePluginSpecifier,
  parseStaticConfig,
  toAlintConfig,
} from './static'

describe('static config parsing', () => {
  it('validates the Stop Gate repository activation', () => {
    expect(() => parseStaticConfig([
      {
        integrations: {
          stopGate: { enabled: 'yes' },
        },
      },
    ])).toThrow()

    expect(() => parseStaticConfig([
      {
        integrations: {
          stopGate: { enabled: true },
        },
      },
    ])).not.toThrow()
  })

  it('enforces the Stop Gate timeout budget in static config', () => {
    expect(() => parseStaticConfig([
      {
        integrations: {
          stopGate: { timeoutMs: maximumStopGateTimeoutMs + 1 },
        },
      },
    ])).toThrow()

    expect(() => parseStaticConfig([
      {
        integrations: {
          stopGate: { timeoutMs: maximumStopGateTimeoutMs },
        },
      },
    ])).not.toThrow()
  })

  it('parses static config groups and extracts string plugin references', () => {
    const config = parseStaticConfig(
      {
        config: {
          group: [
            {
              files: ['**/*.py'],
              plugins: {
                local: { rules: {} },
                python: '@alint-js/plugin-python@0.3.1',
              },
              rules: { 'python/semantic-boundary': 'warn' },
            },
          ],
        },
      },
      { configFile: '/repo/alint.config.toml' },
    )

    expect(config.groups).toHaveLength(1)
    expect(config.groups[0]?.plugins).toEqual([
      {
        alias: 'python',
        specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
      },
    ])
    expect(config.groups[0]?.item).toEqual({
      files: ['**/*.py'],
      plugins: {
        local: { rules: {} },
        python: '@alint-js/plugin-python@0.3.1',
      },
      rules: { 'python/semantic-boundary': 'warn' },
    })
    expect(config.groups[0]?.item.plugins?.python).toBe('@alint-js/plugin-python@0.3.1')
  })

  it('rejects repeated static plugin aliases with different specifiers while parsing', () => {
    expect(() => parseStaticConfig(
      {
        config: {
          group: [
            {
              plugins: { python: '@alint-js/plugin-python@0.3.1' },
            },
            {
              plugins: { python: '@alint-js/plugin-python@0.3.2' },
            },
          ],
        },
      },
      { configFile: '/repo/alint.config.toml' },
    )).toThrow(
      'Static plugin "python" is configured with multiple specifiers: "@alint-js/plugin-python@0.3.1" and "@alint-js/plugin-python@0.3.2".',
    )
  })

  it('accepts equivalent directory spellings for a repeated alias', () => {
    expect(() => parseStaticConfig([
      {
        plugins: { local: './plugins/local' },
      },
      {
        plugins: { local: './plugins/../plugins/local' },
      },
    ], { configFile: '/repo/alint.config.ts' })).not.toThrow()
  })

  it('accepts static rule entries with positional options', () => {
    const config = parseStaticConfig([
      {
        rules: {
          'company/review': [
            'warn',
            { maxLines: 20 },
          ],
        },
      },
    ])

    expect(config.groups).toEqual([
      {
        item: {
          rules: {
            'company/review': [
              'warn',
              { maxLines: 20 },
            ],
          },
        },
        plugins: [],
      },
    ])
  })

  it('rejects static plugin specifiers without an exact package version while parsing', () => {
    expect(() => parseStaticConfig([
      {
        plugins: { python: '@alint-js/plugin-python' },
      },
    ])).toThrow('Static plugin specifier "@alint-js/plugin-python" must include an exact package version.')
  })

  it('rejects invalid static plugin package names while parsing', () => {
    expect(() => parseStaticConfig([
      {
        plugins: { python: 'plugin/outside@1.0.0' },
      },
    ])).toThrow('Invalid static plugin package name "plugin/outside".')
  })

  it('rejects invalid static config item shapes while parsing', () => {
    expect(() => parseStaticConfig(
      {
        config: {
          group: [
            {
              files: '**/*.py',
            },
          ],
        },
      },
      { configFile: '/repo/alint.config.toml' },
    )).toThrow('Invalid type')
  })

  it('resolves parsed static plugin references', async () => {
    const plugin = { rules: {} }
    const config = await toAlintConfig(parseStaticConfig([
      {
        plugins: {
          python: '@alint-js/plugin-python@0.3.1',
        },
      },
    ]), {
      pluginResolver: async () => plugin,
    })

    expect(config).toEqual([
      {
        plugins: {
          python: plugin,
        },
      },
    ])
  })

  it('reuses resolved static plugins with the same specifier across aliases', async () => {
    const plugin = { rules: {} }
    const references: string[] = []
    const config = await toAlintConfig(parseStaticConfig([
      {
        plugins: {
          python: '@alint-js/plugin-python@0.3.1',
        },
      },
      {
        plugins: {
          py: '@alint-js/plugin-python@0.3.1',
        },
      },
    ]), {
      pluginResolver: async (reference) => {
        references.push(reference.alias)
        return plugin
      },
    })

    expect(references).toEqual(['python'])
    expect(config).toEqual([
      {
        plugins: {
          python: plugin,
        },
      },
      {
        plugins: {
          py: plugin,
        },
      },
    ])
  })

  it('reuses resolved directory plugins with equivalent normalized paths', async () => {
    const plugin = { rules: {} }
    const references: string[] = []
    const config = parseStaticConfig([
      {
        plugins: { local: './plugins/local' },
      },
      {
        plugins: { other: './plugins/../plugins/local' },
      },
    ], { configFile: '/repo/alint.config.ts' })

    await toAlintConfig(config, {
      pluginResolver: async (reference) => {
        references.push(reference.specifier.raw)
        return plugin
      },
    })

    expect(references).toEqual(['./plugins/local'])
  })

  it('rejects unresolved static plugin strings during sync normalization', () => {
    expect(() => normalizeLoadedAlintConfig(
      [
        {
          plugins: {
            python: '@alint-js/plugin-python@0.3.1',
          },
        },
      ],
      {
        configFile: '/repo/alint.config.json',
      },
    )).toThrow('Static plugin "python" requires async plugin resolution.')
  })

  it('accepts nested top-level config arrays and flattens parsed groups', () => {
    const config = parseStaticConfig(
      [
        {
          name: 'root',
        },
        [
          {
            files: ['**/*.go'],
            rules: { 'go/responsibility-boundary': 'error' },
          },
        ],
      ],
      {
        configFile: '/repo/alint.config.ts',
      },
    )

    expect(config.groups).toEqual([
      {
        item: {
          name: 'root',
        },
        plugins: [],
      },
      {
        item: {
          files: ['**/*.go'],
          rules: { 'go/responsibility-boundary': 'error' },
        },
        plugins: [],
      },
    ])
  })

  it('keeps config.group validation flat', () => {
    expect(() => parseStaticConfig(
      {
        config: {
          group: [
            [
              {
                name: 'nested',
              },
            ],
          ],
        },
      },
      { configFile: '/repo/alint.config.toml' },
    )).toThrow('Invalid type')
  })

  it('rejects TOML config without config.group', () => {
    expect(() =>
      normalizeLoadedAlintConfig(
        {
          files: ['**/*.py'],
          rules: { 'python/semantic-boundary': 'warn' },
        },
        {
          configFile: '/repo/alint.config.toml',
        },
      ),
    ).toThrow('Static TOML config must use [[config.group]].')
  })

  it('rejects non-array config.group', () => {
    expect(() =>
      normalizeLoadedAlintConfig(
        {
          config: {
            group: {
              files: ['**/*.py'],
            },
          },
        },
        {
          configFile: '/repo/alint.config.yaml',
        },
      ),
    ).toThrow('Static config field "config.group" must be an array.')
  })
})

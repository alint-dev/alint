import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadSetupConfig, mergeSetupConfigs } from './load'
import { writeSetupConfig } from './write'

describe('setup config loading and merging', () => {
  it('merges ACP-driven provider models by id with project models first', () => {
    const merged = mergeSetupConfigs(
      {
        providers: [
          {
            id: 'coding-agents',
            models: [
              { command: 'global-codex', driver: 'acp', id: 'codex' },
              { command: 'global-gemini', driver: 'acp', id: 'gemini' },
            ],
          },
        ],
        version: 1,
      },
      {
        providers: [
          {
            id: 'coding-agents',
            models: [
              {
                args: ['--project'],
                command: 'project-codex',
                driver: 'acp',
                id: 'codex',
              },
            ],
          },
        ],
        version: 1,
      },
    )

    expect(merged.providers[0]).toEqual({
      id: 'coding-agents',
      models: [
        {
          args: ['--project'],
          command: 'project-codex',
          driver: 'acp',
          id: 'codex',
        },
        { command: 'global-gemini', driver: 'acp', id: 'gemini' },
      ],
    })
  })

  it('allows ACP-driven models under different providers', () => {
    const merged = mergeSetupConfigs(
      {
        providers: [
          {
            id: 'global-acp',
            models: [
              { command: 'global-agent', driver: 'acp', id: 'global' },
            ],
          },
        ],
        version: 1,
      },
      {
        providers: [
          {
            id: 'project-acp',
            models: [
              { command: 'project-agent', driver: 'acp', id: 'project' },
            ],
          },
        ],
        version: 1,
      },
    )

    expect(merged.providers.map(provider => provider.id)).toEqual(['project-acp', 'global-acp'])
  })

  it('inherits an ACP driver when a later scope overrides only shared model fields', () => {
    const merged = mergeSetupConfigs(
      {
        providers: [
          {
            id: 'local',
            models: [
              {
                command: 'codex-acp',
                driver: 'acp',
                id: 'codex',
                name: 'Global Codex',
              },
            ],
          },
        ],
        version: 1,
      },
      {
        providers: [
          {
            id: 'local',
            models: [
              {
                aliases: ['default'],
                id: 'codex',
                name: 'Project Codex',
              },
            ],
          },
        ],
        version: 1,
      },
    )

    expect(merged.providers[0]?.models[0]).toEqual({
      aliases: ['default'],
      command: 'codex-acp',
      driver: 'acp',
      id: 'codex',
      name: 'Project Codex',
    })
  })

  it('loads missing config files as an empty versioned config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-setup-'))
    const config = await loadSetupConfig(join(root, 'missing.toml'))
    expect(config).toEqual({ providers: [], version: 1 })
  })

  it('loads missing config files as separate objects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-setup-'))
    const firstConfig = await loadSetupConfig(join(root, 'missing.toml'))
    const secondConfig = await loadSetupConfig(join(root, 'missing.toml'))

    firstConfig.providers.push({
      endpoint: 'http://localhost:11434/v1',
      id: 'ollama',
      models: [],
      type: 'openai-compatible',
    })

    expect(secondConfig).toEqual({ providers: [], version: 1 })
  })

  it('merges providers by id and prioritizes project models before global models', () => {
    const merged = mergeSetupConfigs(
      {
        providers: [
          {
            endpoint: 'http://localhost:11434/v1',
            id: 'ollama',
            models: [
              { id: 'global:qwen', name: 'qwen:8b' },
            ],
            type: 'openai-compatible',
          },
        ],
        version: 1,
      },
      {
        providers: [
          {
            endpoint: 'http://localhost:11434/v1',
            id: 'ollama',
            models: [
              { id: 'project:qwen', name: 'qwen:32b' },
            ],
            type: 'openai-compatible',
          },
        ],
        version: 1,
      },
    )

    expect(merged.providers[0]?.models.map(model => model.id)).toEqual(['project:qwen', 'global:qwen'])
  })

  it('prioritizes project providers before global providers', () => {
    const merged = mergeSetupConfigs(
      {
        providers: [
          {
            endpoint: 'http://global.example/v1',
            id: 'global',
            models: [
              {
                capabilities: ['code-review'],
                id: 'global:qwen',
              },
            ],
            type: 'openai-compatible',
          },
        ],
        version: 1,
      },
      {
        providers: [
          {
            endpoint: 'http://project.example/v1',
            id: 'project',
            models: [
              {
                capabilities: ['code-review'],
                id: 'project:qwen',
              },
            ],
            type: 'openai-compatible',
          },
        ],
        version: 1,
      },
    )

    expect(merged.providers.map(provider => provider.id)).toEqual(['project', 'global'])
  })

  it('preserves earlier headers when later provider omits headers', () => {
    const merged = mergeSetupConfigs(
      {
        providers: [
          {
            endpoint: 'http://localhost:11434/v1',
            headers: { Authorization: 'Bearer global' },
            id: 'ollama',
            models: [],
            type: 'openai-compatible',
          },
        ],
        version: 1,
      },
      {
        providers: [
          {
            endpoint: 'http://localhost:11434/v1',
            id: 'ollama',
            models: [],
            type: 'openai-compatible',
          },
        ],
        version: 1,
      },
    )

    expect(merged.providers[0]?.headers).toEqual({ Authorization: 'Bearer global' })
  })

  it('merges later provider headers over earlier headers by key', () => {
    const merged = mergeSetupConfigs(
      {
        providers: [
          {
            endpoint: 'http://localhost:11434/v1',
            headers: {
              'Authorization': 'Bearer global',
              'X-Global': 'true',
            },
            id: 'ollama',
            models: [],
            type: 'openai-compatible',
          },
        ],
        version: 1,
      },
      {
        providers: [
          {
            endpoint: 'http://localhost:11434/v1',
            headers: {
              'Authorization': 'Bearer project',
              'X-Project': 'true',
            },
            id: 'ollama',
            models: [],
            type: 'openai-compatible',
          },
        ],
        version: 1,
      },
    )

    expect(merged.providers[0]?.headers).toEqual({
      'Authorization': 'Bearer project',
      'X-Global': 'true',
      'X-Project': 'true',
    })
  })

  it('overrides duplicate model metadata from later configs', () => {
    const merged = mergeSetupConfigs(
      {
        providers: [
          {
            endpoint: 'http://localhost:11434/v1',
            id: 'ollama',
            models: [
              {
                capabilities: ['structured-output'],
                defaultParams: { temperature: 0.1 },
                id: 'local:qwen',
                name: 'qwen:8b',
              },
            ],
            type: 'openai-compatible',
          },
        ],
        version: 1,
      },
      {
        providers: [
          {
            endpoint: 'http://localhost:11434/v1',
            id: 'ollama',
            models: [
              {
                capabilities: ['code-review'],
                defaultParams: { temperature: 0.2 },
                id: 'local:qwen',
                name: 'qwen:32b',
              },
            ],
            type: 'openai-compatible',
          },
        ],
        version: 1,
      },
    )

    expect(merged.providers[0]?.models).toEqual([
      {
        capabilities: ['code-review'],
        defaultParams: { temperature: 0.2 },
        id: 'local:qwen',
        name: 'qwen:32b',
      },
    ])
  })

  it('does not mutate input configs when merged result is mutated', () => {
    const globalConfig = {
      providers: [
        {
          endpoint: 'http://localhost:11434/v1',
          headers: { Authorization: 'Bearer global' },
          id: 'ollama',
          models: [
            {
              aliases: ['default'],
              capabilities: ['structured-output'],
              defaultParams: { temperature: 0.1 },
              id: 'global:qwen',
              name: 'qwen:8b',
            },
          ],
          type: 'openai-compatible' as const,
        },
      ],
      version: 1 as const,
    }

    const merged = mergeSetupConfigs(globalConfig)
    const provider = merged.providers[0]
    const model = provider?.models[0]

    if (provider?.headers === undefined || model === undefined) {
      throw new Error('Expected merged provider with headers and model.')
    }

    provider.endpoint = 'http://localhost:9999/v1'
    provider.headers.Authorization = 'Bearer changed'
    model.name = 'changed'
    model.aliases?.push('changed')
    model.capabilities?.push('changed')
    model.defaultParams!.temperature = 0.9

    expect(globalConfig.providers[0]).toEqual({
      endpoint: 'http://localhost:11434/v1',
      headers: { Authorization: 'Bearer global' },
      id: 'ollama',
      models: [
        {
          aliases: ['default'],
          capabilities: ['structured-output'],
          defaultParams: { temperature: 0.1 },
          id: 'global:qwen',
          name: 'qwen:8b',
        },
      ],
      type: 'openai-compatible',
    })
  })

  it('writes setup config as TOML', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-setup-'))
    const filePath = join(root, 'config.toml')
    await writeSetupConfig(filePath, {
      providers: [
        {
          endpoint: 'http://localhost:11434/v1',
          id: 'ollama',
          models: [
            { id: 'local:qwen', name: 'qwen:8b' },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    })

    await writeFile(join(root, 'marker'), 'ok')
    const text = await readFile(filePath, 'utf8')
    expect(text).toContain('id = "ollama"')
    expect(text).toContain('id = "local:qwen"')
  })
})

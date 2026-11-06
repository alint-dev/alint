import { describe, expect, it } from 'vitest'

import { parseSetupConfigToml, stringifySetupConfigToml } from './toml'

describe('setup TOML registry', () => {
  it('parses ACP-driven models without requiring a remote endpoint', () => {
    const config = parseSetupConfigToml(`
version = 1

[[providers]]
id = "coding-agents"

[[providers.models]]
id = "codex"
name = "Codex"
driver = "acp"
aliases = ["default"]
capabilities = ["tool-call"]
command = "codex-acp"
args = ["--profile", "alint"]
cwd = "."

[providers.models.env]
CODEX_HOME = "/tmp/codex"
`)

    expect(config).toEqual({
      providers: [
        {
          id: 'coding-agents',
          models: [
            {
              aliases: ['default'],
              args: ['--profile', 'alint'],
              capabilities: ['tool-call'],
              command: 'codex-acp',
              cwd: '.',
              driver: 'acp',
              env: { CODEX_HOME: '/tmp/codex' },
              id: 'codex',
              name: 'Codex',
            },
          ],
        },
      ],
      version: 1,
    })
  })

  it('stringifies ACP-driven provider models', () => {
    const toml = stringifySetupConfigToml({
      providers: [
        {
          id: 'acp',
          models: [
            {
              args: ['--acp'],
              command: 'coding-agent',
              driver: 'acp',
              env: { AGENT_PROFILE: 'review' },
              id: 'reviewer',
            },
          ],
        },
      ],
      version: 1,
    })

    expect(toml).toContain('[[providers.models]]')
    expect(toml).toContain('driver = "acp"')
    expect(toml).toContain('command = "coding-agent"')
    expect(toml).toContain('args = [ "--acp" ]')
    expect(toml).toContain('[providers.models.env]')
    expect(toml).toContain('AGENT_PROFILE = "review"')
  })

  it('parses provider model fields from snake_case TOML', () => {
    const apiKeyVariable = '$' + '{OLLAMA_API_KEY}'
    const config = parseSetupConfigToml(`
version = 1

[[providers]]
id = "ollama"
type = "openai-compatible"
endpoint = "http://localhost:11434/v1"

[providers.headers]
Authorization = "Bearer ${apiKeyVariable}"

[[providers.models]]
id = "local:qwen-8b"
name = "qwen:8b"
aliases = ["default", "local"]
capabilities = ["code-review", "structured-output"]
size = "small"
context_window = 32768

[providers.models.default_params]
temperature = 0.1
max_tokens = 2048
`)

    expect(config).toEqual({
      providers: [
        {
          endpoint: 'http://localhost:11434/v1',
          headers: {
            Authorization: `Bearer ${apiKeyVariable}`,
          },
          id: 'ollama',
          models: [
            {
              aliases: ['default', 'local'],
              capabilities: ['code-review', 'structured-output'],
              contextWindow: 32768,
              defaultParams: {
                max_tokens: 2048,
                temperature: 0.1,
              },
              id: 'local:qwen-8b',
              name: 'qwen:8b',
              size: 'small',
            },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    })
  })

  it('stringifies camelCase model fields to snake_case TOML', () => {
    const toml = stringifySetupConfigToml({
      providers: [
        {
          endpoint: 'http://localhost:11434/v1',
          id: 'ollama',
          models: [
            {
              contextWindow: 32768,
              defaultParams: {
                temperature: 0.1,
              },
              id: 'local:qwen-8b',
              name: 'qwen:8b',
            },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    })

    expect(toml).toContain('context_window = 32768')
    expect(toml).toContain('[providers.models.default_params]')
    expect(toml).toContain('temperature = 0.1')
  })

  it('parses runner settings from setup TOML', () => {
    const config = parseSetupConfigToml(`
version = 1

[runner]
agent_retries = 0
rule_concurrency = 20
timeout_ms = 120000

[[providers]]
id = "local"
type = "openai-compatible"
endpoint = "http://localhost:11434/v1"

[[providers.models]]
id = "qwen"
`)

    expect(config.runner).toEqual({
      agentRetries: 0,
      ruleConcurrency: 20,
      timeoutMs: 120000,
    })
  })

  it('stringifies runner settings to setup TOML', () => {
    const toml = stringifySetupConfigToml({
      providers: [
        {
          endpoint: 'http://localhost:11434/v1',
          id: 'local',
          models: [
            { id: 'qwen' },
          ],
          type: 'openai-compatible',
        },
      ],
      runner: {
        agentRetries: 2,
        ruleConcurrency: 20,
        timeoutMs: 120000,
      },
      version: 1,
    })

    expect(toml).toContain('[runner]')
    expect(toml).toContain('agent_retries = 2')
    expect(toml).toContain('rule_concurrency = 20')
    expect(toml).toContain('timeout_ms = 120000')
  })

  it('parses and stringifies runner cache settings', () => {
    const config = parseSetupConfigToml([
      'version = 1',
      '',
      '[runner.cache]',
      'enabled = false',
      'location = ".cache/alint.json"',
      '',
      '[[providers]]',
      'id = "ollama"',
      'type = "openai-compatible"',
      'endpoint = "http://localhost:11434/v1"',
      '',
      '[[providers.models]]',
      'id = "qwen:8b"',
    ].join('\n'))

    expect(config.runner?.cache).toEqual({
      enabled: false,
      location: '.cache/alint.json',
    })

    expect(stringifySetupConfigToml(config)).toContain('[runner.cache]')
    expect(stringifySetupConfigToml(config)).toContain('enabled = false')
    expect(stringifySetupConfigToml(config)).toContain(
      'location = ".cache/alint.json"',
    )
  })

  it('parses and stringifies runner stats settings', () => {
    const config = parseSetupConfigToml([
      'version = 1',
      '',
      '[runner.stats]',
      'enabled = false',
      'location = "/tmp/alint-stats"',
      'retention_months = 6',
      '',
      '[[providers]]',
      'id = "ollama"',
      'type = "openai-compatible"',
      'endpoint = "http://localhost:11434/v1"',
      '',
      '[[providers.models]]',
      'id = "qwen:8b"',
    ].join('\n'))

    expect(config.runner?.stats).toEqual({
      enabled: false,
      location: '/tmp/alint-stats',
      retentionMonths: 6,
    })

    const toml = stringifySetupConfigToml(config)
    expect(toml).toContain('[runner.stats]')
    expect(toml).toContain('enabled = false')
    expect(toml).toContain('location = "/tmp/alint-stats"')
    expect(toml).toContain('retention_months = 6')
  })

  it('rejects a non-integer runner stats retention', () => {
    expect(() => parseSetupConfigToml([
      'version = 1',
      '',
      '[runner.stats]',
      'retention_months = 0',
      '',
      '[[providers]]',
      'id = "local"',
      'type = "openai-compatible"',
      'endpoint = "http://localhost:11434/v1"',
      '',
      '[[providers.models]]',
      'id = "qwen"',
    ].join('\n'))).toThrow()
  })

  it('rejects invalid runner settings', () => {
    expect(() => parseSetupConfigToml(`
version = 1

[runner]
rule_concurrency = 0

[[providers]]
id = "local"
type = "openai-compatible"
endpoint = "http://localhost:11434/v1"

[[providers.models]]
id = "qwen"
`)).toThrow('Invalid runner rule_concurrency: must be a positive integer.')

    expect(() => parseSetupConfigToml(`
version = 1

[runner]
timeout_ms = 1.5

[[providers]]
id = "local"
type = "openai-compatible"
endpoint = "http://localhost:11434/v1"

[[providers.models]]
id = "qwen"
`)).toThrow('Invalid runner timeout_ms: must be a positive integer.')
  })

  it('does not map the removed per-file concurrency setting', () => {
    const removedSetting = ['file', 'concurrency'].join('_')
    const config = parseSetupConfigToml(`
version = 1

[runner]
${removedSetting} = 2

[[providers]]
id = "local"
type = "openai-compatible"
endpoint = "http://localhost:11434/v1"

[[providers.models]]
id = "qwen"
`)

    expect(config.runner).toEqual({})
  })

  it.each([-1, 1.5])('preserves finite runner agent retries: %s', (agentRetries) => {
    const config = parseSetupConfigToml(`
version = 1

[runner]
agent_retries = ${agentRetries}

[[providers]]
id = "local"
type = "openai-compatible"
endpoint = "http://localhost:11434/v1"

[[providers.models]]
id = "qwen"
`)

    expect(config.runner?.agentRetries).toBe(agentRetries)
  })

  it('rejects invalid provider types', () => {
    expect(() => parseSetupConfigToml(`
version = 1
[[providers]]
id = "bad"
models = []
type = "unknown"
endpoint = "http://localhost:9999/v1"
    `)).toThrow('Invalid type: Expected "openai-compatible" but received "unknown"')
  })

  it('requires a provider endpoint for models without a driver', () => {
    expect(() => parseSetupConfigToml(`
version = 1

[[providers]]
id = "remote"
type = "openai-compatible"

[[providers.models]]
id = "model"
`)).toThrow('Invalid provider "remote": endpoint is required for models without a driver.')
  })

  it('requires a command for ACP-driven models', () => {
    expect(() => parseSetupConfigToml(`
version = 1

[[providers]]
id = "local"

[[providers.models]]
id = "codex"
driver = "acp"
`)).toThrow('Invalid key: Expected "command" but received undefined')
  })
})

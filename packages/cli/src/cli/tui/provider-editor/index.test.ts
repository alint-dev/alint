import type { ProviderDefinition, SetupConfig } from '@alint-js/config'

import type { ModelOption, ProviderEditorPromptPort, ProviderEditorPromptResult } from './types'

import { describe, expect, it, vi } from 'vitest'

import { runProviderEditor } from './index'

const io = {
  cwd: '/workspace',
  stderr: {
    write: vi.fn(),
  },
  stdout: {
    write: vi.fn(),
  },
}

const source = {
  benchmarkConcurrency: 2,
  kind: 'openai-compatible' as const,
  label: 'Custom OpenAI-compatible provider',
  probeModels: true,
  value: 'custom' as const,
}

const back = { status: 'back' } as const
const cancelled = { status: 'cancelled' } as const

function submitted<T>(value: T): ProviderEditorPromptResult<T> {
  return { status: 'submitted', value }
}

const existingProvider: ProviderDefinition = {
  endpoint: 'https://old.example/v1',
  headers: {
    'Authorization': 'Bearer old-secret',
    'X-Keep': 'yes',
  },
  id: 'example',
  models: [
    {
      aliases: ['fast'],
      capabilities: ['code-review'],
      contextWindow: 32768,
      defaultParams: { temperature: 0.1 },
      id: 'existing',
      name: 'Existing',
      size: 'small',
    },
    {
      aliases: ['default'],
      id: 'missing',
      name: 'Missing',
    },
  ],
  type: 'openai-compatible',
}

const config: SetupConfig = {
  providers: [existingProvider],
  version: 1,
}

function createPromptPort(overrides: Partial<ProviderEditorPromptPort> = {}): ProviderEditorPromptPort {
  return {
    confirm: vi.fn(async () => submitted<'yes'>('yes')),
    defaultAction: vi.fn(async () => submitted<'no'>('no')),
    defaultModel: vi.fn(async () => cancelled),
    endpoint: vi.fn(async () => submitted('https://next.example/v1')),
    headerInput: vi.fn(async () => submitted('Authorization=Bearer replacement')),
    manualModels: vi.fn(async () => submitted(['manual'])),
    models: vi.fn(async (_options, initialValues) => submitted([...initialValues])),
    probe: vi.fn(async () => ['existing', 'new']),
    providerId: vi.fn(async initialValue => submitted(initialValue)),
    retainedHeaders: vi.fn(async (_names, initialValues) => submitted(initialValues)),
    ...overrides,
  }
}

describe('runProviderEditor', () => {
  it('creates an ACP provider from a setup preset without HTTP prompts', async () => {
    const promptPort = createPromptPort()

    const result = await runProviderEditor({
      config: { providers: [], version: 1 },
      io,
      mode: 'create',
      source: {
        args: ['--experimental-acp'],
        command: 'example-agent',
        defaultProviderId: 'example-acp',
        kind: 'acp',
        label: 'Example ACP agent',
        model: { id: 'example', name: 'Example Agent' },
        value: 'codexAcp',
      },
    }, promptPort)

    expect(result).toEqual({
      provider: {
        id: 'example-acp',
        models: [
          {
            args: ['--experimental-acp'],
            capabilities: ['tool-call'],
            command: 'example-agent',
            driver: 'acp',
            id: 'example',
            name: 'Example Agent',
          },
        ],
      },
      status: 'confirmed',
    })
    expect(promptPort.endpoint).not.toHaveBeenCalled()
    expect(promptPort.headerInput).not.toHaveBeenCalled()
    expect(promptPort.manualModels).not.toHaveBeenCalled()
    expect(promptPort.models).not.toHaveBeenCalled()
    expect(promptPort.probe).not.toHaveBeenCalled()
  })

  it('updates a provider without exposing secret values in prompts or the summary', async () => {
    const summaries: string[] = []
    const promptPort = createPromptPort({
      confirm: vi.fn(async (summary: string) => {
        summaries.push(summary)
        return submitted<'yes'>('yes')
      }),
    })

    const result = await runProviderEditor({
      config,
      existingProvider,
      io,
      mode: 'update',
      source,
    }, promptPort)

    expect(result.status).toBe('confirmed')
    if (result.status !== 'confirmed') {
      return
    }

    expect(result.provider.endpoint).toBe('https://next.example/v1')
    expect(result.provider.headers).toEqual({
      'Authorization': 'Bearer replacement',
      'X-Keep': 'yes',
    })
    expect(result.provider.models[0]).toEqual(existingProvider.models[0])
    expect(result.provider.models.at(-1)).toEqual({ id: 'new', name: 'new' })
    expect(promptPort.providerId).toHaveBeenCalledWith('example', false)
    expect(promptPort.headerInput).toHaveBeenCalledWith()
    expect(summaries[0]).toContain('Headers: Authorization, X-Keep')
    expect(summaries[0]).toContain('Added models: new')
    expect(summaries[0]).not.toContain('old-secret')
    expect(summaries[0]).not.toContain('replacement')
  })

  it('returns cancellation without producing a provider', async () => {
    const result = await runProviderEditor({
      config,
      existingProvider,
      io,
      mode: 'update',
      source,
    }, createPromptPort({
      endpoint: vi.fn(async () => cancelled),
    }))

    expect(result).toEqual({ status: 'cancelled' })
  })

  it('returns Back from the first editor prompt to its caller', async () => {
    const promptPort = createPromptPort({
      endpoint: vi.fn(async () => back),
    })

    const result = await runProviderEditor({
      config,
      existingProvider,
      io,
      mode: 'update',
      source,
    }, promptPort)

    expect(result).toEqual({ status: 'back' })
    expect(promptPort.providerId).not.toHaveBeenCalled()
  })

  it('initially selects configured models missing from the remote response', async () => {
    const promptPort = createPromptPort()

    await runProviderEditor({
      config,
      existingProvider,
      io,
      mode: 'update',
      source,
    }, promptPort)

    expect(promptPort.models).toHaveBeenCalledWith([
      { hint: undefined, label: 'existing', value: 'existing' },
      { hint: 'not reported by provider', label: 'missing', value: 'missing' },
      { hint: 'new', label: 'new', value: 'new' },
    ], ['existing', 'missing', 'new'])
  })

  it('forces replacement of a current default that is deselected', async () => {
    const promptPort = createPromptPort({
      defaultModel: vi.fn(async (options: ModelOption[]) => submitted(options.find(option => option.value.includes('existing'))?.value ?? 'cancelled')),
      models: vi.fn(async () => submitted(['existing', 'new'])),
    })

    const result = await runProviderEditor({
      config,
      existingProvider,
      io,
      mode: 'update',
      source,
    }, promptPort)

    expect(promptPort.defaultModel).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      defaultAliasTarget: { modelId: 'existing', providerId: 'example' },
      status: 'confirmed',
    })
  })

  it('uses manual entry without probing when the setup source disables probes', async () => {
    const promptPort = createPromptPort()

    await runProviderEditor({
      config: { providers: [], version: 1 },
      io,
      mode: 'create',
      source: {
        benchmarkConcurrency: 2,
        kind: 'openai-compatible',
        label: 'Manual model entry',
        probeModels: false,
        value: 'manual',
      },
    }, promptPort)

    expect(promptPort.probe).not.toHaveBeenCalled()
    expect(promptPort.manualModels).toHaveBeenCalledOnce()
  })

  it('derives the create provider id and offers scoped-config defaults from a provisional config', async () => {
    const promptPort = createPromptPort({
      defaultAction: vi.fn(async () => submitted<'selectAnother'>('selectAnother')),
      defaultModel: vi.fn(async (options: ModelOption[]) => submitted(options.find(option => option.value.includes('remote'))?.value ?? 'cancelled')),
      endpoint: vi.fn(async () => submitted('http://127.0.0.1:8317/v1')),
      headerInput: vi.fn(async () => submitted('')),
      probe: vi.fn(async () => ['remote']),
    })

    const result = await runProviderEditor({
      config: {
        providers: [
          {
            endpoint: 'https://other.example/v1',
            id: 'other',
            models: [
              {
                aliases: ['default'],
                id: 'existing-default',
                name: 'Existing default',
              },
            ],
            type: 'openai-compatible',
          },
        ],
        version: 1,
      },
      io,
      mode: 'create',
      source: {
        benchmarkConcurrency: 2,
        defaultEndpoint: 'http://127.0.0.1:8317/v1',
        defaultProviderId: 'CLIProxyAPI',
        kind: 'openai-compatible',
        label: 'CLIProxyAPI',
        probeModels: true,
        value: 'cliProxyApi',
      },
    }, promptPort)

    expect(promptPort.providerId).toHaveBeenCalledWith('cliproxyapi', true)
    expect(promptPort.defaultModel).toHaveBeenCalledWith([
      { hint: 'current default', label: 'other / existing-default', value: 'other\u0000existing-default' },
      { hint: 'new', label: 'cliproxyapi / remote', value: 'cliproxyapi\u0000remote' },
    ])
    expect(result).toMatchObject({
      defaultAliasTarget: { modelId: 'remote', providerId: 'cliproxyapi' },
      status: 'confirmed',
    })
  })

  it('preserves header removals when navigating back through the header steps', async () => {
    const summaries: string[] = []
    const retainedHeaders = vi.fn()
      .mockResolvedValueOnce(submitted(['X-Keep']))
      .mockResolvedValueOnce(submitted(['X-Keep']))
    const promptPort = createPromptPort({
      confirm: vi.fn(async (summary: string) => {
        summaries.push(summary)
        return submitted<'yes'>('yes')
      }),
      headerInput: vi.fn()
        .mockResolvedValueOnce(submitted('X-New=new-secret'))
        .mockResolvedValueOnce(back)
        .mockResolvedValueOnce(submitted('')),
      models: vi.fn()
        .mockResolvedValueOnce(back)
        .mockImplementation(async (_options: ModelOption[], initialValues: string[]) => submitted(initialValues)),
      retainedHeaders,
    })

    const result = await runProviderEditor({
      config,
      existingProvider,
      io,
      mode: 'update',
      source,
    }, promptPort)

    expect(retainedHeaders).toHaveBeenNthCalledWith(
      2,
      ['Authorization', 'X-Keep', 'X-New'],
      ['X-Keep', 'X-New'],
    )
    expect(result).toMatchObject({
      provider: {
        headers: { 'X-Keep': 'yes' },
      },
      status: 'confirmed',
    })
    expect(promptPort.headerInput).toHaveBeenCalledWith()
    expect(summaries[0]).not.toContain('old-secret')
    expect(summaries[0]).not.toContain('new-secret')
  })

  it('preserves a secret replacement when blank input follows Back', async () => {
    const summaries: string[] = []
    const promptPort = createPromptPort({
      confirm: vi.fn(async (summary: string) => {
        summaries.push(summary)
        return submitted<'yes'>('yes')
      }),
      headerInput: vi.fn()
        .mockResolvedValueOnce(submitted('Authorization=Bearer replacement'))
        .mockResolvedValueOnce(submitted('')),
      models: vi.fn()
        .mockResolvedValueOnce(back)
        .mockImplementation(async (_options: ModelOption[], initialValues: string[]) => submitted(initialValues)),
    })

    const result = await runProviderEditor({
      config,
      existingProvider,
      io,
      mode: 'update',
      source,
    }, promptPort)

    expect(result).toMatchObject({
      provider: {
        headers: {
          'Authorization': 'Bearer replacement',
          'X-Keep': 'yes',
        },
      },
      status: 'confirmed',
    })
    expect(promptPort.headerInput).toHaveBeenCalledWith()
    expect(summaries[0]).not.toContain('old-secret')
    expect(summaries[0]).not.toContain('replacement')
  })

  it('replaces differently-cased logical header names in editor state and probe headers', async () => {
    const promptPort = createPromptPort({
      headerInput: vi.fn(async () => submitted('authorization=Bearer replacement')),
    })

    const result = await runProviderEditor({
      config,
      existingProvider,
      io,
      mode: 'update',
      source,
    }, promptPort)

    expect(promptPort.probe).toHaveBeenCalledWith('https://next.example/v1', {
      'authorization': 'Bearer replacement',
      'X-Keep': 'yes',
    })
    expect(result).toMatchObject({
      provider: {
        headers: {
          'authorization': 'Bearer replacement',
          'X-Keep': 'yes',
        },
      },
      status: 'confirmed',
    })
  })

  it('collapses differently-cased configured headers before retention and probing', async () => {
    const provider: ProviderDefinition = {
      ...existingProvider,
      headers: {
        'Authorization': 'Bearer stale',
        'authorization': 'Bearer current',
        'X-Keep': 'yes',
      },
    }
    const promptPort = createPromptPort({
      headerInput: vi.fn(async () => submitted('')),
    })

    await runProviderEditor({
      config: {
        providers: [provider],
        version: 1,
      },
      existingProvider: provider,
      io,
      mode: 'update',
      source,
    }, promptPort)

    expect(promptPort.retainedHeaders).toHaveBeenCalledWith(
      ['authorization', 'X-Keep'],
      ['authorization', 'X-Keep'],
    )
    expect(promptPort.probe).toHaveBeenCalledWith('https://next.example/v1', {
      'authorization': 'Bearer current',
      'X-Keep': 'yes',
    })
  })

  it('escapes every untrusted confirmation summary value without exposing secrets', async () => {
    const summaries: string[] = []
    const unsafeProvider: ProviderDefinition = {
      endpoint: 'https://old.example/v1',
      headers: { 'X-Old\u0085Header': 'old-secret' },
      id: 'old',
      models: [
        {
          aliases: ['default'],
          id: 'old\u2028model',
        },
      ],
      type: 'openai-compatible',
    }
    const promptPort = createPromptPort({
      confirm: vi.fn(async (summary: string) => {
        summaries.push(summary)
        return submitted<'yes'>('yes')
      }),
      defaultAction: vi.fn(async () => submitted<'yes'>('yes')),
      endpoint: vi.fn(async () => submitted('https://next.example/v1\u2028path')),
      headerInput: vi.fn(async () => submitted('X-New=top-secret')),
      models: vi.fn(async () => submitted(['new\u001Bmodel'])),
      probe: vi.fn(async () => ['new\u001Bmodel']),
      providerId: vi.fn(async () => submitted('provider\nname')),
    })

    await runProviderEditor({
      config: {
        providers: [unsafeProvider],
        version: 1,
      },
      existingProvider: unsafeProvider,
      io,
      mode: 'update',
      source,
    }, promptPort)

    expect(summaries[0]).toBe([
      'Update provider?',
      'Provider: provider\\nname',
      'Endpoint: https://next.example/v1\\u2028path',
      'Headers: X-Old\\u0085Header, X-New',
      'Added models: new\\u001bmodel',
      'Removed models: old\\u2028model',
      'Default: provider\\nname/new\\u001bmodel',
    ].join('\n'))
    expect(summaries[0]).not.toContain('old-secret')
    expect(summaries[0]).not.toContain('top-secret')
  })

  it('reconciles selections when navigating back and probing a changed model list', async () => {
    const models = vi.fn()
      .mockResolvedValueOnce(submitted(['existing', 'missing']))
      .mockResolvedValueOnce(back)
      .mockImplementation(async (_options: ModelOption[], initialValues: string[]) => submitted(initialValues))
    const promptPort = createPromptPort({
      defaultAction: vi.fn()
        .mockResolvedValueOnce(back)
        .mockResolvedValueOnce(submitted<'no'>('no')),
      headerInput: vi.fn(async () => submitted('')),
      models,
      probe: vi.fn()
        .mockResolvedValueOnce(['existing', 'common-new', 'first-only'])
        .mockResolvedValueOnce(['existing', 'common-new', 'second-only']),
    })

    await runProviderEditor({
      config,
      existingProvider,
      io,
      mode: 'update',
      source,
    }, promptPort)

    expect(models).toHaveBeenNthCalledWith(3, [
      { hint: undefined, label: 'existing', value: 'existing' },
      { hint: 'not reported by provider', label: 'missing', value: 'missing' },
      { hint: 'new', label: 'common-new', value: 'common-new' },
      { hint: 'new', label: 'second-only', value: 'second-only' },
    ], ['existing', 'missing', 'second-only'])
  })

  it('accepts endpoint and provider-id text that matches internal control labels', async () => {
    const result = await runProviderEditor({
      config: { providers: [], version: 1 },
      io,
      mode: 'create',
      source,
    }, createPromptPort({
      endpoint: vi.fn(async () => submitted('back')),
      providerId: vi.fn(async () => submitted('cancelled')),
    }))

    expect(result).toMatchObject({
      provider: { endpoint: 'back', id: 'cancelled' },
      status: 'confirmed',
    })
  })
})

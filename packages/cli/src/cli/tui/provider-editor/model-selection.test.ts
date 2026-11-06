import type { ProviderDefinition, SetupConfig } from '@alint-js/config'

import { describe, expect, it } from 'vitest'

import {
  applyDefaultAlias,
  applyHeaderSelection,
  createDefaultModelCandidates,
  createModelOptions,
  modelsFromSelection,
} from './model-selection'

describe('provider editor model selection', () => {
  it('combines and stable-deduplicates configured and discovered model options', () => {
    const provider: ProviderDefinition = {
      endpoint: 'https://example.test/v1',
      id: 'example',
      models: [
        { id: 'existing', name: 'existing' },
        { id: 'existing', name: 'duplicate existing' },
        { id: 'missing', name: 'missing' },
      ],
      type: 'openai-compatible',
    }

    expect(createModelOptions(provider, ['existing', 'new', 'existing', 'new'])).toEqual([
      { hint: undefined, label: 'existing', value: 'existing' },
      { hint: 'not reported by provider', label: 'missing', value: 'missing' },
      { hint: 'new', label: 'new', value: 'new' },
    ])
  })

  it('stable-deduplicates selections and uses the first configured model metadata', () => {
    const provider: ProviderDefinition = {
      endpoint: 'https://example.test/v1',
      id: 'example',
      models: [
        {
          aliases: ['fast'],
          capabilities: ['code-review'],
          contextWindow: 32768,
          defaultParams: { temperature: 0.1 },
          id: 'existing',
          size: 'small',
        },
        {
          aliases: ['duplicate'],
          id: 'existing',
          name: 'duplicate existing',
        },
      ],
      type: 'openai-compatible',
    }

    const models = modelsFromSelection(provider, ['existing', 'new', 'existing', 'new'])

    expect(models).toEqual([
      {
        aliases: ['fast'],
        capabilities: ['code-review'],
        contextWindow: 32768,
        defaultParams: { temperature: 0.1 },
        id: 'existing',
        size: 'small',
      },
      { id: 'new', name: 'new' },
    ])
    expect(models[0]?.aliases).not.toBe(provider.models[0]?.aliases)
    expect(models[0]?.capabilities).not.toBe(provider.models[0]?.capabilities)
    expect(models[0]?.defaultParams).not.toBe(provider.models[0]?.defaultParams)
  })

  it('retains selected headers and applies replacements', () => {
    expect(applyHeaderSelection(
      { 'Authorization': 'Bearer secret', 'X-Remove': 'value' },
      ['Authorization'],
      { 'Authorization': 'Bearer replacement', 'X-New': 'true' },
    )).toEqual({ 'Authorization': 'Bearer replacement', 'X-New': 'true' })
  })

  it('reconciles HTTP header names case-insensitively when replacing them', () => {
    expect(applyHeaderSelection(
      { 'Authorization': 'Bearer secret', 'X-Keep': 'value' },
      ['AUTHORIZATION', 'x-keep'],
      { authorization: 'Bearer replacement' },
    )).toEqual({ 'authorization': 'Bearer replacement', 'X-Keep': 'value' })
  })

  it('returns undefined when no headers remain', () => {
    expect(applyHeaderSelection({ Authorization: 'Bearer secret' }, [], {})).toBeUndefined()
  })
})

describe('interactive setup default model helpers', () => {
  it('orders default model candidates by current default, new models, then existing config order', () => {
    const candidates = createDefaultModelCandidates({
      providers: [
        {
          endpoint: 'https://openrouter.ai/api/v1',
          id: 'openrouter',
          models: [
            { id: 'openrouter-large', name: 'openrouter-large' },
            {
              aliases: ['default', 'fast'],
              id: 'openrouter-small',
              name: 'openrouter-small',
            },
          ],
          type: 'openai-compatible',
        },
        {
          endpoint: 'http://127.0.0.1:8317/v1',
          id: 'cliproxyapi',
          models: [
            { id: 'gpt-5.6-luna', name: 'gpt-5.6-luna' },
            { id: 'gpt-5.6-sol', name: 'gpt-5.6-sol' },
          ],
          type: 'openai-compatible',
        },
        {
          endpoint: 'http://localhost:11434/v1',
          id: 'ollama',
          models: [
            { id: 'qwen:8b', name: 'qwen:8b' },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    }, 'cliproxyapi', ['gpt-5.6-luna', 'gpt-5.6-sol'])

    expect(candidates).toEqual([
      {
        isCurrentDefault: true,
        isNew: false,
        label: 'openrouter / openrouter-small',
        modelId: 'openrouter-small',
        providerId: 'openrouter',
        value: 'openrouter\u0000openrouter-small',
      },
      {
        isCurrentDefault: false,
        isNew: true,
        label: 'cliproxyapi / gpt-5.6-luna',
        modelId: 'gpt-5.6-luna',
        providerId: 'cliproxyapi',
        value: 'cliproxyapi\u0000gpt-5.6-luna',
      },
      {
        isCurrentDefault: false,
        isNew: true,
        label: 'cliproxyapi / gpt-5.6-sol',
        modelId: 'gpt-5.6-sol',
        providerId: 'cliproxyapi',
        value: 'cliproxyapi\u0000gpt-5.6-sol',
      },
      {
        isCurrentDefault: false,
        isNew: false,
        label: 'openrouter / openrouter-large',
        modelId: 'openrouter-large',
        providerId: 'openrouter',
        value: 'openrouter\u0000openrouter-large',
      },
      {
        isCurrentDefault: false,
        isNew: false,
        label: 'ollama / qwen:8b',
        modelId: 'qwen:8b',
        providerId: 'ollama',
        value: 'ollama\u0000qwen:8b',
      },
    ])
  })

  it('does not duplicate a current default that is also a new model', () => {
    const candidates = createDefaultModelCandidates({
      providers: [
        {
          endpoint: 'http://127.0.0.1:8317/v1',
          id: 'cliproxyapi',
          models: [
            {
              aliases: ['default'],
              id: 'gpt-5.6-luna',
              name: 'gpt-5.6-luna',
            },
            { id: 'gpt-5.6-sol', name: 'gpt-5.6-sol' },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    }, 'cliproxyapi', ['gpt-5.6-luna', 'gpt-5.6-sol'])

    expect(candidates.map(candidate => candidate.value)).toEqual([
      'cliproxyapi\u0000gpt-5.6-luna',
      'cliproxyapi\u0000gpt-5.6-sol',
    ])
  })

  it('applies one default alias and preserves unrelated aliases', () => {
    const input: SetupConfig = {
      providers: [
        {
          endpoint: 'https://openrouter.ai/api/v1',
          headers: { Authorization: 'Bearer secret' },
          id: 'openrouter',
          models: [
            {
              aliases: ['default', 'fast'],
              capabilities: ['code-review'],
              defaultParams: { temperature: 0.1 },
              id: 'openrouter-small',
              name: 'openrouter-small',
            },
          ],
          type: 'openai-compatible',
        },
        {
          endpoint: 'http://127.0.0.1:8317/v1',
          id: 'cliproxyapi',
          models: [
            {
              aliases: ['review'],
              id: 'gpt-5.6-luna',
              name: 'gpt-5.6-luna',
            },
            {
              aliases: ['default'],
              id: 'gpt-5.6-sol',
              name: 'gpt-5.6-sol',
            },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    }
    const config = applyDefaultAlias(input, { modelId: 'gpt-5.6-luna', providerId: 'cliproxyapi' })

    expect(config.providers[0]?.models[0]?.aliases).toEqual(['fast'])
    expect(config.providers[1]?.models[0]?.aliases).toEqual(['review', 'default'])
    expect(config.providers[1]?.models[1]?.aliases).toBeUndefined()
    expect(config.providers[0]?.headers).not.toBe(input.providers[0]?.headers)
    expect(config.providers[0]?.models[0]?.aliases).not.toBe(input.providers[0]?.models[0]?.aliases)
    expect(config.providers[0]?.models[0]?.capabilities).not.toBe(input.providers[0]?.models[0]?.capabilities)
    expect(config.providers[0]?.models[0]?.defaultParams).not.toBe(input.providers[0]?.models[0]?.defaultParams)
  })

  it('models the Yes action by making the first selected new model the only default', () => {
    const nextConfig = applyDefaultAlias({
      providers: [
        {
          endpoint: 'https://openrouter.ai/api/v1',
          id: 'openrouter',
          models: [
            {
              aliases: ['default'],
              id: 'openrouter-small',
              name: 'openrouter-small',
            },
          ],
          type: 'openai-compatible',
        },
        {
          endpoint: 'http://127.0.0.1:8317/v1',
          id: 'cliproxyapi',
          models: [
            { id: 'gpt-5.6-luna', name: 'gpt-5.6-luna' },
            { id: 'gpt-5.6-sol', name: 'gpt-5.6-sol' },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    }, { modelId: 'gpt-5.6-luna', providerId: 'cliproxyapi' })

    expect(nextConfig.providers[0]?.models[0]?.aliases).toBeUndefined()
    expect(nextConfig.providers[1]?.models[0]?.aliases).toEqual(['default'])
    expect(nextConfig.providers[1]?.models[1]?.aliases).toBeUndefined()
  })
})

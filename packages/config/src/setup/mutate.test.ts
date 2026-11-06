import type { ProviderConfig as ProviderDefinition, SetupConfig } from './types'

import { describe, expect, it } from 'vitest'

import {
  addProviderModels,
  pruneProviderModels,
  removeProviderModels,
  replaceSetupProvider,
  setProviderEndpoint,
  setProviderHeader,
  unsetProviderHeader,
} from './mutate'

function createSetupConfig(): SetupConfig {
  return {
    providers: [
      {
        endpoint: 'https://primary.example/v1',
        headers: {
          'Authorization': 'Bearer original',
          'X-Project': 'alint',
        },
        id: 'primary',
        models: [
          {
            aliases: ['default', 'fast'],
            capabilities: ['code-review', 'structured-output'],
            contextWindow: 32768,
            defaultParams: { temperature: 0.1 },
            id: 'model-existing',
            name: 'Existing Model',
            size: 'medium',
          },
          {
            aliases: ['missing'],
            capabilities: ['tool-call'],
            contextWindow: 16384,
            defaultParams: { temperature: 0.2 },
            id: 'model-missing',
            name: 'Missing Model',
            size: 'small',
          },
        ],
        type: 'openai-compatible',
      },
      {
        endpoint: 'https://unrelated.example/v1',
        headers: { 'X-Unrelated': 'true' },
        id: 'unrelated',
        models: [
          {
            aliases: ['other'],
            capabilities: ['embeddings'],
            defaultParams: { dimensions: 1024 },
            id: 'other-model',
            name: 'Other Model',
          },
        ],
        type: 'openai-compatible',
      },
    ],
    runner: {
      cache: { enabled: true, location: '.alint-cache' },
      ruleConcurrency: 3,
      timeoutMs: 120000,
    },
    version: 1,
  }
}

function expectOriginalConfigUnchanged(config: SetupConfig): void {
  const provider = config.providers[0]!
  const model = provider.models[0]!
  const missingModel = provider.models[1]!
  const unrelated = config.providers[1]!
  const unrelatedModel = unrelated.models[0]!

  expect(config.version).toBe(1)
  expect(config.runner?.ruleConcurrency).toBe(3)
  expect(config.runner?.timeoutMs).toBe(120000)
  expect(config.runner?.cache).toEqual({ enabled: true, location: '.alint-cache' })
  expect(config.providers.map(item => item.id)).toEqual(['primary', 'unrelated'])
  expect(provider.endpoint).toBe('https://primary.example/v1')
  expect(provider.headers?.Authorization).toBe('Bearer original')
  expect(provider.headers?.['X-Project']).toBe('alint')
  expect(provider.models.map(item => item.id)).toEqual(['model-existing', 'model-missing'])
  expect(model.name).toBe('Existing Model')
  expect(model.aliases).toEqual(['default', 'fast'])
  expect(model.capabilities).toEqual(['code-review', 'structured-output'])
  expect(model.contextWindow).toBe(32768)
  expect(model.size).toBe('medium')
  expect(model.defaultParams).toEqual({ temperature: 0.1 })
  expect(missingModel.name).toBe('Missing Model')
  expect(missingModel.aliases).toEqual(['missing'])
  expect(missingModel.capabilities).toEqual(['tool-call'])
  expect(missingModel.contextWindow).toBe(16384)
  expect(missingModel.size).toBe('small')
  expect(missingModel.defaultParams).toEqual({ temperature: 0.2 })
  expect(unrelated.endpoint).toBe('https://unrelated.example/v1')
  expect(unrelated.headers).toEqual({ 'X-Unrelated': 'true' })
  expect(unrelatedModel.aliases).toEqual(['other'])
  expect(unrelatedModel.capabilities).toEqual(['embeddings'])
  expect(unrelatedModel.defaultParams).toEqual({ dimensions: 1024 })
}

function expectPreservedConfigContext(source: SetupConfig, result: SetupConfig): void {
  const sourceUnrelated = source.providers[1]!
  const resultUnrelated = result.providers[1]!
  const sourceModel = sourceUnrelated.models[0]!
  const resultModel = resultUnrelated.models[0]!

  expect(result).not.toBe(source)
  expect(result.version).toBe(1)
  expect(result.runner).toBe(source.runner)
  expect(result.providers.map(provider => provider.id)).toEqual(['primary', 'unrelated'])
  expect(resultUnrelated).toEqual(sourceUnrelated)
  expect(resultUnrelated).not.toBe(sourceUnrelated)
  expect(resultUnrelated.headers).not.toBe(sourceUnrelated.headers)
  expect(resultUnrelated.models).not.toBe(sourceUnrelated.models)
  expect(resultModel).not.toBe(sourceModel)
  expect(resultModel.aliases).not.toBe(sourceModel.aliases)
  expect(resultModel.capabilities).not.toBe(sourceModel.capabilities)
  expect(resultModel.defaultParams).not.toBe(sourceModel.defaultParams)
}

function mutateReturnedProvider(config: SetupConfig): void {
  const provider = config.providers[0]!
  const model = provider.models[0]

  provider.endpoint = 'https://mutated.example/v1'
  provider.headers = { Mutated: 'true' }
  provider.models.push({ id: 'mutated' })

  if (model !== undefined) {
    model.name = 'Mutated Model'
    model.aliases?.push('mutated')
    model.capabilities?.push('mutated')
    if (model.defaultParams !== undefined) {
      model.defaultParams.temperature = 1
    }
  }
}

describe('setup config mutations', () => {
  it('adds unseen provider models once in first-seen order and preserves model metadata', () => {
    const config = createSetupConfig()
    const result = addProviderModels(config, 'primary', [
      'model-existing',
      'model-new',
      'model-new',
      'model-another',
      'model-existing',
    ])
    const provider = result.providers[0]!
    const existing = provider.models[0]!

    expect(provider.models.map(model => model.id)).toEqual([
      'model-existing',
      'model-missing',
      'model-new',
      'model-another',
    ])
    expect(existing.name).toBe('Existing Model')
    expect(existing.aliases).toEqual(['default', 'fast'])
    expect(existing.capabilities).toEqual(['code-review', 'structured-output'])
    expect(existing.contextWindow).toBe(32768)
    expect(existing.size).toBe('medium')
    expect(existing.defaultParams).toEqual({ temperature: 0.1 })
    expect(provider.models[2]).toEqual({ id: 'model-new', name: 'model-new' })
    expect(provider.models[3]).toEqual({ id: 'model-another', name: 'model-another' })
    expectPreservedConfigContext(config, result)

    mutateReturnedProvider(result)
    expectOriginalConfigUnchanged(config)
  })

  it('removes only exact provider model ids', () => {
    const config = createSetupConfig()
    const result = removeProviderModels(config, 'primary', new Set(['model', 'model-missing']))
    const provider = result.providers[0]!
    const model = provider.models[0]!

    expect(provider.models.map(item => item.id)).toEqual(['model-existing'])
    expect(model.name).toBe('Existing Model')
    expect(model.aliases).toEqual(['default', 'fast'])
    expect(model.capabilities).toEqual(['code-review', 'structured-output'])
    expect(model.contextWindow).toBe(32768)
    expect(model.size).toBe('medium')
    expect(model.defaultParams).toEqual({ temperature: 0.1 })
    expectPreservedConfigContext(config, result)

    mutateReturnedProvider(result)
    expectOriginalConfigUnchanged(config)
  })

  it('prunes provider models that are absent from the remote ids', () => {
    const config = createSetupConfig()
    const result = pruneProviderModels(config, 'primary', new Set(['model', 'model-existing']))
    const provider = result.providers[0]!
    const model = provider.models[0]!

    expect(provider.models.map(item => item.id)).toEqual(['model-existing'])
    expect(model.name).toBe('Existing Model')
    expect(model.aliases).toEqual(['default', 'fast'])
    expect(model.capabilities).toEqual(['code-review', 'structured-output'])
    expect(model.contextWindow).toBe(32768)
    expect(model.size).toBe('medium')
    expect(model.defaultParams).toEqual({ temperature: 0.1 })
    expectPreservedConfigContext(config, result)

    mutateReturnedProvider(result)
    expectOriginalConfigUnchanged(config)
  })

  it('replaces the full matching provider with a clone', () => {
    const config = createSetupConfig()
    const replacement: ProviderDefinition = {
      endpoint: 'https://replacement.example/v1',
      headers: { 'X-Replacement': 'true' },
      id: 'primary',
      models: [
        {
          aliases: ['replacement'],
          capabilities: ['vision'],
          contextWindow: 65536,
          defaultParams: { quality: 'high' },
          id: 'replacement-model',
          name: 'Replacement Model',
          size: 'large',
        },
      ],
      type: 'openai-compatible',
    }
    const result = replaceSetupProvider(config, replacement)
    const provider = result.providers[0]!
    const model = provider.models[0]!

    expect(provider).toEqual(replacement)
    expect(provider).not.toBe(replacement)
    expect(provider.headers).not.toBe(replacement.headers)
    expect(provider.models).not.toBe(replacement.models)
    expect(model).not.toBe(replacement.models[0])
    expect(model.aliases).not.toBe(replacement.models[0]?.aliases)
    expect(model.capabilities).not.toBe(replacement.models[0]?.capabilities)
    expect(model.defaultParams).not.toBe(replacement.models[0]?.defaultParams)
    expect(provider.headers?.Authorization).toBeUndefined()
    expect(provider.models.map(item => item.id)).toEqual(['replacement-model'])
    expectPreservedConfigContext(config, result)

    mutateReturnedProvider(result)
    expectOriginalConfigUnchanged(config)
    expect(replacement.endpoint).toBe('https://replacement.example/v1')
    expect(replacement.headers).toEqual({ 'X-Replacement': 'true' })
    expect(replacement.models[0]?.name).toBe('Replacement Model')
    expect(replacement.models[0]?.aliases).toEqual(['replacement'])
    expect(replacement.models[0]?.capabilities).toEqual(['vision'])
    expect(replacement.models[0]?.defaultParams).toEqual({ quality: 'high' })
  })

  it('sets only the matching provider endpoint', () => {
    const config = createSetupConfig()
    const result = setProviderEndpoint(config, 'primary', 'https://changed.example/v1')
    const provider = result.providers[0]!

    expect(provider.endpoint).toBe('https://changed.example/v1')
    expect(provider.headers).toEqual(config.providers[0]?.headers)
    expect(provider.models).toEqual(config.providers[0]?.models)
    expectPreservedConfigContext(config, result)

    mutateReturnedProvider(result)
    expectOriginalConfigUnchanged(config)
  })

  it('updates only the first provider when ids are duplicated', () => {
    const config = createSetupConfig()
    const duplicate: ProviderDefinition = {
      endpoint: 'https://duplicate.example/v1',
      headers: { 'X-Duplicate': 'true' },
      id: 'primary',
      models: [
        {
          aliases: ['duplicate'],
          capabilities: ['vision'],
          defaultParams: { quality: 'high' },
          id: 'duplicate-model',
          name: 'Duplicate Model',
        },
      ],
      type: 'openai-compatible',
    }
    config.providers.push(duplicate)

    const result = setProviderEndpoint(config, 'primary', 'https://changed.example/v1')
    const resultDuplicate = result.providers[2]!
    const resultDuplicateModel = resultDuplicate.models[0]!
    const duplicateModel = duplicate.models[0]!

    expect(result.providers[0]?.endpoint).toBe('https://changed.example/v1')
    expect(resultDuplicate.endpoint).toBe('https://duplicate.example/v1')
    expect(resultDuplicate).toEqual(duplicate)
    expect(resultDuplicate).not.toBe(duplicate)
    expect(resultDuplicate.headers).not.toBe(duplicate.headers)
    expect(resultDuplicate.models).not.toBe(duplicate.models)
    expect(resultDuplicateModel).not.toBe(duplicateModel)
    expect(resultDuplicateModel.aliases).not.toBe(duplicateModel.aliases)
    expect(resultDuplicateModel.capabilities).not.toBe(duplicateModel.capabilities)
    expect(resultDuplicateModel.defaultParams).not.toBe(duplicateModel.defaultParams)

    resultDuplicate.headers!['X-Duplicate'] = 'changed'
    resultDuplicate.models.push({ id: 'mutated' })
    resultDuplicateModel.name = 'Mutated Model'
    resultDuplicateModel.aliases?.push('mutated')
    resultDuplicateModel.capabilities?.push('mutated')
    resultDuplicateModel.defaultParams!.quality = 'low'

    expect(duplicate.endpoint).toBe('https://duplicate.example/v1')
    expect(duplicate.headers).toEqual({ 'X-Duplicate': 'true' })
    expect(duplicate.models.map(model => model.id)).toEqual(['duplicate-model'])
    expect(duplicateModel.name).toBe('Duplicate Model')
    expect(duplicateModel.aliases).toEqual(['duplicate'])
    expect(duplicateModel.capabilities).toEqual(['vision'])
    expect(duplicateModel.defaultParams).toEqual({ quality: 'high' })
    expectOriginalConfigUnchanged({
      ...config,
      providers: config.providers.slice(0, 2),
    })
  })

  it('merges and replaces one provider header', () => {
    const config = createSetupConfig()
    config.providers[0]!.headers = {
      ...config.providers[0]!.headers,
      authorization: 'Bearer stale lower',
      AUTHORIZATION: 'Bearer stale upper',
    }
    const result = setProviderHeader(config, 'primary', 'Authorization', 'Bearer changed')
    const provider = result.providers[0]!

    expect(provider.headers).toEqual({
      'Authorization': 'Bearer changed',
      'X-Project': 'alint',
    })
    expect(provider.endpoint).toBe('https://primary.example/v1')
    expect(provider.models).toEqual(config.providers[0]?.models)
    expectPreservedConfigContext(config, result)

    mutateReturnedProvider(result)
    expectOriginalConfigUnchanged(config)
  })

  it('sets a provider header when headers are absent', () => {
    const config = createSetupConfig()
    delete config.providers[0]!.headers
    const result = setProviderHeader(config, 'primary', 'Authorization', 'Bearer created')

    expect(result.providers[0]?.headers).toEqual({ Authorization: 'Bearer created' })
    expect(config.providers[0]?.headers).toBeUndefined()
  })

  it('unsets all case variants of a provider header and preserves the others', () => {
    const config = createSetupConfig()
    config.providers[0]!.headers = {
      ...config.providers[0]!.headers,
      authorization: 'Bearer stale lower',
      AUTHORIZATION: 'Bearer stale upper',
    }
    const result = unsetProviderHeader(config, 'primary', 'aUtHoRiZaTiOn')
    const provider = result.providers[0]!

    expect(provider.headers).toEqual({ 'X-Project': 'alint' })
    expect(provider.endpoint).toBe('https://primary.example/v1')
    expect(provider.models).toEqual(config.providers[0]?.models)
    expectPreservedConfigContext(config, result)

    mutateReturnedProvider(result)
    expectOriginalConfigUnchanged(config)
  })

  it('sets headers to undefined after unsetting the final key', () => {
    const config = createSetupConfig()
    config.providers[0]!.headers = { Authorization: 'Bearer original' }
    const result = unsetProviderHeader(config, 'primary', 'Authorization')

    expect(result.providers[0]?.headers).toBeUndefined()
    expect(config.providers[0]?.headers).toEqual({ Authorization: 'Bearer original' })
  })

  it('is idempotent when unsetting an absent header', () => {
    const config = createSetupConfig()
    const result = unsetProviderHeader(config, 'primary', 'X-Absent')

    expect(result.providers[0]?.headers).toEqual(config.providers[0]?.headers)
    expect(result.providers[0]?.headers).not.toBe(config.providers[0]?.headers)
    expectPreservedConfigContext(config, result)
    expectOriginalConfigUnchanged(config)
  })

  it.each([
    [
      'addProviderModels',
      (config: SetupConfig) => addProviderModels(config, 'unknown', ['model']),
    ],
    [
      'pruneProviderModels',
      (config: SetupConfig) => pruneProviderModels(config, 'unknown', new Set()),
    ],
    [
      'removeProviderModels',
      (config: SetupConfig) => removeProviderModels(config, 'unknown', new Set()),
    ],
    [
      'replaceSetupProvider',
      (config: SetupConfig) => replaceSetupProvider(config, {
        endpoint: 'https://unknown.example/v1',
        id: 'unknown',
        models: [],
        type: 'openai-compatible',
      }),
    ],
    [
      'setProviderEndpoint',
      (config: SetupConfig) => setProviderEndpoint(config, 'unknown', 'https://unknown.example/v1'),
    ],
    [
      'setProviderHeader',
      (config: SetupConfig) => setProviderHeader(config, 'unknown', 'X-Test', 'true'),
    ],
    [
      'unsetProviderHeader',
      (config: SetupConfig) => unsetProviderHeader(config, 'unknown', 'X-Test'),
    ],
  ])('throws for an unknown provider in %s', (_name, mutate) => {
    const config = createSetupConfig()

    expect(() => mutate(config)).toThrow('Unknown provider "unknown".')
    expectOriginalConfigUnchanged(config)
  })
})

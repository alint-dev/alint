import type { SetupConfig } from '../config/types'

import { describe, expect, it } from 'vitest'

import { resolveModel } from './resolve'

const registry: SetupConfig = {
  providers: [
    {
      endpoint: 'http://localhost:11434/v1',
      headers: { Authorization: 'Bearer local-token' },
      id: 'ollama',
      models: [
        {
          aliases: ['default', 'small'],
          capabilities: ['code-review', 'structured-output'],
          contextWindow: 32768,
          defaultParams: { temperature: 0.1 },
          id: 'local:qwen-8b',
          name: 'qwen:8b',
          size: 'small',
        },
        {
          aliases: ['large'],
          capabilities: ['code-review'],
          contextWindow: 65536,
          id: 'local:qwen-32b',
          name: 'qwen:32b',
          size: 'large',
        },
        {
          aliases: ['nameless'],
          capabilities: ['embeddings'],
          id: 'local:nameless',
        },
      ],
      type: 'openai-compatible',
    },
  ],
  version: 1,
}

const ambiguousRegistry: SetupConfig = {
  providers: [
    {
      endpoint: 'https://first.example.com/v1',
      id: 'first',
      models: [
        {
          aliases: ['shared'],
          id: 'qwen',
          name: 'Qwen',
        },
      ],
      type: 'openai-compatible',
    },
    {
      endpoint: 'https://second.example.com/v1',
      id: 'second',
      models: [
        {
          aliases: ['shared'],
          id: 'qwen',
          name: 'Qwen',
        },
      ],
      type: 'openai-compatible',
    },
  ],
  version: 1,
}

const sameProviderCollisionRegistry: SetupConfig = {
  providers: [
    {
      endpoint: 'https://first.example.com/v1',
      id: 'first',
      models: [
        { id: 'qwen' },
        {
          aliases: ['qwen'],
          id: 'other',
        },
      ],
      type: 'openai-compatible',
    },
  ],
  version: 1,
}

const duplicateCanonicalRegistry: SetupConfig = {
  providers: [
    {
      endpoint: 'https://first.example.com/v1',
      id: 'first',
      models: [
        { id: 'qwen' },
        { id: 'qwen' },
      ],
      type: 'openai-compatible',
    },
  ],
  version: 1,
}

describe('resolveModel', () => {
  it('resolves aliases to a stable model id', () => {
    const model = resolveModel(registry, { request: 'default' })
    expect(model.id).toBe('local:qwen-8b')
    expect(model.name).toBe('qwen:8b')
    expect(model.provider.endpoint).toBe('http://localhost:11434/v1')
  })

  it('matches by model id', () => {
    const model = resolveModel(registry, { request: 'local:qwen-32b' })
    expect(model.id).toBe('local:qwen-32b')
    expect(model.name).toBe('qwen:32b')
  })

  it('matches by provider model name', () => {
    const model = resolveModel(registry, { request: 'qwen:32b' })
    expect(model.id).toBe('local:qwen-32b')
  })

  it('matches a provider-qualified model id', () => {
    const model = resolveModel(registry, { request: 'ollama/local:qwen-32b' })

    expect(model.provider.id).toBe('ollama')
    expect(model.id).toBe('local:qwen-32b')
  })

  it.each(['qwen', 'Qwen', 'shared'])('rejects ambiguous explicit selector %s', (request) => {
    expect(() => resolveModel(ambiguousRegistry, { request })).toThrowError(
      new Error(
        `Ambiguous model "${request}".\nSpecify a provider-qualified model:\n  first/qwen\n  second/qwen`,
      ),
    )
  })

  it('resolves an unambiguous provider-qualified model', () => {
    const model = resolveModel(ambiguousRegistry, { request: 'second/qwen' })

    expect(model.provider.id).toBe('second')
    expect(model.id).toBe('qwen')
  })

  it('suggests canonical model ids for same-provider selector collisions', () => {
    expect(() => resolveModel(sameProviderCollisionRegistry, { request: 'qwen' })).toThrowError(
      new Error(
        'Ambiguous model "qwen".\nSpecify a provider-qualified model:\n  first/qwen\n  first/other',
      ),
    )
  })

  it('prioritizes a provider-qualified canonical id over a qualified alias', () => {
    const model = resolveModel(sameProviderCollisionRegistry, { request: 'first/qwen' })

    expect(model.provider.id).toBe('first')
    expect(model.id).toBe('qwen')
  })

  it('rejects duplicate canonical provider and model ids as a configuration collision', () => {
    expect(() => resolveModel(duplicateCanonicalRegistry, { request: 'first/qwen' })).toThrowError(
      new Error(
        'Model "first/qwen" is configured more than once.\nRemove duplicate provider/model definitions from the setup configuration.',
      ),
    )
  })

  it('rejects unqualified selectors for duplicate canonical model definitions', () => {
    expect(() => resolveModel(duplicateCanonicalRegistry, { request: 'qwen' })).toThrowError(
      new Error(
        'Model "first/qwen" is configured more than once.\nRemove duplicate provider/model definitions from the setup configuration.',
      ),
    )
  })

  it('retains deterministic automatic selection for ambiguous registries', () => {
    const model = resolveModel(ambiguousRegistry)

    expect(model.provider.id).toBe('first')
    expect(model.id).toBe('qwen')
  })

  it('defaults the concrete model name to id when name is absent', () => {
    const model = resolveModel(registry, { request: 'local:nameless' })
    expect(model.name).toBe('local:nameless')
  })

  it('matches required capabilities and minimum context window', () => {
    const model = resolveModel(registry, {
      requirement: {
        capabilities: ['structured-output'],
        minContextWindow: 16000,
        params: { top_p: 0.9 },
      },
    })
    expect(model.id).toBe('local:qwen-8b')
    expect(model.params).toEqual({ temperature: 0.1, top_p: 0.9 })
  })

  it('treats size as a preference', () => {
    const model = resolveModel(registry, {
      requirement: {
        capabilities: ['structured-output'],
        size: 'large',
      },
    })
    expect(model.id).toBe('local:qwen-8b')
  })

  it('throws when an explicit requested model fails a hard requirement', () => {
    expect(() => resolveModel(registry, {
      request: 'large',
      requirement: {
        capabilities: ['structured-output'],
      },
      ruleId: 'company/error-handling',
    })).toThrow('Model "large" does not satisfy requirement for rule "company/error-handling".')
  })

  it('throws when no model satisfies a hard requirement', () => {
    expect(() => resolveModel(registry, {
      requirement: {
        capabilities: ['tool-use'],
      },
      ruleId: 'company/error-handling',
    })).toThrow('No model satisfies requirement for rule "company/error-handling".')
  })

  it('uses unknown rule fallback when no model satisfies a hard requirement without rule id', () => {
    expect(() => resolveModel(registry, {
      requirement: {
        capabilities: ['tool-use'],
      },
    })).toThrow('No model satisfies requirement for rule "<unknown>".')
  })

  it('clones returned mutable data from the setup registry', () => {
    const model = resolveModel(registry, {
      request: 'default',
      requirement: {
        params: { top_p: 0.9 },
      },
    })

    model.aliases.push('mutated-alias')
    model.capabilities.push('mutated-capability')
    model.params.temperature = 0.8
    model.provider.headers.Authorization = 'Bearer mutated-token'

    const sourceModel = registry.providers[0]!.models[0]!
    expect(sourceModel.aliases).toEqual(['default', 'small'])
    expect(sourceModel.capabilities).toEqual(['code-review', 'structured-output'])
    expect(sourceModel.defaultParams).toEqual({ temperature: 0.1 })
    expect(registry.providers[0]!.headers).toEqual({ Authorization: 'Bearer local-token' })
  })
})

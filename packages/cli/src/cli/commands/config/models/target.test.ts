import type { SetupConfig } from '@alint-js/core'

import { describe, expect, it } from 'vitest'

import { resolveExactModelTarget } from './target'

function setupConfig(): SetupConfig {
  return {
    providers: [
      {
        endpoint: 'https://first.example/v1',
        id: 'first',
        models: [
          { id: 'qwen', name: 'Qwen' },
          { id: 'z-ai/glm-5.2', name: 'GLM' },
        ],
        type: 'openai-compatible',
      },
      {
        endpoint: 'https://second.example/v1',
        id: 'second',
        models: [
          { id: 'qwen', name: 'Qwen' },
        ],
        type: 'openai-compatible',
      },
    ],
    version: 1,
  }
}

describe('resolveExactModelTarget', () => {
  it.each([
    {
      providerId: 'first',
      request: 'z-ai/glm-5.2',
      result: { modelId: 'z-ai/glm-5.2', providerId: 'first', status: 'found' },
    },
    {
      providerId: undefined,
      request: 'first/qwen',
      result: { modelId: 'qwen', providerId: 'first', status: 'found' },
    },
    {
      providerId: 'second',
      request: 'first/qwen',
      result: {
        qualifiedProviderId: 'first',
        requestedProviderId: 'second',
        status: 'conflict',
      },
    },
    {
      providerId: 'missing',
      request: 'qwen',
      result: { providerId: 'missing', status: 'unknown-provider' },
    },
    {
      providerId: undefined,
      request: 'qwen',
      result: {
        candidates: [
          { modelId: 'qwen', providerId: 'first' },
          { modelId: 'qwen', providerId: 'second' },
        ],
        status: 'ambiguous',
      },
    },
    {
      providerId: 'first',
      request: 'missing',
      result: { modelId: 'missing', providerId: 'first', status: 'missing' },
    },
  ])('$request with provider $providerId resolves as $result.status', ({ providerId, request, result }) => {
    const resolved = resolveExactModelTarget(setupConfig(), request, providerId)

    if (resolved.status === 'found') {
      expect({
        modelId: resolved.model.id,
        providerId: resolved.provider.id,
        status: resolved.status,
      }).toEqual(result)
      return
    }

    if (resolved.status === 'missing') {
      expect({
        modelId: resolved.modelId,
        providerId: resolved.provider?.id,
        status: resolved.status,
      }).toEqual(result)
      return
    }

    expect(resolved).toEqual(result)
  })

  it('rejects a duplicated provider identity before selecting its model', () => {
    const config = setupConfig()
    config.providers.push({ ...config.providers[0]!, models: [] })

    expect(resolveExactModelTarget(config, 'first/qwen', undefined)).toEqual({
      providerId: 'first',
      status: 'duplicate-provider',
    })
  })
})

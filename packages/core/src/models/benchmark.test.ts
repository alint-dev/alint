import type { SetupConfig } from '../config/types'

import { createServer } from 'node:http'

import { describe, expect, it } from 'vitest'

import { benchmarkModels } from './benchmark'

const config: SetupConfig = {
  providers: [
    {
      endpoint: 'https://first.example/v1',
      id: 'first',
      models: [{ id: 'fast' }],
      type: 'openai-compatible',
    },
    {
      endpoint: 'https://second.example/v1',
      id: 'second',
      models: [{ id: 'offline' }],
      type: 'openai-compatible',
    },
  ],
  version: 1,
}

describe('benchmarkModels', () => {
  it('runs model jobs concurrently within each provider limit while keeping each model serial', async () => {
    const activeByProvider = new Map<string, number>()
    const activeByModel = new Map<string, number>()
    const maxActiveByProvider = new Map<string, number>()
    const maxActiveByModel = new Map<string, number>()
    let maxActive = 0

    const results = await benchmarkModels({
      providers: [
        {
          endpoint: 'https://first.example/v1',
          id: 'first',
          models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
          type: 'openai-compatible',
        },
        {
          endpoint: 'https://second.example/v1',
          id: 'second',
          models: [{ id: 'd' }, { id: 'e' }],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    }, {
      providerConcurrency: { first: 2, second: 1 },
      request: async ({ model }) => {
        const identity = `${model.provider.id}/${model.id}`
        const providerActive = (activeByProvider.get(model.provider.id) ?? 0) + 1
        const modelActive = (activeByModel.get(identity) ?? 0) + 1
        activeByProvider.set(model.provider.id, providerActive)
        activeByModel.set(identity, modelActive)
        maxActiveByProvider.set(
          model.provider.id,
          Math.max(maxActiveByProvider.get(model.provider.id) ?? 0, providerActive),
        )
        maxActiveByModel.set(identity, Math.max(maxActiveByModel.get(identity) ?? 0, modelActive))
        maxActive = Math.max(maxActive, [...activeByProvider.values()].reduce((sum, value) => sum + value, 0))

        await new Promise<void>(resolve => queueMicrotask(resolve))

        activeByProvider.set(model.provider.id, (activeByProvider.get(model.provider.id) ?? 1) - 1)
        activeByModel.set(identity, (activeByModel.get(identity) ?? 1) - 1)
        return { durationMs: 100, firstOutputMs: 20, outputTokens: 8 }
      },
      sampleCount: 1,
      seed: 123,
    })

    expect(maxActiveByProvider.get('first')).toBe(2)
    expect(maxActiveByProvider.get('second')).toBe(1)
    expect(maxActive).toBe(3)
    expect([...maxActiveByModel.values()]).toEqual([1, 1, 1, 1, 1])
    expect(results.map(result => `${result.providerId}/${result.modelId}`)).toEqual([
      'first/a',
      'first/b',
      'first/c',
      'second/d',
      'second/e',
    ])
  })

  it('marks a failed streaming request errored without retrying that model', async () => {
    let calls = 0
    const server = createServer((_request, response) => {
      calls += 1
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'offline' }))
    })

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()

    if (address === null || typeof address === 'string') {
      throw new TypeError('Expected TCP test server address.')
    }

    try {
      const [result] = await benchmarkModels({
        providers: [{
          endpoint: `http://127.0.0.1:${address.port}/v1/`,
          id: 'local',
          models: [{ id: 'offline' }],
          type: 'openai-compatible',
        }],
        version: 1,
      }, { sampleCount: 1, seed: 123 })

      expect(calls).toBe(1)
      expect(result?.error).toContain('503')
      expect(result?.success).toEqual({ attempted: 1, completed: 0 })
    }
    finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('measures an OpenAI-compatible streaming endpoint', async () => {
    let calls = 0
    const server = createServer((request, response) => {
      calls += 1
      expect(request.url).toBe('/v1/chat/completions')
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(sse({
        choices: [{ delta: { content: 'One', role: 'assistant' }, index: 0 }],
        created: 0,
        id: 'benchmark',
        model: 'fast',
        object: 'chat.completion.chunk',
        system_fingerprint: '',
      }))
      setTimeout(() => {
        response.write(sse({
          choices: [{ delta: { content: ' two' }, finish_reason: 'stop', index: 0 }],
          created: 0,
          id: 'benchmark',
          model: 'fast',
          object: 'chat.completion.chunk',
          system_fingerprint: '',
        }))
        response.write(sse({
          choices: [],
          created: 0,
          id: 'benchmark',
          model: 'fast',
          object: 'chat.completion.chunk',
          system_fingerprint: '',
          usage: { completion_tokens: 8, prompt_tokens: 64, total_tokens: 72 },
        }))
        response.end('data: [DONE]\n\n')
      }, 5)
    })

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()

    if (address === null || typeof address === 'string') {
      throw new TypeError('Expected TCP test server address.')
    }

    try {
      const [result] = await benchmarkModels({
        providers: [{
          endpoint: `http://127.0.0.1:${address.port}/v1/`,
          id: 'local',
          models: [{ id: 'fast' }],
          type: 'openai-compatible',
        }],
        version: 1,
      }, { sampleCount: 1, seed: 123 })

      expect(calls).toBe(3)
      expect(result?.error).toBeUndefined()
      expect(result?.repeatMs).toBeGreaterThan(0)
      expect(result?.nonRepeatMs).toBeGreaterThan(0)
      expect(result?.throughput).toBeGreaterThan(0)
      expect(result?.success).toEqual({ attempted: 3, completed: 3 })
    }
    finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('does not report throughput for empty output deltas', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(sse({
        choices: [{ delta: { content: '', role: 'assistant' }, finish_reason: 'length', index: 0 }],
        created: 0,
        id: 'benchmark',
        model: 'empty-output',
        object: 'chat.completion.chunk',
      }))
      setTimeout(() => {
        response.write(sse({
          choices: [{ delta: { content: '', role: 'assistant' }, finish_reason: 'length', index: 0 }],
          created: 0,
          id: 'benchmark',
          model: 'empty-output',
          object: 'chat.completion.chunk',
        }))
        response.write(sse({
          choices: [],
          created: 0,
          id: 'benchmark',
          model: 'empty-output',
          object: 'chat.completion.chunk',
          usage: { completion_tokens: 128, prompt_tokens: 64, total_tokens: 192 },
        }))
        response.end('data: [DONE]\n\n')
      }, 5)
    })

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()

    if (address === null || typeof address === 'string') {
      throw new TypeError('Expected TCP test server address.')
    }

    try {
      const [result] = await benchmarkModels({
        providers: [{
          endpoint: `http://127.0.0.1:${address.port}/v1/`,
          id: 'local',
          models: [{ id: 'empty-output' }],
          type: 'openai-compatible',
        }],
        version: 1,
      }, { sampleCount: 1, seed: 123 })

      // ROOT CAUSE:
      //
      // Some providers send empty text deltas before the usage event.
      // The benchmark treated the first empty delta as the first output.
      // It divided all output tokens by the final event interval.
      // This produced false throughput values above 400,000 tokens per second.
      expect(result?.throughput).toBeUndefined()
    }
    finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('does not report throughput from one non-empty output delta', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(sse({
        choices: [{ delta: { content: 'Complete answer', role: 'assistant' }, index: 0 }],
        created: 0,
        id: 'benchmark',
        model: 'buffered-output',
        object: 'chat.completion.chunk',
      }))
      setTimeout(() => {
        response.write(sse({
          choices: [],
          created: 0,
          id: 'benchmark',
          model: 'buffered-output',
          object: 'chat.completion.chunk',
          usage: { completion_tokens: 32, prompt_tokens: 64, total_tokens: 96 },
        }))
        response.end('data: [DONE]\n\n')
      }, 5)
    })

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()

    if (address === null || typeof address === 'string') {
      throw new TypeError('Expected TCP test server address.')
    }

    try {
      const [result] = await benchmarkModels({
        providers: [{
          endpoint: `http://127.0.0.1:${address.port}/v1/`,
          id: 'local',
          models: [{ id: 'buffered-output' }],
          type: 'openai-compatible',
        }],
        version: 1,
      }, { sampleCount: 1, seed: 123 })

      // One output timestamp cannot show the provider's decode interval.
      expect(result?.throughput).toBeUndefined()
    }
    finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('measures repeat before non-repeat and aggregates their medians separately', async () => {
    const prompts: string[] = []
    const progress: Array<{ active: readonly { phase: string, sample: number, warmup: boolean }[], results: readonly unknown[] }> = []
    const measurements = [
      { durationMs: 900, firstOutputMs: 300, outputTokens: 30 },
      { durationMs: 500, firstOutputMs: 100, outputTokens: 20 },
      { durationMs: 700, firstOutputMs: 200, outputTokens: 25 },
      { durationMs: 600, firstOutputMs: 100, outputTokens: 30 },
      { durationMs: 1_200, firstOutputMs: 200, outputTokens: 40 },
      { durationMs: 1_000, firstOutputMs: 200, outputTokens: 40 },
      { durationMs: 1_100, firstOutputMs: 100, outputTokens: 50 },
    ]

    const [result] = await benchmarkModels({ ...config, providers: [config.providers[0]!] }, {
      onProgress: snapshot => progress.push(snapshot),
      request: async ({ prompt }) => {
        prompts.push(prompt)
        return measurements[prompts.length - 1]!
      },
      seed: 123,
    })

    expect(prompts).toHaveLength(7)
    expect(new Set(prompts.slice(0, 4))).toHaveLength(1)
    expect(new Set(prompts.slice(4))).toHaveLength(3)
    expect(result.providerId).toBe('first')
    expect(result.modelId).toBe('fast')
    expect(result.repeatMs).toBe(600)
    expect(result.nonRepeatMs).toBe(1_100)
    expect(result.throughput).toBe(50)
    expect(result.success).toEqual({ attempted: 7, completed: 7 })
    expect(result.error).toBeUndefined()
    expect(progress.map(snapshot => snapshot.active.length === 0
      ? { active: [], results: snapshot.results.filter(Boolean).length }
      : {
          phase: snapshot.active[0]?.phase,
          results: snapshot.results.filter(Boolean).length,
          sample: snapshot.active[0]?.sample,
          warmup: snapshot.active[0]?.warmup,
        })).toEqual([
      { phase: 'repeat', results: 0, sample: 0, warmup: true },
      { phase: 'repeat', results: 0, sample: 1, warmup: false },
      { phase: 'repeat', results: 0, sample: 2, warmup: false },
      { phase: 'repeat', results: 0, sample: 3, warmup: false },
      { phase: 'non-repeat', results: 0, sample: 1, warmup: false },
      { phase: 'non-repeat', results: 0, sample: 2, warmup: false },
      { phase: 'non-repeat', results: 0, sample: 3, warmup: false },
      { active: [], results: 1 },
    ])
  })

  it('times out a benchmark request and reports the model as errored', async () => {
    const server = createServer((_request, response) => {
      setTimeout(() => response.end(), 1_000)
    })

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()

    if (address === null || typeof address === 'string') {
      throw new TypeError('Expected TCP test server address.')
    }

    try {
      const [result] = await benchmarkModels({
        providers: [{
          endpoint: `http://127.0.0.1:${address.port}/v1/`,
          id: 'local',
          models: [{ id: 'hung' }],
          type: 'openai-compatible',
        }],
        version: 1,
      }, { sampleCount: 1, seed: 123, timeoutMs: 20 })

      expect(result?.error).toBeDefined()
      expect(result?.success).toEqual({ attempted: 1, completed: 0 })
    }
    finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('marks a failed model errored and continues with the next configured model', async () => {
    const requestedModels: string[] = []

    const results = await benchmarkModels(config, {
      request: async ({ model }) => {
        requestedModels.push(model.id)

        if (model.id === 'fast') {
          throw new Error('provider unavailable')
        }

        return { durationMs: 100, firstOutputMs: 20, outputTokens: 8 }
      },
      sampleCount: 1,
      seed: 123,
    })

    expect(requestedModels).toEqual(['fast', 'offline', 'offline', 'offline'])
    expect(results[0]?.error).toBe('provider unavailable')
    expect(results[0]?.success).toEqual({ attempted: 1, completed: 0 })
    expect(results[1]?.error).toBeUndefined()
    expect(results[1]?.success).toEqual({ attempted: 3, completed: 3 })
  })
})

function sse(body: unknown): string {
  return `data: ${JSON.stringify(body)}\n\n`
}

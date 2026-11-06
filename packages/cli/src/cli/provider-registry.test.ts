import { createServer } from 'node:http'

import { describe, expect, it } from 'vitest'

import { formatAmbiguousModels, formatModelBenchmarkList, formatModelBenchmarkProgressList, probeModels, resolveProviderBenchmarkConcurrency } from './provider-registry'

const invalidResponseMessage = 'Expected OpenAI-compatible models response with data array.'

async function withJsonServer<T>(body: unknown, run: (endpoint: string) => Promise<T>): Promise<T> {
  const server = createServer((_request, response) => {
    response.statusCode = 200
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(body))
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()

  if (address === null || typeof address === 'string') {
    throw new TypeError('Expected TCP test server address.')
  }

  try {
    return await run(`http://127.0.0.1:${address.port}/v1/`)
  }
  finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    })
  }
}

describe('probeModels', () => {
  it.each([
    { body: null, label: 'null' },
    { body: [], label: 'an array body' },
    { body: {}, label: 'an object without data' },
    {
      body: { data: null },
      label: 'null data',
    },
    {
      body: { data: {} },
      label: 'non-array data',
    },
  ])('rejects $label with the stable response-shape error', async ({ body }) => {
    await withJsonServer(body, async (endpoint) => {
      await expect(probeModels(endpoint)).rejects.toThrowError(
        new TypeError(invalidResponseMessage),
      )
    })
  })

  it.each([null, 'model', 42])(
    'rejects a non-object data member %j with the stable response-shape error',
    async (member) => {
      await withJsonServer({
        data: [member],
      }, async (endpoint) => {
        await expect(probeModels(endpoint)).rejects.toThrowError(
          new TypeError(invalidResponseMessage),
        )
      })
    },
  )

  it.each([
    {},
    { id: null },
    { id: 42 },
    { id: '' },
    [
      { id: 'nested' },
    ],
  ])('rejects an object data member without a non-empty string id: %j', async (member) => {
    await withJsonServer({
      data: [member],
    }, async (endpoint) => {
      await expect(probeModels(endpoint)).rejects.toThrowError(
        new TypeError(invalidResponseMessage),
      )
    })
  })

  it('rejects a mixed valid and invalid data array', async () => {
    await withJsonServer({
      data: [
        { id: 'valid' },
        {},
      ],
    }, async (endpoint) => {
      await expect(probeModels(endpoint)).rejects.toThrowError(
        new TypeError(invalidResponseMessage),
      )
    })
  })

  it('accepts an empty data array', async () => {
    await withJsonServer({ data: [] }, async (endpoint) => {
      await expect(probeModels(endpoint)).resolves.toEqual([])
    })
  })
})

describe('formatAmbiguousModels', () => {
  it('escapes line-oriented request and candidate identities', () => {
    expect(formatAmbiguousModels('shared\u0085request', [
      {
        model: { id: 'model\u001Bid' },
        provider: {
          endpoint: 'https://example.test/v1',
          id: 'first\u2028provider',
          models: [],
          type: 'openai-compatible',
        },
      },
      {
        model: { id: 'other' },
        provider: {
          endpoint: 'https://example.test/v1',
          id: 'second',
          models: [],
          type: 'openai-compatible',
        },
      },
    ])).toBe([
      'ambiguous model "shared\\u0085request".',
      'specify a provider-qualified model:',
      '  first\\u2028provider/model\\u001bid',
      '  second/other',
      '',
    ].join('\n'))
  })
})

describe('formatModelBenchmarkList', () => {
  it('renders speed columns in repeat, non-repeat, throughput, success order', () => {
    const output = formatModelBenchmarkList({
      providers: [
        {
          endpoint: 'https://example.test/v1',
          id: 'remote',
          models: [
            { id: 'model', name: 'Example' },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    }, [
      {
        modelId: 'model',
        nonRepeatMs: 1_230,
        providerId: 'remote',
        repeatMs: 450,
        success: { attempted: 7, completed: 7 },
        throughput: 42.34,
      },
    ])

    expect(output).toContain('repeat  non-repeat  throughput  success')
    expect(output).toContain('450ms   1.23s       42.3 tok/s  7/7')
  })

  it('renders errored speed cells in red when color is enabled', () => {
    const output = formatModelBenchmarkList({
      providers: [
        {
          endpoint: 'http://localhost:11434/v1',
          id: 'ollama',
          models: [
            { id: 'qwen' },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    }, [
      {
        error: 'fetch failed',
        modelId: 'qwen',
        providerId: 'ollama',
        success: { attempted: 1, completed: 0 },
      },
    ], { color: true })

    expect(output).toContain('\u001B[31merrored\u001B[39m')
    expect(output).toContain('0/1')
  })
})

describe('formatModelBenchmarkProgressList', () => {
  it('renders concurrent active phases with spinners and keeps completed model results visible', () => {
    const config = {
      providers: [
        {
          endpoint: 'https://example.test/v1',
          id: 'remote',
          models: [
            { id: 'done' },
            { id: 'running' },
            { id: 'pending' },
          ],
          type: 'openai-compatible' as const,
        },
      ],
      version: 1 as const,
    }
    const output = formatModelBenchmarkProgressList(config, {
      active: [
        {
          modelId: 'running',
          modelIndex: 1,
          phase: 'non-repeat',
          providerId: 'remote',
          sample: 2,
          samples: 3,
          success: { attempted: 6, completed: 5 },
          warmup: false,
        },
        {
          modelId: 'pending',
          modelIndex: 2,
          phase: 'repeat',
          providerId: 'remote',
          sample: 0,
          samples: 3,
          success: { attempted: 1, completed: 0 },
          warmup: true,
        },
      ],
      modelsTotal: 3,
      results: [
        {
          modelId: 'done',
          nonRepeatMs: 1_200,
          providerId: 'remote',
          repeatMs: 400,
          success: { attempted: 7, completed: 7 },
          throughput: 30,
        },
        undefined,
        undefined,
      ],
    }, {
      color: false,
      frame: '⠋',
      maxRows: 8,
      tick: 0,
    })

    expect(output).toContain('done')
    expect(output).toContain('400ms')
    expect(output).toContain('running')
    expect(output).toMatch(/done\s+⠋ 2\/3\s+measuring\s+5\/6/u)
    expect(output).toContain('pending')
    expect(output).toContain('warm-up')
    expect(output).toContain('1/3 models complete')
    expect(output).toContain('2 running')
    expect(output).toContain('[████░░░░░░░░]')
  })

  it('keeps the current model visible when the table exceeds terminal height', () => {
    const models = Array.from({ length: 20 }, (_, index) => ({ id: `model-${index}` }))
    const output = formatModelBenchmarkProgressList({
      providers: [
        {
          endpoint: 'https://example.test/v1',
          id: 'remote',
          models,
          type: 'openai-compatible',
        },
      ],
      version: 1,
    }, {
      active: [
        {
          modelId: 'model-15',
          modelIndex: 15,
          phase: 'repeat',
          providerId: 'remote',
          sample: 1,
          samples: 3,
          success: { attempted: 2, completed: 1 },
          warmup: false,
        },
      ],
      modelsTotal: 20,
      results: [],
    }, {
      color: false,
      frame: '⠋',
      maxRows: 6,
      tick: 0,
    })

    expect(output).toContain('model-15')
    expect(output).toContain('showing models')
    expect(output.split('\n').filter(Boolean).length).toBeLessThanOrEqual(6)
  })
})

describe('resolveProviderBenchmarkConcurrency', () => {
  const config = {
    providers: [
      {
        endpoint: 'https://openrouter.ai/api/v1',
        id: 'openrouter',
        models: [],
        type: 'openai-compatible' as const,
      },
      {
        endpoint: 'http://127.0.0.1:8317/v1',
        id: 'cliproxyapi',
        models: [],
        type: 'openai-compatible' as const,
      },
      {
        endpoint: 'https://custom.example/v1',
        id: 'custom',
        models: [],
        type: 'openai-compatible' as const,
      },
    ],
    version: 1 as const,
  }

  it('uses registry defaults and applies repeated provider-id overrides', () => {
    expect(resolveProviderBenchmarkConcurrency(config, [
      'cliproxyapi=4',
      'custom=7',
    ])).toEqual({
      cliproxyapi: 4,
      custom: 7,
      openrouter: 20,
    })
  })

  it.each([
    { message: 'Expected <provider-id>=<limit>', value: 'openrouter' },
    { message: 'positive integer', value: 'openrouter=0' },
    { message: 'positive integer', value: 'openrouter=1.5' },
    { message: 'Unknown provider', value: 'missing=2' },
  ])('rejects invalid override $value', ({ message, value }) => {
    expect(() => resolveProviderBenchmarkConcurrency(config, [value])).toThrow(message)
  })
})

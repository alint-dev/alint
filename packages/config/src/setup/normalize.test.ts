import { describe, expect, it, vi } from 'vitest'

import { normalizeSetupConfig } from './normalize'

describe('normalize setup config', () => {
  it('normalizes ordinary models without invoking a model adapter', async () => {
    const acp = vi.fn()
    const config = await normalizeSetupConfig({
      providers: [
        {
          endpoint: 'https://models.example/v1',
          headers: { Authorization: 'Bearer token' },
          id: 'remote',
          models: [
            { id: 'first' },
            { id: 'second' },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    }, { acp })

    expect(acp).not.toHaveBeenCalled()
    expect(config.providers).toHaveLength(1)
    expect(config.providers[0]).toEqual({
      endpoint: 'https://models.example/v1',
      headers: { Authorization: 'Bearer token' },
      id: 'remote',
      models: [
        { id: 'first' },
        { id: 'second' },
      ],
      type: 'openai-compatible',
    })
  })

  it('delegates only ACP models and preserves model transport order', async () => {
    const acp = vi.fn().mockResolvedValue({
      endpoint: 'http://127.0.0.1:1234/v1/',
      type: 'openai-compatible' as const,
    })
    const config = await normalizeSetupConfig({
      providers: [
        {
          endpoint: 'https://models.example/v1',
          id: 'mixed',
          models: [
            { command: 'codex-acp', driver: 'acp', id: 'codex' },
            { id: 'remote-one' },
            { id: 'remote-two' },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    }, { acp })

    expect(acp).toHaveBeenCalledOnce()
    expect(acp).toHaveBeenCalledWith({
      id: 'mixed',
      models: [
        { command: 'codex-acp', driver: 'acp', id: 'codex' },
      ],
    })
    expect(config.providers).toEqual([
      {
        endpoint: 'http://127.0.0.1:1234/v1/',
        id: 'mixed',
        models: [
          { id: 'codex' },
        ],
        type: 'openai-compatible',
      },
      {
        endpoint: 'https://models.example/v1',
        id: 'mixed',
        models: [
          { id: 'remote-one' },
          { id: 'remote-two' },
        ],
        type: 'openai-compatible',
      },
    ])
  })
})

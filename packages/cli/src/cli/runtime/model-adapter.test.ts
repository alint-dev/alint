import { describe, expect, it } from 'vitest'

import { startModelAdapters } from './model-adapter'

describe('runtime model adapter', () => {
  it('materializes mixed remote and ACP models under one provider identity', async () => {
    const runtime = await startModelAdapters({
      providers: [
        {
          endpoint: 'https://models.example/v1',
          id: 'mixed',
          models: [
            { id: 'remote' },
            { command: 'unused-until-requested', driver: 'acp', id: 'codex' },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    }, {
      cwd: process.cwd(),
      env: process.env,
      stderr: {
        write: () => {},
      },
      stdout: {
        write: () => {},
      },
    })

    try {
      expect(runtime.setupConfig.providers).toHaveLength(2)
      expect(runtime.setupConfig.providers[0]).toMatchObject({
        endpoint: 'https://models.example/v1',
        id: 'mixed',
        models: [
          { id: 'remote' },
        ],
      })
      expect(runtime.setupConfig.providers[1]?.id).toBe('mixed')
      expect(runtime.setupConfig.providers[1]?.models).toEqual([
        { id: 'codex' },
      ])
      expect(runtime.setupConfig.providers[1]?.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:/)
    }
    finally {
      await runtime.shutdown()
    }
  })
})

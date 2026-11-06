import type { AlintConfig } from '@alint-js/core'

import type { CliIo } from '../types'

import process from 'node:process'

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getGlobalSetupConfigPath, writeSetupConfig } from '@alint-js/config'
import { describe, expect, it, vi } from 'vitest'

import * as alintCore from '@alint-js/core'

import { runResultWith } from '../test-support'
import { createRunSession } from './session'

async function createTestIo(): Promise<CliIo> {
  const cwd = await mkdtemp(join(tmpdir(), 'alint-session-'))
  const configHome = await mkdtemp(join(tmpdir(), 'alint-session-home-'))

  return {
    cwd,
    env: { ...process.env, XDG_CONFIG_HOME: configHome },
    stderr: {
      write: () => true,
    },
    stdout: {
      write: () => true,
    },
  }
}

async function writeFixture(cwd: string): Promise<void> {
  await writeFile(join(cwd, 'demo.ts'), 'export function load() {\n  return 1\n}\n')
  await writeFile(join(cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    plugins: {
      company: {
        rules: {
          'prefer-load': {
            languages: 'any',
            create: (ctx) => ({
              onTargetFunction: async (target) => {
                ctx.report({
                  filePath: target.file.path,
                  message: 'Problem found',
                  loc: target.loc,
                })
              },
            }),
          },
        },
      },
    },
    rules: {
      'company/prefer-load': 'warn',
    },
  },
]
`)
}

describe('createRunSession', () => {
  it('hands every run the identical setupConfig object', async () => {
    // core hashes setupConfig into modelHash. Two runs given different objects get different cache
    // keys, and the cacheOnly pass then cannot read what the paid run wrote.
    const io = await createTestIo()
    await writeFixture(io.cwd)

    const runAlint = vi.spyOn(alintCore, 'runAlint').mockResolvedValue(runResultWith())
    const session = await createRunSession(io)

    try {
      await session.run({ cacheOnly: true })
      await session.run({})

      expect(runAlint.mock.calls[0]?.[0]?.setupConfig).toBe(session.setupConfig)
      expect(runAlint.mock.calls[1]?.[0]?.setupConfig).toBe(session.setupConfig)
    }
    finally {
      runAlint.mockRestore()
      await session.shutdown()
    }
  })

  it('normalizes setup config once, not per run', async () => {
    const io = await createTestIo()
    await writeFixture(io.cwd)

    const startModelAdapters = vi.fn().mockResolvedValue({
      setupConfig: { providers: [], version: 1 },
      shutdown: () => Promise.resolve(),
    })
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockResolvedValue(runResultWith())
    const session = await createRunSession(io, { startModelAdapters })

    try {
      await session.run({ cacheOnly: true })
      await session.run({ cacheOnly: true })
      await session.run({})

      expect(startModelAdapters).toHaveBeenCalledTimes(1)
    }
    finally {
      runAlint.mockRestore()
      await session.shutdown()
    }
  })

  it('starts no loopback gateway when no provider declares ACP models', async () => {
    // normalizeSetupConfig calls the ACP adapter only for a provider that has ACP models. The
    // gateway endpoint holds a per-process port, and setupConfig is hashed into the cache key.
    const io = await createTestIo()
    await writeFixture(io.cwd)
    await writeSetupConfig(getGlobalSetupConfigPath(io.env ?? process.env), {
      providers: [
        {
          endpoint: 'https://models.example/v1',
          id: 'remote',
          models: [
            { id: 'small' },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    })

    const session = await createRunSession(io)

    try {
      expect(session.setupConfig.providers).toHaveLength(1)
      expect(session.setupConfig.providers[0]?.endpoint).toBe('https://models.example/v1')
    }
    finally {
      await session.shutdown()
    }
  })

  it('shuts adapters down exactly once', async () => {
    const io = await createTestIo()
    await writeFixture(io.cwd)

    const shutdown = vi.fn().mockResolvedValue(undefined)
    const session = await createRunSession(io, {
      startModelAdapters: vi.fn().mockResolvedValue({
        setupConfig: { providers: [], version: 1 },
        shutdown,
      }),
    })

    await session.shutdown()
    await session.shutdown()

    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('discovers targets from the session cwd and forwards run options to core', async () => {
    const io = await createTestIo()
    await writeFixture(io.cwd)

    const runAlint = vi.spyOn(alintCore, 'runAlint').mockResolvedValue(runResultWith())
    const session = await createRunSession(io)
    const { signal } = new AbortController()

    try {
      await session.run({
        cacheOnly: true,
        inputs: ['demo.ts'],
        projectTargets: false,
        runner: { stats: false },
        signal,
      })

      expect(runAlint).toHaveBeenCalledWith(expect.objectContaining({
        cacheOnly: true,
        cwd: io.cwd,
        defaultModel: 'default',
        files: ['demo.ts'],
        projectTargets: false,
        runner: { stats: false },
        signal,
      }))
    }
    finally {
      runAlint.mockRestore()
      await session.shutdown()
    }
  })

  it('uses a preloaded config and resolved targets without reading project inputs again', async () => {
    const io = await createTestIo()
    const config: AlintConfig = []
    const targets = {
      directories: ['virtual-directory'],
      files: ['missing.ts'],
    }
    const startModelAdapters = vi.fn().mockResolvedValue({
      setupConfig: { providers: [], version: 1 },
      shutdown: () => Promise.resolve(),
    })
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockResolvedValue(runResultWith())
    const session = await createRunSession(io, { config, startModelAdapters })

    try {
      await session.run({ targets })

      expect(session.config).toBe(config)
      expect(runAlint.mock.calls[0]?.[0]?.config).toBe(config)
      expect(runAlint.mock.calls[0]?.[0]?.directories).toBe(targets.directories)
      expect(runAlint.mock.calls[0]?.[0]?.files).toBe(targets.files)
    }
    finally {
      runAlint.mockRestore()
      await session.shutdown()
    }
  })

  it('rejects an input pattern that matches no file', async () => {
    // The lint command converts this to exit code 2. The session must not run on an empty target
    // list instead.
    const io = await createTestIo()
    await writeFixture(io.cwd)

    const session = await createRunSession(io)

    try {
      await expect(session.run({
        inputs: ['missing/**/*.ts'],
      })).rejects.toThrow('No files matching')
    }
    finally {
      await session.shutdown()
    }
  })
})

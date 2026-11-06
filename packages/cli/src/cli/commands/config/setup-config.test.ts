import type { CliIo } from '../../types'

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getGlobalSetupConfigPath, getProjectSetupConfigPath, writeSetupConfig } from '@alint-js/config'
import { describe, expect, it } from 'vitest'

import { loadRunSetupConfig } from './setup-config'

async function createTestIo(): Promise<CliIo> {
  const cwd = await mkdtemp(join(tmpdir(), 'alint-run-setup-'))
  const configHome = await mkdtemp(join(tmpdir(), 'alint-config-home-'))

  return {
    cwd,
    env: { XDG_CONFIG_HOME: configHome },
    stderr: {
      write: () => {},
    },
    stdout: {
      write: () => {},
    },
  }
}

describe('loadRunSetupConfig', () => {
  it('requests the global default alias when the project has no models', async () => {
    const io = await createTestIo()

    await writeSetupConfig(getGlobalSetupConfigPath(io.env), {
      providers: [
        {
          endpoint: 'https://global.example/v1',
          id: 'global',
          models: [
            {
              aliases: ['default'],
              id: 'global-default',
            },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    })
    await writeSetupConfig(getProjectSetupConfigPath(io.cwd), {
      providers: [],
      runner: { timeoutMs: 100 },
      version: 1,
    })

    const result = await loadRunSetupConfig(io)

    expect(result.defaultModel).toBe('default')
    expect(result.setupConfig.providers[0]?.models[0]?.id).toBe('global-default')
    expect(result.setupConfig.runner?.timeoutMs).toBe(100)
  })

  it('keeps project model matching when the project configures a model', async () => {
    const io = await createTestIo()

    await writeSetupConfig(getGlobalSetupConfigPath(io.env), {
      providers: [
        {
          endpoint: 'https://global.example/v1',
          id: 'global',
          models: [
            {
              aliases: ['default'],
              id: 'global-default',
            },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    })
    await writeSetupConfig(getProjectSetupConfigPath(io.cwd), {
      providers: [
        {
          endpoint: 'https://project.example/v1',
          id: 'project',
          models: [
            { id: 'project-model' },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    })

    const result = await loadRunSetupConfig(io)

    expect(result.defaultModel).toBeUndefined()
    expect(result.setupConfig.providers[0]?.models[0]?.id).toBe('project-model')
  })

  it('keeps project model matching when the project configures an ACP-driven model', async () => {
    const io = await createTestIo()

    await writeSetupConfig(getProjectSetupConfigPath(io.cwd), {
      providers: [
        {
          id: 'acp',
          models: [
            { command: 'codex-acp', driver: 'acp', id: 'codex' },
          ],
        },
      ],
      version: 1,
    })

    const result = await loadRunSetupConfig(io)

    expect(result.defaultModel).toBeUndefined()
    expect(result.setupConfig.providers[0]?.models[0]?.id).toBe('codex')
  })
})

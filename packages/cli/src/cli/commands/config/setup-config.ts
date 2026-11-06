import type { SetupConfig } from '@alint-js/config'

import type { CliIo } from '../../types'

import process from 'node:process'

import { getGlobalSetupConfigPath, getProjectSetupConfigPath, loadSetupConfig, mergeSetupConfigs } from '@alint-js/config'

import { escapeLineValue } from '../../output'

export interface ScopedSetupConfig {
  config: SetupConfig
  path: string
  scope: SetupConfigScope
}

export type SetupConfigScope = 'global' | 'local'

export function formatUnknownProvider(providerId: string, scope: SetupConfigScope): string {
  const hint = scope === 'local'
    ? ' Remove --local to inspect global configuration.'
    : ' Add --local to inspect project-local configuration.'

  return `unknown provider "${escapeLineValue(providerId)}" in ${scope} setup config.${hint}\n`
}

export async function loadMergedSetupConfig(io: CliIo): Promise<SetupConfig> {
  const { globalSetupConfig, projectSetupConfig } = await loadSetupConfigs(io)

  return mergeSetupConfigs(globalSetupConfig, projectSetupConfig)
}

export async function loadRunSetupConfig(io: CliIo): Promise<{
  defaultModel?: string
  setupConfig: SetupConfig
}> {
  const { globalSetupConfig, projectSetupConfig } = await loadSetupConfigs(io)

  return {
    defaultModel: projectSetupConfig.providers.some(provider => provider.models.length > 0)
      ? undefined
      : 'default',
    setupConfig: mergeSetupConfigs(globalSetupConfig, projectSetupConfig),
  }
}

export async function loadScopedSetupConfig(io: CliIo, local: boolean | undefined): Promise<ScopedSetupConfig> {
  const scope: SetupConfigScope = local === true
    ? 'local'
    : 'global'
  const path = scope === 'local'
    ? getProjectSetupConfigPath(io.cwd)
    : getGlobalSetupConfigPath(io.env ?? process.env)

  return { config: await loadSetupConfig(path), path, scope }
}

async function loadSetupConfigs(io: CliIo): Promise<{
  globalSetupConfig: SetupConfig
  projectSetupConfig: SetupConfig
}> {
  const globalSetupConfigPath = getGlobalSetupConfigPath(io.env ?? process.env)
  const projectSetupConfigPath = getProjectSetupConfigPath(io.cwd)
  const [globalSetupConfig, projectSetupConfig] = await Promise.all([
    loadSetupConfig(globalSetupConfigPath),
    loadSetupConfig(projectSetupConfigPath),
  ])

  return { globalSetupConfig, projectSetupConfig }
}

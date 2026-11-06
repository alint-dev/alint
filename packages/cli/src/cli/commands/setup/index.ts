import type { SetupConfig } from '@alint-js/config'

import type { CliIo } from '../../types'

import process from 'node:process'

import { getGlobalSetupConfigPath, getProjectSetupConfigPath, loadSetupConfig, mergeSetupConfigs, writeSetupConfig } from '@alint-js/config'

import { parseHeaderList } from '../../provider-registry'
import { defineCommand } from '../command'
import { runInteractiveSetup } from './interactive'

export interface SetupCommandOptions {
  local?: boolean
  noInteractive?: boolean
  providerEndpoint?: string
  providerHeader?: string | string[]
  providerId?: string
  providerModel?: string | string[]
}

export const setup = defineCommand({
  action: (context, options: SetupCommandOptions) =>
    runSetupCommand({
      ...options,
      noInteractive: context.setupNoInteractive,
    }, context.io),
  description: 'Write alint provider configuration',
  examples: [
    [
      '# Configure a provider interactively',
      'alint setup',
    ].join('\n'),
    [
      '# Write a project-local provider config without prompts',
      'alint setup --local -N --provider-id openrouter --provider-endpoint https://openrouter.ai/api/v1 --provider-model z-ai/glm-5.2',
    ].join('\n'),
    [
      '# Add an authorization header for an OpenAI-compatible provider',
      'alint setup --local -N --provider-id openrouter --provider-endpoint https://openrouter.ai/api/v1 --provider-model z-ai/glm-5.2 --provider-header "Authorization=Bearer $OPENROUTER_API_KEY"',
    ].join('\n'),
  ],
  help: [
    'Write alint provider and model configuration.',
    'Run without flags for interactive setup, or use `-N` with provider flags in scripts and CI. Use `--local` when the provider config should live with the current project instead of the user-level setup file.',
  ].join('\n\n'),
  name: 'setup',
  options: [
    { description: 'Write project-local config', flags: '--local' },
    { description: 'Disable interactive setup', flags: '-N, --no-interactive' },
    { description: 'Provider endpoint', flags: '--provider-endpoint <endpoint>' },
    { description: 'Provider id', flags: '--provider-id <id>' },
    { description: 'Provider model', flags: '--provider-model <model>' },
    { description: 'Provider header', flags: '--provider-header <Key=Value>' },
  ],
})

function createSetupConfig(
  providerId: string,
  providerEndpoint: string,
  options: SetupCommandOptions,
): SetupConfig {
  const models = toArray(options.providerModel).map(model => ({
    id: model,
    name: model,
  }))

  return {
    providers: [
      {
        endpoint: providerEndpoint,
        headers: parseHeaderList(toArray(options.providerHeader)),
        id: providerId,
        models,
        type: 'openai-compatible',
      },
    ],
    version: 1,
  }
}

async function runSetupCommand(
  options: SetupCommandOptions,
  io: CliIo,
): Promise<number> {
  if (!options.providerEndpoint) {
    if (options.noInteractive !== true) {
      return runInteractiveSetup({ ...io, stdin: io.stdin ?? process.stdin })
    }

    io.stderr.write('setup requires --provider-endpoint in --no-interactive mode.\n')
    return 2
  }

  if (!options.providerId) {
    io.stderr.write('setup requires --provider-id in --no-interactive mode.\n')
    return 2
  }

  const setupConfigPath = options.local
    ? getProjectSetupConfigPath(io.cwd)
    : getGlobalSetupConfigPath(io.env ?? process.env)
  const existingConfig = await loadSetupConfig(setupConfigPath)
  const nextConfig = mergeSetupConfigs(
    existingConfig,
    createSetupConfig(options.providerId, options.providerEndpoint, options),
  )

  await writeSetupConfig(setupConfigPath, nextConfig)
  return 0
}

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return []
  }

  return (Array.isArray(value)
    ? value
    : [value]).filter(
    (item): item is string => typeof item === 'string',
  )
}

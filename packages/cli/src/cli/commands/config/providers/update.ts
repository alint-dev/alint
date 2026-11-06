import type { ProviderDefinition, SetupConfig } from '@alint-js/config'

import type { ProviderSetupSource } from '../../../provider-registry'
import type { CommandContext } from '../../command'

import {
  addProviderModels,
  replaceSetupProvider,
  writeSetupConfig,
} from '@alint-js/config'
import { errorMessageFrom } from '@moeru/std/error'

import {
  findProviderSetupSource,
  findProviderSetupSourceByEndpoint,
  parseHeaderList,
  probeModels,
} from '../../../provider-registry'
import { runProviderEditor } from '../../../tui/provider-editor'
import { applyDefaultAlias } from '../../../tui/provider-editor/model-selection'
import { defineCommand } from '../../command'
import { formatUnknownProvider, loadScopedSetupConfig } from '../setup-config'

export interface UpdateProviderOptions {
  local?: boolean
  provider?: string | string[]
  providerEndpoint?: string | string[]
  providerHeader?: string | string[]
  providerModel?: string | string[]
}

export const update = defineCommand({
  action: runUpdateProviderCommand,
  description: 'Update a configured provider',
  name: 'update',
  options: [
    { description: 'Provider id', flags: '--provider <id>' },
    { description: 'Read and write project-local config', flags: '--local' },
    { description: 'Disable interactive editing', flags: '-N, --no-interactive' },
    { description: 'Replace provider endpoint before probing', flags: '--provider-endpoint <endpoint>' },
    { description: 'Add or replace provider header', flags: '--provider-header <Key=Value>' },
    { description: 'Add a model in addition to probed models', flags: '--provider-model <model>' },
  ],
})

export function providerUpdateSource(endpoint: string): ProviderSetupSource {
  const custom = findProviderSetupSource('custom')!

  try {
    return findProviderSetupSourceByEndpoint(endpoint) ?? custom
  }
  catch {
    // Invalid stored endpoints must remain editable through the custom flow.
    return custom
  }
}

function mergeProviderHeaders(
  existing: Record<string, string> | undefined,
  replacements: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const headers = { ...existing }

  for (const [replacementName, replacementValue] of Object.entries(replacements ?? {})) {
    for (const existingName of Object.keys(headers)) {
      if (existingName.toLowerCase() === replacementName.toLowerCase()) {
        delete headers[existingName]
      }
    }

    headers[replacementName] = replacementValue
  }

  return Object.keys(headers).length > 0
    ? headers
    : undefined
}

async function runNonInteractiveUpdate(
  context: CommandContext,
  options: UpdateProviderOptions,
  providerEndpoint: string | undefined,
  existingProvider: ProviderDefinition,
  config: SetupConfig,
  path: string,
): Promise<number> {
  const endpoint = providerEndpoint ?? existingProvider.endpoint

  if (endpoint === undefined) {
    context.io.stderr.write(`provider "${existingProvider.id}" has no remote endpoint to update.\n`)
    return 2
  }

  let parsedHeaders: Record<string, string> | undefined

  try {
    parsedHeaders = parseHeaderList(toArray(options.providerHeader))
  }
  catch (error) {
    context.io.stderr.write(`${errorMessageFrom(error) ?? 'Invalid provider header.'}\n`)
    return 2
  }

  const draft: ProviderDefinition = {
    ...existingProvider,
    endpoint,
    headers: mergeProviderHeaders(existingProvider.headers, parsedHeaders),
  }

  let remoteModelIds: string[]
  try {
    remoteModelIds = await probeModels(endpoint, draft.headers)
  }
  catch (error) {
    context.io.stderr.write(`failed to probe provider: ${errorMessageFrom(error) ?? 'Unknown error.'}\n`)
    return 2
  }

  const replaced = replaceSetupProvider(config, draft)
  const withRemoteModels = addProviderModels(replaced, draft.id, remoteModelIds)
  const nextConfig = addProviderModels(withRemoteModels, draft.id, toArray(options.providerModel))

  await writeSetupConfig(path, nextConfig)
  return 0
}

/**
 * Updates one provider in the explicitly selected setup-config scope.
 *
 * Triggering workflow:
 *
 * {@link registerCommandTree}
 *   -> `config providers update`
 *     -> {@link runUpdateProviderCommand}
 *
 * Upstream:
 * - {@link dispatchCommand}
 *
 * Downstream:
 * - {@link runProviderEditor}
 * - {@link probeModels}
 * - {@link writeSetupConfig}
 */
async function runUpdateProviderCommand(
  context: CommandContext,
  options: UpdateProviderOptions,
): Promise<number> {
  let providerEndpoint: string | undefined
  let providerId: string | undefined

  try {
    providerId = scalarOption(options.provider, '--provider')
    providerEndpoint = scalarOption(options.providerEndpoint, '--provider-endpoint')
  }
  catch (error) {
    context.io.stderr.write(`${errorMessageFrom(error) ?? 'Invalid provider update option.'}\n`)
    return 2
  }

  if (providerId === undefined) {
    context.io.stderr.write('config providers update requires --provider.\n')
    return 2
  }

  const { config, path, scope } = await loadScopedSetupConfig(context.io, options.local)
  const existingProvider = config.providers.find(provider => provider.id === providerId)

  if (existingProvider === undefined) {
    context.io.stderr.write(formatUnknownProvider(providerId, scope))
    return 2
  }

  const endpoint = providerEndpoint ?? existingProvider.endpoint

  if (endpoint === undefined) {
    context.io.stderr.write(`provider "${existingProvider.id}" has no remote endpoint to update.\n`)
    return 2
  }

  if (context.setupNoInteractive) {
    return runNonInteractiveUpdate(context, options, providerEndpoint, existingProvider, config, path)
  }

  const result = await runProviderEditor({
    config,
    existingProvider: { ...existingProvider, endpoint },
    io: context.io,
    mode: 'update',
    source: providerUpdateSource(endpoint),
  })

  if (result.status !== 'confirmed') {
    return 0
  }

  const replaced = replaceSetupProvider(config, result.provider)
  const nextConfig = result.defaultAliasTarget === undefined
    ? replaced
    : applyDefaultAlias(replaced, result.defaultAliasTarget)

  await writeSetupConfig(path, nextConfig)
  return 0
}

function scalarOption(value: string | string[] | undefined, flag: string): string | undefined {
  if (Array.isArray(value)) {
    throw new TypeError(`config providers update accepts ${flag} only once.`)
  }

  return value
}

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return []
  }

  return Array.isArray(value)
    ? value
    : [value]
}

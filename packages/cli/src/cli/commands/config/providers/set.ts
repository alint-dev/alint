import type { CommandContext } from '../../command'

import {
  setProviderEndpoint,
  setProviderHeader,
  writeSetupConfig,
} from '@alint-js/config'

import { escapeLineValue } from '../../../output'
import { isValidProviderHeaderName } from '../../../provider-registry'
import { defineCommand } from '../../command'
import { formatUnknownProvider, loadScopedSetupConfig } from '../setup-config'

export interface SetProviderOptions {
  local?: boolean
  provider?: string | string[]
}

export const set = defineCommand({
  action: runSetProviderCommand,
  arguments: '<key> <value>',
  description: 'Set a provider configuration field',
  exactArguments: true,
  name: 'set',
  options: [
    { description: 'Provider id', flags: '--provider <id>' },
    { description: 'Read and write project-local config', flags: '--local' },
  ],
})

/**
 * Sets one provider field in the explicitly selected setup-config scope.
 *
 * Triggering workflow:
 *
 * {@link registerCommandTree}
 *   -> `config providers set`
 *     -> {@link runSetProviderCommand}
 *
 * Upstream:
 * - {@link dispatchCommand}
 *
 * Downstream:
 * - {@link setProviderEndpoint}
 * - {@link setProviderHeader}
 * - {@link writeSetupConfig}
 */
async function runSetProviderCommand(
  context: CommandContext,
  key: string,
  value: string,
  options: SetProviderOptions,
): Promise<number> {
  const providerId = scalarProvider(options.provider)

  if (Array.isArray(options.provider)) {
    context.io.stderr.write('config providers set accepts --provider only once.\n')
    return 2
  }

  if (providerId === undefined) {
    context.io.stderr.write('config providers set requires --provider.\n')
    return 2
  }

  const { config, path, scope } = await loadScopedSetupConfig(context.io, options.local)

  if (!config.providers.some(provider => provider.id === providerId)) {
    context.io.stderr.write(formatUnknownProvider(providerId, scope))
    return 2
  }

  let nextConfig
  if (key === 'endpoint') {
    nextConfig = setProviderEndpoint(config, providerId, value)
  }
  else if (key.startsWith('headers.') && key.length > 'headers.'.length) {
    const headerName = key.slice('headers.'.length)

    if (!isValidProviderHeaderName(headerName)) {
      context.io.stderr.write('invalid provider header name. expected an HTTP field-name token.\n')
      return 2
    }

    nextConfig = setProviderHeader(config, providerId, headerName, value)
  }
  else {
    context.io.stderr.write(`unsupported provider key "${escapeLineValue(key)}". expected endpoint or headers.<name>.\n`)
    return 2
  }

  await writeSetupConfig(path, nextConfig)
  context.io.stdout.write(`provider: ${escapeLineValue(providerId)}\nkey: ${escapeLineValue(key)}\nscope: ${scope}\n`)
  return 0
}

function scalarProvider(provider: string | string[] | undefined): string | undefined {
  return Array.isArray(provider)
    ? undefined
    : provider
}

import type { CommandContext } from '../../command'

import { unsetProviderHeader, writeSetupConfig } from '@alint-js/config'

import { escapeLineValue } from '../../../output'
import { isValidProviderHeaderName } from '../../../provider-registry'
import { defineCommand } from '../../command'
import { formatUnknownProvider, loadScopedSetupConfig } from '../setup-config'

export interface UnsetProviderOptions {
  local?: boolean
  provider?: string | string[]
}

export const unset = defineCommand({
  action: runUnsetProviderCommand,
  arguments: '<key>',
  description: 'Unset a provider configuration field',
  exactArguments: true,
  name: 'unset',
  options: [
    { description: 'Provider id', flags: '--provider <id>' },
    { description: 'Read and write project-local config', flags: '--local' },
  ],
})

/**
 * Unsets one provider header in the explicitly selected setup-config scope.
 *
 * Triggering workflow:
 *
 * {@link registerCommandTree}
 *   -> `config providers unset`
 *     -> {@link runUnsetProviderCommand}
 *
 * Upstream:
 * - {@link dispatchCommand}
 *
 * Downstream:
 * - {@link unsetProviderHeader}
 * - {@link writeSetupConfig}
 */
async function runUnsetProviderCommand(
  context: CommandContext,
  key: string,
  options: UnsetProviderOptions,
): Promise<number> {
  const providerId = scalarProvider(options.provider)

  if (Array.isArray(options.provider)) {
    context.io.stderr.write('config providers unset accepts --provider only once.\n')
    return 2
  }

  if (providerId === undefined) {
    context.io.stderr.write('config providers unset requires --provider.\n')
    return 2
  }

  const { config, path, scope } = await loadScopedSetupConfig(context.io, options.local)

  if (!config.providers.some(provider => provider.id === providerId)) {
    context.io.stderr.write(formatUnknownProvider(providerId, scope))
    return 2
  }

  if (key === 'endpoint') {
    context.io.stderr.write('provider endpoint cannot be unset.\n')
    return 2
  }

  if (!key.startsWith('headers.') || key.length === 'headers.'.length) {
    context.io.stderr.write(`unsupported provider key "${escapeLineValue(key)}". expected headers.<name>.\n`)
    return 2
  }

  const headerName = key.slice('headers.'.length)

  if (!isValidProviderHeaderName(headerName)) {
    context.io.stderr.write('invalid provider header name. expected an HTTP field-name token.\n')
    return 2
  }

  const nextConfig = unsetProviderHeader(config, providerId, headerName)
  await writeSetupConfig(path, nextConfig)
  context.io.stdout.write(`provider: ${escapeLineValue(providerId)}\nkey: ${escapeLineValue(key)}\nscope: ${scope}\n`)
  return 0
}

function scalarProvider(provider: string | string[] | undefined): string | undefined {
  return Array.isArray(provider)
    ? undefined
    : provider
}

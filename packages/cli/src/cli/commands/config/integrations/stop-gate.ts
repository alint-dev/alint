import type { StopGateTarget } from '@alint-js/core'

import type { CommandContext } from '../../command'

import { loadAlintConfigWithMetadata, setStopGateConfig } from '@alint-js/config'
import { defaultStopGateConfig, maximumStopGateTimeoutMs, resolveStopGateConfig } from '@alint-js/core'
import { errorMessageFrom } from '@moeru/std'

import { defineCommand } from '../../command'

interface StopGateCommandOptions {
  config?: string
  target?: string
  timeoutMs?: string
}

const set = defineCommand({
  async action(context, options: StopGateCommandOptions) {
    try {
      let target: StopGateTarget | undefined
      if (options.target === undefined) {
        target = undefined
      }
      else if (options.target === 'all' || options.target === 'dirty-files') {
        target = options.target
      }
      else {
        throw new Error('Stop Gate target must be "all" or "dirty-files".')
      }

      let timeoutMs: number | undefined
      if (options.timeoutMs !== undefined) {
        timeoutMs = Number(options.timeoutMs)
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > maximumStopGateTimeoutMs) {
          throw new Error(`Stop Gate timeout must be an integer from 1 to ${maximumStopGateTimeoutMs}.`)
        }
      }

      const result = await setStopGateConfig({
        configFile: options.config,
        cwd: context.io.cwd,
        target,
        timeoutMs,
      })

      context.io.stdout.write(`config: ${result.configFile}\n`)
      writeResolvedConfig(chunk => context.io.stdout.write(chunk), result.config)
      return 0
    }
    catch (error) {
      context.io.stderr.write(`${errorMessageFrom(error) ?? 'Failed to write Stop Gate config.'}\n`)
      return 2
    }
  },
  description: 'Set Stop Gate config overrides in TOML',
  exactArguments: true,
  name: 'set',
  options: [
    { description: 'Lint target mode', flags: '--target <target>' },
    { description: 'Overall Stop Gate timeout in milliseconds', flags: '--timeout-ms <ms>' },
  ],
})

const enable = defineCommand({
  action: (context: CommandContext) => setActivation(context, true),
  description: 'Enable Stop Gate for this repository',
  exactArguments: true,
  name: 'enable',
})

const disable = defineCommand({
  action: (context: CommandContext) => setActivation(context, false),
  description: 'Disable Stop Gate for this repository',
  exactArguments: true,
  name: 'disable',
})

const show = defineCommand({
  async action(context, options: StopGateCommandOptions) {
    try {
      const loaded = await loadAlintConfigWithMetadata(context.io.cwd, options.config)
      const resolved = resolveStopGateConfig(loaded.config, context.io.cwd)

      context.io.stdout.write(`config: ${loaded.configFile ?? '<not found>'}\n`)
      writeResolvedConfig(chunk => context.io.stdout.write(chunk), resolved)
      return 0
    }
    catch (error) {
      context.io.stderr.write(`${errorMessageFrom(error) ?? 'Failed to read Stop Gate config.'}\n`)
      return 2
    }
  },
  description: 'Show resolved Stop Gate config',
  exactArguments: true,
  name: 'show',
})

export const stopGate = defineCommand({
  children: [show, set, enable, disable],
  description: 'Manage Stop Gate integration config',
  examples: [
    'alint config integrations stop-gate show',
    'alint config integrations stop-gate enable',
    'alint config integrations stop-gate disable',
    'alint config integrations stop-gate set --target all --timeout-ms 1800000',
  ],
  name: 'stop-gate',
})

async function setActivation(context: CommandContext, enabled: boolean): Promise<number> {
  try {
    const result = await setStopGateConfig({ cwd: context.io.cwd, enabled })

    context.io.stdout.write(`config: ${result.configFile}\n`)
    writeResolvedConfig(chunk => context.io.stdout.write(chunk), result.config)
    return 0
  }
  catch (error) {
    context.io.stderr.write(`${errorMessageFrom(error) ?? 'Failed to write Stop Gate activation.'}\n`)
    return 2
  }
}

function writeResolvedConfig(
  write: (chunk: string) => unknown,
  config: typeof defaultStopGateConfig,
): void {
  write(`enabled: ${config.enabled}${config.enabled === defaultStopGateConfig.enabled
    ? ' (default)'
    : ''}\n`)
  write(`target: ${config.target}${config.target === defaultStopGateConfig.target
    ? ' (default)'
    : ''}\n`)
  write(`timeoutMs: ${config.timeoutMs}${config.timeoutMs === defaultStopGateConfig.timeoutMs
    ? ' (default)'
    : ''}\n`)
}

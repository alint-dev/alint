import type {
  AcpProviderConfig,
  SetupConfig as FileSetupConfig,
  ModelAdapterProvider,
} from '@alint-js/config'
import type { SetupConfig } from '@alint-js/core'

import type { CliIo } from '../types'

import process from 'node:process'

import { normalizeSetupConfig } from '@alint-js/config'
import { createCommandModel, startGateway } from '@alint-js/model-adapter-acp'
import { resolve } from 'pathe'

export interface ModelAdapterRuntime {
  setupConfig: SetupConfig
  shutdown: () => Promise<void>
}

interface AcpAdapter {
  provider: (provider: AcpProviderConfig) => Promise<ModelAdapterProvider>
  shutdown: () => Promise<void>
}

/**
 * Normalizes file configuration and starts its model adapters.
 *
 * Triggering workflow:
 *
 * `runLintCommand | runListModelsCommand`
 *   -> {@link startModelAdapters}
 *     -> {@link createAcpAdapter}
 *       -> {@link normalizeSetupConfig}
 *         -> `AcpAdapter.provider`
 *           -> {@link startGateway}
 *
 * Upstream:
 * - `runLintCommand`
 * - `runListModelsCommand`
 *
 * Downstream:
 * - {@link normalizeSetupConfig}
 * - {@link startGateway}
 */
export async function startModelAdapters(
  config: FileSetupConfig,
  io: CliIo,
): Promise<ModelAdapterRuntime> {
  const acp = createAcpAdapter(io)

  try {
    return {
      setupConfig: await normalizeSetupConfig(config, { acp: acp.provider }),
      shutdown: acp.shutdown,
    }
  }
  catch (error) {
    await acp.shutdown()
    throw error
  }
}

/** Owns the ACP processes and loopback gateways used by one CLI operation. */
function createAcpAdapter(io: CliIo): AcpAdapter {
  const shutdowns: Array<() => Promise<void>> = []

  return {
    provider: async (provider) => {
      const gateway = await startGateway({
        cwd: io.cwd,
        models: provider.models.map(model => createCommandModel({
          args: model.args,
          command: model.command,
          cwd: resolve(io.cwd, model.cwd ?? '.'),
          env: {
            ...(io.env ?? process.env),
            ...model.env,
          },
          id: model.id,
          name: model.name ?? model.id,
          onStderr: createStderrWriter(io, model.id),
        })),
      })
      shutdowns.push(gateway.shutdown)

      return {
        endpoint: gateway.endpoint,
        type: 'openai-compatible',
      }
    },
    shutdown: async () => {
      await Promise.all(shutdowns.map(shutdown => shutdown()))
    },
  }
}

/**
 * Creates the CLI stderr sink for non-protocol output emitted by an ACP command.
 *
 * Triggering workflow:
 *
 * {@link createCommandModel}
 *   -> `ChildProcess.stderr:data`
 *     -> {@link createStderrWriter}
 *
 * Upstream:
 * - {@link createAcpAdapter}
 *
 * Downstream:
 * - {@link CliIo.stderr}
 */
function createStderrWriter(io: CliIo, modelId: string): (text: string) => void {
  return text => io.stderr.write(`[acp:${modelId}] ${text}`)
}

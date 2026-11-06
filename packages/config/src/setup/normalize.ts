import type {
  ProviderDefinition,
  RunnerConfig,
  SetupConfig as RuntimeSetupConfig,
  SetupModelDefinition,
} from '@alint-js/core'

import type { AcpModelConfig, ProviderConfig, SetupConfig } from './types'

import { isAcpModel, modelFromAcpModel } from './types'

export interface AcpProviderConfig {
  id: string
  models: AcpModelConfig[]
}

export interface ModelAdapterProvider {
  endpoint: string
  headers?: Record<string, string>
  type: ProviderDefinition['type']
}

export interface SetupModelAdapters {
  acp: (provider: AcpProviderConfig) => Promise<ModelAdapterProvider>
}

/** Normalizes setup-file providers while delegating only model-driven transports. */
export async function normalizeSetupConfig(
  config: SetupConfig,
  adapters: SetupModelAdapters,
): Promise<RuntimeSetupConfig> {
  const providers: ProviderDefinition[] = []

  for (const provider of config.providers) {
    const acpModels = provider.models.filter(isAcpModel)

    if (acpModels.length === 0) {
      if (provider.models.length > 0) {
        const normalizedProvider = providerFromConfig(provider)
        normalizedProvider.models.push(...provider.models.map(cloneModel))
        providers.push(normalizedProvider)
      }

      continue
    }

    const acpProvider = await adapters.acp({
      id: provider.id,
      models: acpModels.map(cloneAcpModel),
    })
    let activeDriver: 'acp' | 'provider' | undefined
    let activeProvider: ProviderDefinition | undefined

    for (const model of provider.models) {
      const driver = isAcpModel(model)
        ? 'acp'
        : 'provider'
      const normalizedModel = cloneModel(isAcpModel(model)
        ? modelFromAcpModel(model)
        : model)

      if (driver === activeDriver && activeProvider !== undefined) {
        activeProvider.models.push(normalizedModel)
        continue
      }

      activeDriver = driver
      activeProvider = driver === 'acp'
        ? providerFromAdapter(provider.id, acpProvider)
        : providerFromConfig(provider)
      activeProvider.models.push(normalizedModel)
      providers.push(activeProvider)
    }
  }

  return {
    providers,
    ...(config.runner === undefined
      ? {}
      : {
          runner: cloneRunner(config.runner),
        }),
    version: 1,
  }
}

function cloneAcpModel(model: AcpModelConfig): AcpModelConfig {
  return {
    ...model,
    aliases: model.aliases
      ? [...model.aliases]
      : undefined,
    args: model.args
      ? [...model.args]
      : undefined,
    capabilities: model.capabilities
      ? [...model.capabilities]
      : undefined,
    defaultParams: model.defaultParams
      ? { ...model.defaultParams }
      : undefined,
    env: model.env
      ? { ...model.env }
      : undefined,
  }
}

function cloneModel(model: SetupModelDefinition): SetupModelDefinition {
  return {
    ...model,
    aliases: model.aliases
      ? [...model.aliases]
      : undefined,
    capabilities: model.capabilities
      ? [...model.capabilities]
      : undefined,
    defaultParams: model.defaultParams
      ? { ...model.defaultParams }
      : undefined,
  }
}

function cloneRunner(runner: RunnerConfig): RunnerConfig {
  return {
    ...runner,
    cache: typeof runner.cache === 'object'
      ? { ...runner.cache }
      : runner.cache,
    stats: typeof runner.stats === 'object'
      ? { ...runner.stats }
      : runner.stats,
  }
}

function providerFromAdapter(
  id: string,
  provider: ModelAdapterProvider,
): ProviderDefinition {
  return {
    ...provider,
    headers: provider.headers
      ? { ...provider.headers }
      : undefined,
    id,
    models: [],
  }
}

function providerFromConfig(provider: ProviderConfig): ProviderDefinition {
  if (provider.endpoint === undefined) {
    throw new Error(`Provider "${provider.id}" requires endpoint for models without a driver.`)
  }

  if (provider.type === undefined) {
    throw new Error(`Provider "${provider.id}" requires type for models without a driver.`)
  }

  return {
    endpoint: provider.endpoint,
    headers: provider.headers
      ? { ...provider.headers }
      : undefined,
    id: provider.id,
    models: [],
    type: provider.type,
  }
}

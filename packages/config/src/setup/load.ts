import type { ModelConfig, ProviderConfig, SetupConfig } from './types'

import { readFile } from 'node:fs/promises'

import { merge } from '@moeru/std/merge'

import { isENOENTError } from '../utils/fs'
import { parseSetupConfigToml } from './toml'
import { isAcpModel } from './types'

export const emptySetupConfig: SetupConfig = { providers: [], version: 1 }

export async function loadSetupConfig(filePath: string): Promise<SetupConfig> {
  try {
    return parseSetupConfigToml(await readFile(filePath, 'utf8'))
  }
  catch (error) {
    if (isENOENTError(error)) {
      return createEmptySetupConfig()
    }

    throw error
  }
}

export function mergeSetupConfigs(...configs: SetupConfig[]): SetupConfig {
  let providers: ProviderConfig[] = []
  let runner: SetupConfig['runner']
  const providersById = new Map<string, ProviderConfig>()

  for (const config of configs) {
    const configProviders: ProviderConfig[] = []

    if (config.runner !== undefined) {
      runner = {
        ...(runner ?? {}),
        ...config.runner,
      }
    }

    for (const provider of config.providers) {
      const existingProvider = providersById.get(provider.id)

      if (existingProvider === undefined) {
        const mergedProvider = cloneProvider(provider)
        providers.push(mergedProvider)
        providersById.set(provider.id, mergedProvider)
        configProviders.push(mergedProvider)
        continue
      }

      if (provider.endpoint !== undefined) {
        existingProvider.endpoint = provider.endpoint
      }

      if (provider.type !== undefined) {
        existingProvider.type = provider.type
      }
      configProviders.push(existingProvider)

      if (provider.headers !== undefined) {
        existingProvider.headers = {
          ...existingProvider.headers,
          ...provider.headers,
        }
      }

      const nextModels: ModelConfig[] = []

      for (const incomingModel of provider.models) {
        const existingModelIndex = existingProvider.models.findIndex(model => model.id === incomingModel.id)

        if (existingModelIndex === -1) {
          nextModels.push(cloneModel(incomingModel))
          continue
        }

        const existingModel = existingProvider.models[existingModelIndex]!
        existingProvider.models.splice(existingModelIndex, 1)
        nextModels.push(mergeModel(existingModel, incomingModel))
      }

      existingProvider.models = [
        ...nextModels,
        ...existingProvider.models,
      ]
    }

    providers = prioritizeProviders(providers, configProviders)
  }

  const mergedConfig: SetupConfig = {
    providers,
    version: 1,
  }

  if (runner !== undefined) {
    mergedConfig.runner = runner
  }

  return mergedConfig
}

function cloneModel(model: ModelConfig): ModelConfig {
  const clonedModel: ModelConfig = isAcpModel(model)
    ? {
        ...model,
        args: model.args
          ? [...model.args]
          : undefined,
        env: model.env
          ? { ...model.env }
          : undefined,
      }
    : { ...model }

  if (model.aliases !== undefined) {
    clonedModel.aliases = [...model.aliases]
  }

  if (model.capabilities !== undefined) {
    clonedModel.capabilities = [...model.capabilities]
  }

  if (model.defaultParams !== undefined) {
    clonedModel.defaultParams = { ...model.defaultParams }
  }

  return clonedModel
}

function cloneProvider(provider: ProviderConfig): ProviderConfig {
  const clonedProvider: ProviderConfig = {
    ...provider,
    models: provider.models.map(cloneModel),
  }

  if (provider.headers !== undefined) {
    clonedProvider.headers = { ...provider.headers }
  }

  return clonedProvider
}

function createEmptySetupConfig(): SetupConfig {
  return { providers: [], version: 1 }
}

function mergeModel(
  existingModel: ModelConfig,
  incomingModel: ModelConfig,
): ModelConfig {
  const existing = cloneModel(existingModel)
  const incoming = cloneModel(incomingModel)

  return merge<ModelConfig>(existing, incoming)
}

function prioritizeProviders(
  providers: ProviderConfig[],
  prioritizedProviders: ProviderConfig[],
): ProviderConfig[] {
  const prioritizedProviderIds = new Set(prioritizedProviders.map(provider => provider.id))

  return [
    ...prioritizedProviders,
    ...providers.filter(provider => !prioritizedProviderIds.has(provider.id)),
  ]
}

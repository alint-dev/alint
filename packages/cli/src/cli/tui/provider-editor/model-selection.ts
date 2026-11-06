import type { ProviderDefinition, SetupConfig, SetupModelDefinition } from '@alint-js/config'

import type { DefaultAliasTarget, ModelOption } from './types'

interface DefaultModelCandidate extends DefaultAliasTarget {
  isCurrentDefault: boolean
  isNew: boolean
  label: string
  value: string
}

export function applyDefaultAlias(config: SetupConfig, target: DefaultAliasTarget): SetupConfig {
  return {
    ...config,
    providers: config.providers.map(provider => ({
      ...provider,
      headers: provider.headers === undefined
        ? undefined
        : { ...provider.headers },
      models: provider.models.map((model) => {
        const aliasesWithoutDefault = (model.aliases ?? []).filter(alias => alias !== 'default')
        const aliases = provider.id === target.providerId && model.id === target.modelId
          ? [...aliasesWithoutDefault, 'default']
          : aliasesWithoutDefault

        return {
          ...cloneModel(model),
          aliases: aliases.length > 0
            ? aliases
            : undefined,
        }
      }),
    })),
  }
}

export function applyHeaderSelection(
  existingHeaders: Record<string, string>,
  retainedNames: readonly string[],
  replacements: Record<string, string>,
): Record<string, string> | undefined {
  const selectedNames = new Set(retainedNames.map(normalizeHeaderName))
  const headersByName = new Map<string, readonly [string, string]>()

  for (const [name, value] of Object.entries(existingHeaders)) {
    const normalizedName = normalizeHeaderName(name)

    if (selectedNames.has(normalizedName)) {
      headersByName.set(normalizedName, [name, value])
    }
  }

  for (const [name, value] of Object.entries(replacements)) {
    headersByName.set(normalizeHeaderName(name), [name, value])
  }

  const headers = Object.fromEntries(headersByName.values())

  return Object.keys(headers).length > 0
    ? headers
    : undefined
}

export function createDefaultModelCandidates(
  config: SetupConfig,
  newProviderId: string,
  newModelIds: string[],
): DefaultModelCandidate[] {
  const candidates: DefaultModelCandidate[] = []
  const seen = new Set<string>()
  const newModelIdSet = new Set(newModelIds)
  const allModels = config.providers.flatMap(provider =>
    provider.models.map(model => ({
      isCurrentDefault: (model.aliases ?? []).includes('default'),
      isNew: provider.id === newProviderId && newModelIdSet.has(model.id),
      model,
      provider,
      value: createDefaultModelCandidateValue(provider.id, model.id),
    })),
  )

  const addCandidate = (candidate: typeof allModels[number] | undefined): void => {
    if (candidate === undefined || seen.has(candidate.value)) {
      return
    }

    seen.add(candidate.value)
    candidates.push({
      isCurrentDefault: candidate.isCurrentDefault,
      isNew: candidate.isNew,
      label: `${candidate.provider.id} / ${candidate.model.id}`,
      modelId: candidate.model.id,
      providerId: candidate.provider.id,
      value: candidate.value,
    })
  }

  addCandidate(allModels.find(candidate => candidate.isCurrentDefault))

  for (const modelId of newModelIds) {
    addCandidate(allModels.find(candidate =>
      candidate.provider.id === newProviderId && candidate.model.id === modelId,
    ))
  }

  for (const candidate of allModels) {
    addCandidate(candidate)
  }

  return candidates
}

export function createModelOptions(
  provider: ProviderDefinition | undefined,
  discoveredIds: readonly string[],
): ModelOption[] {
  const discovered = new Set(discoveredIds)
  const existing = firstModelsById(provider)
  const optionIds = new Set(existing.keys())
  const options: ModelOption[] = [
    ...existing.values(),
  ].map(model => ({
    hint: discovered.has(model.id)
      ? undefined
      : 'not reported by provider',
    label: model.id,
    value: model.id,
  }))

  for (const modelId of discoveredIds) {
    if (optionIds.has(modelId)) {
      continue
    }

    optionIds.add(modelId)
    options.push({ hint: 'new', label: modelId, value: modelId })
  }

  return options
}

export function modelsFromSelection(
  provider: ProviderDefinition | undefined,
  selectedIds: readonly string[],
): SetupModelDefinition[] {
  const existing = firstModelsById(provider)
  const models: SetupModelDefinition[] = []
  const selected = new Set<string>()

  for (const modelId of selectedIds) {
    if (selected.has(modelId)) {
      continue
    }

    selected.add(modelId)
    const model = existing.get(modelId)
    models.push(model === undefined
      ? { id: modelId, name: modelId }
      : cloneModel(model))
  }

  return models
}

export function normalizeHeaderName(name: string): string {
  return name.toLowerCase()
}

function cloneModel(model: SetupModelDefinition): SetupModelDefinition {
  return {
    ...model,
    aliases: model.aliases === undefined
      ? undefined
      : [...model.aliases],
    capabilities: model.capabilities === undefined
      ? undefined
      : [...model.capabilities],
    defaultParams: model.defaultParams === undefined
      ? undefined
      : { ...model.defaultParams },
  }
}

function createDefaultModelCandidateValue(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`
}

function firstModelsById(provider: ProviderDefinition | undefined): Map<string, SetupModelDefinition> {
  const models = new Map<string, SetupModelDefinition>()

  // Duplicate model IDs are invalid, but editor transforms defensively keep the
  // first definition so option ordering and metadata lookup share one policy.
  for (const model of provider?.models ?? []) {
    if (!models.has(model.id)) {
      models.set(model.id, model)
    }
  }

  return models
}

import type {
  ProviderDefinition,
  SetupConfig,
  SetupModelDefinition,
} from '@alint-js/config'

export type ExactModelTargetResult
  = | { candidates: Array<{ modelId: string, providerId: string }>, status: 'ambiguous' }
    | { model: SetupModelDefinition, provider: ProviderDefinition, status: 'found' }
    | { modelId: string, provider?: ProviderDefinition, status: 'missing' }
    | { providerId: string, status: 'duplicate-provider' }
    | { providerId: string, status: 'unknown-provider' }
    | { qualifiedProviderId: string, requestedProviderId: string, status: 'conflict' }

export function resolveExactModelTarget(
  config: SetupConfig,
  request: string,
  requestedProviderId: string | undefined,
): ExactModelTargetResult {
  // A slash starts a provider qualifier only when its prefix names a provider in
  // this scope. Otherwise the complete request remains a valid slash-containing ID.
  const separatorIndex = request.indexOf('/')
  const qualifier = separatorIndex === -1
    ? undefined
    : request.slice(0, separatorIndex)
  const qualifiedProviders = qualifier === undefined
    ? []
    : config.providers.filter(provider => provider.id === qualifier)
  const qualifiedProviderId = qualifiedProviders[0]?.id
  const modelId = qualifiedProviders.length === 0
    ? request
    : request.slice(separatorIndex + 1)

  if (
    qualifiedProviderId !== undefined
    && requestedProviderId !== undefined
    && qualifiedProviderId !== requestedProviderId
  ) {
    return {
      qualifiedProviderId,
      requestedProviderId,
      status: 'conflict',
    }
  }

  const requestedProviders = requestedProviderId === undefined
    ? []
    : config.providers.filter(provider => provider.id === requestedProviderId)

  if (requestedProviderId !== undefined && requestedProviders.length === 0) {
    return { providerId: requestedProviderId, status: 'unknown-provider' }
  }

  const selectedProviders = qualifiedProviders.length > 0
    ? qualifiedProviders
    : requestedProviders
  const selectedProvider = selectedProviders[0]
  if (selectedProvider !== undefined && selectedProviders.length > 1) {
    return { providerId: selectedProvider.id, status: 'duplicate-provider' }
  }

  const searchedProviders = selectedProviders.length > 0
    ? selectedProviders
    : config.providers
  const matchingProviders = searchedProviders.filter(provider =>
    provider.models.some(model => model.id === modelId),
  )

  if (selectedProviders.length === 0) {
    const duplicateProvider = matchingProviders.find(provider =>
      config.providers.filter(candidate => candidate.id === provider.id).length > 1,
    )

    if (duplicateProvider !== undefined) {
      return { providerId: duplicateProvider.id, status: 'duplicate-provider' }
    }
  }

  const candidates = matchingProviders.flatMap((provider) => {
    const model = findExactModel(provider, modelId)
    return model === undefined
      ? []
      : [
          { model, provider },
        ]
  })

  if (candidates.length === 0) {
    return { modelId, provider: selectedProviders[0], status: 'missing' }
  }

  if (candidates.length > 1) {
    return {
      candidates: candidates.map(candidate => ({
        modelId: candidate.model.id,
        providerId: candidate.provider.id,
      })),
      status: 'ambiguous',
    }
  }

  return { ...candidates[0]!, status: 'found' }
}

function findExactModel(provider: ProviderDefinition, modelId: string): SetupModelDefinition | undefined {
  const matches = provider.models.filter(model => model.id === modelId)

  // Every duplicate row is removed together, so selecting a default-aliased row
  // ensures the caller blocks the whole mutation when any duplicate is protected.
  return matches.find(model => model.aliases?.includes('default')) ?? matches[0]
}

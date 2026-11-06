import type { ProviderDefinition, SetupConfig, SetupModelDefinition } from '../config/types'
import type { ModelRequirement, ResolvedModel, ResolveModelOptions } from './types'

interface ModelCandidate {
  model: SetupModelDefinition
  provider: ProviderDefinition
}

export class UnknownModelError extends Error {
  readonly request: string

  constructor(request: string) {
    super(`Unknown model "${request}".`)
    this.name = 'UnknownModelError'
    this.request = request
  }
}

export function resolveModel(
  registry: SetupConfig,
  options: ResolveModelOptions = {},
): ResolvedModel {
  const candidates = flattenModels(registry)
  const ruleId = options.ruleId ?? '<unknown>'

  if (options.request !== undefined) {
    const request = options.request
    const canonicalCandidates = candidates.filter(candidate => canonicalIdentity(candidate) === request)

    if (canonicalCandidates.length > 1) {
      throw duplicateDefinitionError(request)
    }

    let candidate = canonicalCandidates[0]

    if (candidate === undefined) {
      const matchingCandidates = candidates.filter(candidate => matchesRequest(candidate, request))
      const matchesByCanonical = new Map<string, ModelCandidate[]>()

      for (const matchingCandidate of matchingCandidates) {
        const identity = canonicalIdentity(matchingCandidate)
        const matches = matchesByCanonical.get(identity) ?? []
        matches.push(matchingCandidate)
        matchesByCanonical.set(identity, matches)
      }

      const duplicateIdentity = [...matchesByCanonical]
        .find(([, matches]) => matches.length > 1)?.[0]

      if (duplicateIdentity !== undefined) {
        throw duplicateDefinitionError(duplicateIdentity)
      }

      if (matchingCandidates.length === 0) {
        throw new UnknownModelError(request)
      }

      if (matchingCandidates.length > 1) {
        const choices = [
          ...matchesByCanonical.keys(),
        ]

        throw new Error(
          `Ambiguous model "${request}".\nSpecify a provider-qualified model:\n${choices.map(choice => `  ${choice}`).join('\n')}`,
        )
      }

      candidate = matchingCandidates[0]!
    }

    if (!satisfiesHardRequirements(candidate.model, options.requirement)) {
      throw new Error(
        `Model "${request}" does not satisfy requirement for rule "${ruleId}".`,
      )
    }

    return toResolvedModel(candidate, options.requirement)
  }

  const satisfyingCandidates = candidates.filter(({ model }) =>
    satisfiesHardRequirements(model, options.requirement),
  )

  const candidate = preferSize(satisfyingCandidates, options.requirement)

  if (candidate === undefined) {
    throw new Error(`No model satisfies requirement for rule "${ruleId}".`)
  }

  return toResolvedModel(candidate, options.requirement)
}

function canonicalIdentity({ model, provider }: ModelCandidate): string {
  return `${provider.id}/${model.id}`
}

function duplicateDefinitionError(identity: string): Error {
  return new Error(
    `Model "${identity}" is configured more than once.\nRemove duplicate provider/model definitions from the setup configuration.`,
  )
}

function flattenModels(registry: SetupConfig): ModelCandidate[] {
  return registry.providers.flatMap(provider =>
    provider.models.map(model => ({ model, provider })),
  )
}

function matchesRequest(candidate: ModelCandidate, request: string): boolean {
  const names = [
    candidate.model.id,
    candidate.model.name,
    ...(candidate.model.aliases ?? []),
  ].filter((name): name is string => name !== undefined)

  return names.some(name =>
    name === request || `${candidate.provider.id}/${name}` === request,
  )
}

function preferSize(
  candidates: ModelCandidate[],
  requirement: ModelRequirement | undefined,
): ModelCandidate | undefined {
  if (requirement?.size === undefined) {
    return candidates[0]
  }

  return candidates.find(({ model }) => model.size === requirement.size) ?? candidates[0]
}

function satisfiesHardRequirements(
  model: SetupModelDefinition,
  requirement: ModelRequirement | undefined,
): boolean {
  if (requirement === undefined) {
    return true
  }

  if (
    requirement.capabilities !== undefined
    && !requirement.capabilities.every(capability =>
      (model.capabilities ?? []).includes(capability),
    )
  ) {
    return false
  }

  if (
    requirement.minContextWindow !== undefined
    && (model.contextWindow === undefined || model.contextWindow < requirement.minContextWindow)
  ) {
    return false
  }

  return true
}

function toResolvedModel(
  candidate: ModelCandidate,
  requirement: ModelRequirement | undefined,
): ResolvedModel {
  const { model, provider } = candidate

  return {
    aliases: [
      ...(model.aliases ?? []),
    ],
    capabilities: [
      ...(model.capabilities ?? []),
    ],
    contextWindow: model.contextWindow,
    id: model.id,
    name: model.name ?? model.id,
    params: {
      ...(model.defaultParams ?? {}),
      ...(requirement?.params ?? {}),
    },
    provider: {
      endpoint: provider.endpoint,
      headers: {
        ...(provider.headers ?? {}),
      },
      id: provider.id,
      type: provider.type,
    },
    size: model.size,
  }
}

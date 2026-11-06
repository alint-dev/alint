import type { ProviderDefinition } from '@alint-js/config'

import type {
  DefaultAliasTarget,
  ProviderEditorInput,
  ProviderEditorPromptPort,
  ProviderEditorResult,
} from './types'

import { mergeSetupConfigs, replaceSetupProvider } from '@alint-js/config'

import { escapeLineValue } from '../../output'
import { createProviderId, parseHeaderList } from '../../provider-registry'
import {
  applyHeaderSelection,
  createDefaultModelCandidates,
  createModelOptions,
  modelsFromSelection,
  normalizeHeaderName,
} from './model-selection'
import { createProviderEditorPrompts } from './prompts'

interface EditorDraft {
  defaultAliasTarget?: DefaultAliasTarget
  discoveredModels: string[]
  endpoint?: string
  headerValues: Record<string, string>
  modelOptionIds?: string[]
  providerId?: string
  retainedHeaderNames: string[]
  selectedModelIds?: string[]
}

type EditorStep = 'confirm' | 'defaultAction' | 'defaultModel' | 'endpoint' | 'headerInput' | 'models' | 'providerId' | 'retainedHeaders'

/**
 * Runs one provider create/update request as a reversible prompt state machine.
 *
 * Triggering workflow:
 *
 * {@link runInteractiveSetup}
 *   -> {@link runProviderEditor}
 *     -> `provider-editor.prompt-result`
 *       -> {@link ProviderEditorResult}
 *
 * Upstream:
 * - {@link runInteractiveSetup}
 *
 * Downstream:
 * - {@link createProviderEditorPrompts} and the caller-owned setup-config write
 *
 * The editor reads the selected-scope config, changes only its in-memory draft,
 * and returns without persistence on Back, cancellation, or a negative confirmation.
 */
export async function runProviderEditor(
  input: ProviderEditorInput,
  promptPort?: ProviderEditorPromptPort,
): Promise<ProviderEditorResult> {
  const prompts = promptPort ?? createProviderEditorPrompts(await import('@clack/prompts'))

  if (input.source.kind === 'acp') {
    return runAcpProviderEditor(input, input.source, prompts)
  }

  const existingProvider = input.mode === 'update'
    ? input.existingProvider
    : undefined
  const configuredHeaders = { ...existingProvider?.headers }
  const initialHeaders = applyHeaderSelection(
    configuredHeaders,
    Object.keys(configuredHeaders),
    {},
  ) ?? {}
  const draft: EditorDraft = {
    discoveredModels: [],
    endpoint: existingProvider?.endpoint ?? input.source.defaultEndpoint,
    headerValues: initialHeaders,
    providerId: existingProvider?.id,
    retainedHeaderNames: Object.keys(initialHeaders),
  }
  let step: EditorStep = 'endpoint'

  while (true) {
    if (step === 'endpoint') {
      const endpoint = await prompts.endpoint(draft.endpoint)
      if (endpoint.status === 'cancelled') {
        return { status: 'cancelled' }
      }
      if (endpoint.status === 'back') {
        return { status: 'back' }
      }

      draft.endpoint = endpoint.value.trim()
      step = 'providerId'
      continue
    }

    if (step === 'providerId') {
      const initialProviderId = draft.providerId ?? createProviderId(
        draft.endpoint ?? '',
        new Set(input.config.providers.map(provider => provider.id)),
      )
      const providerId = await prompts.providerId(initialProviderId, input.mode === 'create')
      if (providerId.status === 'cancelled') {
        return { status: 'cancelled' }
      }
      if (providerId.status === 'back') {
        step = 'endpoint'
        continue
      }

      draft.providerId = providerId.value.trim()
      step = 'retainedHeaders'
      continue
    }

    if (step === 'retainedHeaders') {
      const headerNames = Object.keys(draft.headerValues)
      const retainedHeaders = await prompts.retainedHeaders(
        headerNames,
        draft.retainedHeaderNames.filter(name => headerNames.includes(name)),
      )
      if (retainedHeaders.status === 'cancelled') {
        return { status: 'cancelled' }
      }
      if (retainedHeaders.status === 'back') {
        step = 'providerId'
        continue
      }

      draft.retainedHeaderNames = retainedHeaders.value
      step = 'headerInput'
      continue
    }

    if (step === 'headerInput') {
      const headerInput = await prompts.headerInput()
      if (headerInput.status === 'cancelled') {
        return { status: 'cancelled' }
      }
      if (headerInput.status === 'back') {
        step = 'retainedHeaders'
        continue
      }

      const replacements = parseHeaderList(splitInput(headerInput.value)) ?? {}
      // Blank input is an additive no-op: selected draft headers may contain
      // replacements whose values must remain hidden and survive Back.
      const retainedLogicalNames = new Set([
        ...draft.retainedHeaderNames,
        ...Object.keys(replacements),
      ].map(normalizeHeaderName))
      draft.headerValues = applyHeaderSelection(
        draft.headerValues,
        Object.keys(draft.headerValues),
        replacements,
      ) ?? {}
      draft.retainedHeaderNames = Object.keys(draft.headerValues)
        .filter(name => retainedLogicalNames.has(normalizeHeaderName(name)))
      const headers = effectiveHeaders(draft) ?? {}
      draft.discoveredModels = input.source.probeModels
        ? await prompts.probe(draft.endpoint ?? '', headers)
        : []
      step = 'models'
      continue
    }

    if (step === 'models') {
      const options = createModelOptions(existingProvider, draft.discoveredModels)
      const optionIds = options.map(option => option.value)
      // Compare with the previous option universe so prior deselections remain
      // deselected while genuinely new probe results start selected.
      const initialValues = draft.selectedModelIds === undefined || draft.modelOptionIds === undefined
        ? optionIds
        : optionIds.filter(modelId =>
            draft.selectedModelIds?.includes(modelId) === true
            || !draft.modelOptionIds?.includes(modelId),
          )
      draft.modelOptionIds = optionIds
      const selectedModels = options.length === 0
        ? await prompts.manualModels()
        : await prompts.models(options, initialValues)
      if (selectedModels.status === 'cancelled') {
        return { status: 'cancelled' }
      }
      if (selectedModels.status === 'back') {
        step = 'headerInput'
        continue
      }

      draft.selectedModelIds = selectedModels.value
      step = 'defaultAction'
      continue
    }

    if (step === 'defaultAction') {
      const defaultAction = await prompts.defaultAction(draft.selectedModelIds?.[0] ?? '')
      if (defaultAction.status === 'cancelled') {
        return { status: 'cancelled' }
      }
      if (defaultAction.status === 'back') {
        step = 'models'
        continue
      }

      draft.defaultAliasTarget = defaultAction.value === 'yes'
        ? { modelId: draft.selectedModelIds?.[0] ?? '', providerId: draft.providerId ?? '' }
        : undefined

      const removesCurrentDefault = existingProvider?.models.some(model =>
        model.aliases?.includes('default') === true
        && !draft.selectedModelIds?.includes(model.id),
      ) === true
      step = defaultAction.value === 'selectAnother' || (defaultAction.value === 'no' && removesCurrentDefault)
        ? 'defaultModel'
        : 'confirm'
      continue
    }

    const provider = createProvider(input, draft)

    if (step === 'defaultModel') {
      const provisionalConfig = input.mode === 'update'
        ? replaceSetupProvider(input.config, provider)
        : mergeSetupConfigs(input.config, {
            providers: [provider],
            version: 1,
          })
      const existingModelIds = new Set(existingProvider?.models.map(model => model.id) ?? [])
      const addedModelIds = provider.models
        .map(model => model.id)
        .filter(modelId => !existingModelIds.has(modelId))
      const candidates = createDefaultModelCandidates(provisionalConfig, provider.id, addedModelIds)
      const selectedDefault = await prompts.defaultModel(candidates.map(candidate => ({
        hint: candidate.isCurrentDefault
          ? 'current default'
          : candidate.isNew ? 'new' : undefined,
        label: candidate.label,
        value: candidate.value,
      })))
      if (selectedDefault.status === 'cancelled') {
        return { status: 'cancelled' }
      }
      if (selectedDefault.status === 'back') {
        step = 'defaultAction'
        continue
      }

      const candidate = candidates.find(item => item.value === selectedDefault.value)
      if (candidate === undefined) {
        return { status: 'cancelled' }
      }

      draft.defaultAliasTarget = { modelId: candidate.modelId, providerId: candidate.providerId }
      step = 'confirm'
      continue
    }

    const confirmed = await prompts.confirm(createSummary(input, provider, draft.defaultAliasTarget))
    if (confirmed.status === 'cancelled' || (confirmed.status === 'submitted' && confirmed.value === 'no')) {
      return { status: 'cancelled' }
    }
    if (confirmed.status === 'back') {
      step = 'defaultAction'
      continue
    }

    return {
      defaultAliasTarget: draft.defaultAliasTarget,
      provider,
      status: 'confirmed',
    }
  }
}

function createAcpProvider(
  source: Extract<ProviderEditorInput['source'], { kind: 'acp' }>,
  providerId: string,
): ProviderDefinition {
  return {
    id: providerId,
    models: [
      {
        ...(source.args === undefined
          ? {}
          : {
              args: [...source.args],
            }),
        capabilities: ['tool-call'],
        command: source.command,
        driver: 'acp',
        ...source.model,
      },
    ],
  }
}

function createAcpSummary(
  input: ProviderEditorInput,
  provider: ProviderDefinition,
  defaultAliasTarget: DefaultAliasTarget | undefined,
): string {
  const model = provider.models[0]!

  return [
    `${input.mode === 'create'
      ? 'Create'
      : 'Update'} provider?`,
    `Provider: ${escapeLineValue(provider.id)}`,
    'Driver: ACP',
    `Command: ${escapeLineValue('command' in model
      ? model.command
      : '-')}`,
    `Arguments: ${'args' in model
      ? formatSummaryValues(model.args ?? [])
      : '(none)'}`,
    `Model: ${escapeLineValue(model.id)}`,
    `Default: ${defaultAliasTarget === undefined
      ? 'unchanged'
      : escapeLineValue(`${defaultAliasTarget.providerId}/${defaultAliasTarget.modelId}`)}`,
  ].join('\n')
}

function createProvider(
  input: ProviderEditorInput,
  draft: EditorDraft,
): ProviderDefinition {
  return {
    ...input.existingProvider,
    endpoint: draft.endpoint ?? '',
    headers: effectiveHeaders(draft),
    id: draft.providerId ?? '',
    models: modelsFromSelection(input.existingProvider, draft.selectedModelIds ?? []),
    type: 'openai-compatible',
  }
}

function createSummary(
  input: ProviderEditorInput,
  provider: ProviderDefinition,
  defaultAliasTarget: DefaultAliasTarget | undefined,
): string {
  const existingModelIds = new Set(input.existingProvider?.models.map(model => model.id) ?? [])
  const nextModelIds = new Set(provider.models.map(model => model.id))
  const additions = [...nextModelIds].filter(modelId => !existingModelIds.has(modelId))
  const removals = [...existingModelIds].filter(modelId => !nextModelIds.has(modelId))
  const defaultChange = defaultAliasTarget === undefined
    ? 'unchanged'
    : `${defaultAliasTarget.providerId}/${defaultAliasTarget.modelId}`

  return [
    `${input.mode === 'create'
      ? 'Create'
      : 'Update'} provider?`,
    `Provider: ${escapeLineValue(provider.id)}`,
    `Endpoint: ${escapeLineValue(provider.endpoint ?? '-')}`,
    `Headers: ${formatSummaryValues(Object.keys(provider.headers ?? {}))}`,
    `Added models: ${formatSummaryValues(additions)}`,
    `Removed models: ${formatSummaryValues(removals)}`,
    `Default: ${defaultAliasTarget === undefined
      ? defaultChange
      : escapeLineValue(defaultChange)}`,
  ].join('\n')
}

function effectiveHeaders(draft: EditorDraft): Record<string, string> | undefined {
  return applyHeaderSelection(draft.headerValues, draft.retainedHeaderNames, {})
}

function formatSummaryValues(values: readonly string[]): string {
  return values.length > 0
    ? values.map(escapeLineValue).join(', ')
    : '(none)'
}

/**
 * Runs the preset-backed ACP branch of the provider editor.
 *
 * Triggering workflow:
 *
 * {@link runInteractiveSetup}
 *   -> {@link runProviderEditor}
 *     -> `provider-editor.acp-preset`
 *       -> {@link runAcpProviderEditor}
 *
 * Upstream:
 * - {@link runProviderEditor}
 *
 * Downstream:
 * - {@link ProviderEditorResult} and the caller-owned setup-config write
 */
async function runAcpProviderEditor(
  input: ProviderEditorInput,
  source: Extract<ProviderEditorInput['source'], { kind: 'acp' }>,
  prompts: ProviderEditorPromptPort,
): Promise<ProviderEditorResult> {
  let defaultAliasTarget: DefaultAliasTarget | undefined
  let providerId = input.existingProvider?.id ?? source.defaultProviderId
  let step: 'confirm' | 'defaultAction' | 'defaultModel' | 'providerId' = 'providerId'

  while (true) {
    if (step === 'providerId') {
      const result = await prompts.providerId(providerId, input.mode === 'create')
      if (result.status === 'cancelled') {
        return { status: 'cancelled' }
      }
      if (result.status === 'back') {
        return { status: 'back' }
      }

      providerId = result.value.trim()
      step = 'defaultAction'
      continue
    }

    const provider = createAcpProvider(source, providerId)

    if (step === 'defaultAction') {
      const result = await prompts.defaultAction(source.model.id)
      if (result.status === 'cancelled') {
        return { status: 'cancelled' }
      }
      if (result.status === 'back') {
        step = 'providerId'
        continue
      }

      defaultAliasTarget = result.value === 'yes'
        ? { modelId: source.model.id, providerId }
        : undefined
      step = result.value === 'selectAnother'
        ? 'defaultModel'
        : 'confirm'
      continue
    }

    if (step === 'defaultModel') {
      const provisionalConfig = mergeSetupConfigs(input.config, {
        providers: [provider],
        version: 1,
      })
      const candidates = createDefaultModelCandidates(
        provisionalConfig,
        provider.id,
        [source.model.id],
      )
      const selectedDefault = await prompts.defaultModel(candidates.map(candidate => ({
        hint: candidate.isCurrentDefault
          ? 'current default'
          : candidate.isNew ? 'new' : undefined,
        label: candidate.label,
        value: candidate.value,
      })))
      if (selectedDefault.status === 'cancelled') {
        return { status: 'cancelled' }
      }
      if (selectedDefault.status === 'back') {
        step = 'defaultAction'
        continue
      }

      const candidate = candidates.find(item => item.value === selectedDefault.value)
      if (candidate === undefined) {
        return { status: 'cancelled' }
      }

      defaultAliasTarget = { modelId: candidate.modelId, providerId: candidate.providerId }
      step = 'confirm'
      continue
    }

    const confirmed = await prompts.confirm(createAcpSummary(input, provider, defaultAliasTarget))
    if (confirmed.status === 'cancelled' || (confirmed.status === 'submitted' && confirmed.value === 'no')) {
      return { status: 'cancelled' }
    }
    if (confirmed.status === 'back') {
      step = 'defaultAction'
      continue
    }

    return {
      ...(defaultAliasTarget === undefined
        ? {}
        : { defaultAliasTarget }),
      provider,
      status: 'confirmed',
    }
  }
}

function splitInput(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

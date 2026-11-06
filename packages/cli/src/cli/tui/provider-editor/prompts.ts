import type * as ClackPrompts from '@clack/prompts'

import type { ProviderEditorPromptPort, ProviderEditorPromptResult } from './types'

import { errorMessageFrom } from '@moeru/std/error'

import { parseHeaderList, probeModels } from '../../provider-registry'

// clack 1.8 resolves a cancelled prompt to its own `CANCEL_SYMBOL`, and `isCancel` narrows only that
// symbol, so a wider `symbol` parameter would survive the guard.
type Cancelled = typeof ClackPrompts.CANCEL_SYMBOL

interface SelectOption<T extends string> {
  hint?: string
  label: string
  value: T
}

const backValue = '__alint_back__'

/**
 * Adapts Clack prompt results into the provider editor's reversible actions.
 *
 * Triggering workflow:
 *
 * {@link runProviderEditor}
 *   -> {@link createProviderEditorPrompts}
 *     -> `provider-editor.prompt`
 *       -> {@link ProviderEditorPromptPort}
 *
 * Upstream:
 * - {@link runProviderEditor}
 *
 * Downstream:
 * - Clack terminal prompts and {@link probeModels}
 *
 * Cancellation and Back use tagged results, so submitted text cannot collide
 * with control values. Probe failures render in the spinner and return no models.
 */
export function createProviderEditorPrompts(prompts: typeof ClackPrompts): ProviderEditorPromptPort {
  return {
    async confirm(summary) {
      const result = await prompts.select<'no' | 'yes' | typeof backValue>({
        message: summary,
        options: withBackOption([
          { label: 'Yes', value: 'yes' },
          { label: 'No', value: 'no' },
        ]),
      })

      return selectionResult(prompts, result)
    },
    async defaultAction(firstModelId) {
      const result = await prompts.select<'no' | 'selectAnother' | 'yes' | typeof backValue>({
        message: `Add alias "default" to ${firstModelId}?`,
        options: withBackOption([
          { label: 'Yes', value: 'yes' },
          { label: 'No', value: 'no' },
          { label: 'Select another', value: 'selectAnother' },
        ]),
      })

      return selectionResult(prompts, result)
    },
    async defaultModel(options) {
      const result = await prompts.select<string | typeof backValue>({
        message: 'Select default model',
        options: withBackOption(options),
      })

      return selectionResult(prompts, result)
    },
    async endpoint(initialValue) {
      const result = await prompts.text({
        initialValue,
        message: 'Provider endpoint (type .. to go back)',
        placeholder: initialValue ?? 'https://example.test/v1',
        validate: value => isBackInput(value ?? '') || (value ?? '').trim().length > 0
          ? undefined
          : 'Provider endpoint is required.',
      })

      return textResult(prompts, result)
    },
    async headerInput() {
      const result = await prompts.text({
        message: 'Headers (leave empty to skip; type .. to go back)',
        placeholder: 'Authorization=Bearer sk-or-v1-xxxxxx, X-Test=true',
        validate: (value) => {
          if (isBackInput(value ?? '')) {
            return undefined
          }

          try {
            parseHeaderList(splitInput(value ?? ''))
            return undefined
          }
          catch {
            return 'Headers must be comma-separated Key=Value entries.'
          }
        },
      })

      return textResult(prompts, result)
    },
    async manualModels() {
      const result = await prompts.text({
        message: 'Models',
        placeholder: 'qwen:8b, qwen:32b; type .. to go back',
        validate: value => isBackInput(value ?? '') || splitInput(value ?? '').length > 0
          ? undefined
          : 'At least one model is required.',
      })

      const value = textResult(prompts, result)
      return value.status === 'submitted'
        ? submitted(splitInput(value.value))
        : value
    },
    async models(options, initialValues) {
      const result = await prompts.multiselect<string>({
        initialValues,
        message: 'Select models',
        options: withBackOption(options),
        required: true,
      })

      if (prompts.isCancel(result)) {
        return { status: 'cancelled' }
      }

      return result.includes(backValue)
        ? { status: 'back' }
        : submitted(result)
    },
    async probe(endpoint, headers) {
      const spinner = prompts.spinner()
      spinner.start('Probing models')

      try {
        const models = await probeModels(endpoint, headers)
        spinner.stop(models.length > 0
          ? `Found ${models.length} models`
          : 'No models discovered')
        return models
      }
      catch (error) {
        spinner.stop(formatProbeModelsFailure(endpoint, error))
        return []
      }
    },
    async providerId(initialValue, editable) {
      if (!editable) {
        return submitted(initialValue)
      }

      const result = await prompts.text({
        initialValue,
        message: 'Provider id (type .. to go back)',
        validate: value => isBackInput(value ?? '') || (value ?? '').trim().length > 0
          ? undefined
          : 'Provider id is required.',
      })

      return textResult(prompts, result)
    },
    async retainedHeaders(headerNames, initialValues) {
      if (headerNames.length === 0) {
        return submitted([])
      }

      const result = await prompts.multiselect<string>({
        initialValues,
        message: 'Select existing headers to keep',
        options: withBackOption(headerNames.map(name => ({ label: name, value: name }))),
        required: false,
      })

      if (prompts.isCancel(result)) {
        return { status: 'cancelled' }
      }

      return result.includes(backValue)
        ? { status: 'back' }
        : submitted(result)
    },
  }
}

export function formatProbeModelsFailure(endpoint: string, error: unknown): string {
  const hint = endpoint.startsWith('https://localhost:11434')
    ? ' Ollama usually uses http://localhost:11434/v1.'
    : ''

  return `Could not probe models: ${errorMessageFrom(error)}.${hint}`
}

export function isBackInput(value: string): boolean {
  return value.trim() === '..'
}

export function withBackOption<T extends string>(options: SelectOption<T>[]): Array<SelectOption<T | typeof backValue>> {
  return [
    ...options,
    { label: 'Back', value: backValue },
  ]
}

function selectionResult<T extends string>(
  prompts: typeof ClackPrompts,
  result: Cancelled | T,
): ProviderEditorPromptResult<Exclude<T, typeof backValue>> {
  if (prompts.isCancel(result)) {
    return { status: 'cancelled' }
  }

  return result === backValue
    ? { status: 'back' }
    : submitted(result as Exclude<T, typeof backValue>)
}

function splitInput(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function submitted<T>(value: T): ProviderEditorPromptResult<T> {
  return { status: 'submitted', value }
}

function textResult(
  prompts: typeof ClackPrompts,
  result: Cancelled | string,
): ProviderEditorPromptResult<string> {
  if (prompts.isCancel(result)) {
    return { status: 'cancelled' }
  }

  return isBackInput(result)
    ? { status: 'back' }
    : submitted(result)
}

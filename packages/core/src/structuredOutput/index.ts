import type { JsonSchema } from '@valibot/to-json-schema'
import type { GenerateTextResult } from '@xsai/generate-text'
import type { Message } from '@xsai/shared-chat'
import type { GenericSchema, InferOutput } from 'valibot'

import type { RuleContext } from '../dsl/types'
import type { ResolvedModel } from '../models/types'

import { errorMessageFrom } from '@moeru/std/error'
import { sleepWithAbort } from '@moeru/std/sleep'
import { toJsonSchema } from '@valibot/to-json-schema'
import { generateText } from '@xsai/generate-text'
import { rawTool } from '@xsai/tool'
import { getDescription, parse } from 'valibot'

const defaultMaxAttempts = 3
const defaultToolName = 'reportFindings'

export interface GenerateStructuredOptions<Schema extends GenericSchema> {
  /**
   * Builds the chat messages for each attempt. On retries, `retryFeedback`
   * carries a ready-to-send validation-failure message; insert it wherever it
   * fits the conversation, usually right before the final user message.
   */
  createMessages: (retryFeedback?: string) => Message[]
  logger?: RuleContext['logger']
  /** Maximum number of attempts when validation fails. Defaults to 3. */
  maxAttempts?: number
  metering?: RuleContext['metering']
  model: ResolvedModel
  /** Label recorded in metering metadata and debug logs, e.g. `go-responsibility-boundary-judge`. */
  operation: string
  /** Milliseconds to wait before the given (1-based) attempt is retried. */
  retryDelay?: (attempt: number) => number
  schema: Schema
  /** Cancels the model call and any pending retry backoff. Pass `ctx.signal` from a rule. */
  signal?: AbortSignal
  temperature?: number
  /** Shown to the model as the tool description. Defaults to the schema's valibot description. */
  toolDescription?: string
  toolName?: string
}

interface NormalizedUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export class InvalidStructuredOutputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidStructuredOutputError'
  }
}

/** Standard instruction line for localized judge findings; undefined when no language is configured. */
export function formatOutputLanguageInstruction(outputLanguage: string | undefined): string | undefined {
  return outputLanguage
    ? `Write all human-readable finding messages and suggestions in this language: ${outputLanguage}.`
    : undefined
}

/** Prefixes each line with its 1-based number so schemas can ask for "left-column line numbers". */
export function formatSourceWithLineNumbers(source: string): string {
  return source
    .split('\n')
    .map((line, index) => `${index + 1} | ${line}`)
    .join('\n')
}

/**
 * Forces the model to call a single reporting tool and returns the validated
 * tool arguments, so a tool call doubles as structured output. Unlike
 * `response_format`-based structured output (xsai's `generateObject`), a
 * forced tool call works on any provider with function calling, and invalid
 * payloads are retried with validation feedback instead of failing outright.
 */
export async function generateStructured<Schema extends GenericSchema>(
  options: GenerateStructuredOptions<Schema>,
): Promise<InferOutput<Schema>> {
  const maxAttempts = options.maxAttempts ?? defaultMaxAttempts
  const retryDelay = options.retryDelay ?? exponentialRetryDelay
  const toolName = options.toolName ?? defaultToolName

  const tool = rawTool({
    description: options.toolDescription ?? getDescription(options.schema),
    // The tool only echoes its input back: the arguments the model sends ARE
    // the structured output; nothing is executed besides capturing them.
    execute: input => asRecord(input) ?? {},
    name: toolName,
    parameters: toolParametersFromSchema(options.schema),
    strict: true,
  })

  let previousError: string | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    options.signal?.throwIfAborted()

    let response: GenerateTextResult

    try {
      options.signal?.throwIfAborted()
      response = await generateText({
        ...options.model.params,
        abortSignal: options.signal,
        baseURL: options.model.provider.endpoint,
        headers: options.model.provider.headers,
        messages: options.createMessages(previousError
          ? retryFeedbackFrom(toolName, previousError)
          : undefined),
        model: options.model.id,
        parallelToolCalls: false,
        temperature: options.temperature ?? 0,
        toolChoice: {
          function: {
            name: toolName,
          },
          type: 'function',
        },
        tools: [tool],
      })
    }
    catch (error) {
      // A cancelled call is not a model failure, so surface the abort instead of logging it as
      // one and retrying it.
      options.signal?.throwIfAborted()
      const callError = `Tool call failed before validation: ${errorMessageFrom(error) ?? String(error)}`

      previousError = isRetriableHttpError(error)
        ? undefined
        : callError
      options.logger?.debug(`${options.operation} attempt ${attempt} failed while calling the model: ${callError}`)

      if (!isRetriableCallError(error) || attempt === maxAttempts) {
        throw error
      }

      await sleepWithAbort(retryDelay(attempt), options.signal)
      continue
    }

    recordAttemptUsage(options, response)

    const result = parseStructuredResponse(options.schema, toolName, response)

    if (result.ok) {
      return result.value
    }

    previousError = result.error
    options.logger?.debug(`${options.operation} attempt ${attempt} returned an invalid structured result: ${previousError}`)

    if (!result.retriable || attempt === maxAttempts) {
      throw new InvalidStructuredOutputError(`Invalid structured model response: ${previousError}`)
    }

    await sleepWithAbort(retryDelay(attempt), options.signal)
  }

  throw new InvalidStructuredOutputError('Model did not return a valid structured result')
}

export function normalizeToolJsonSchema(schema: JsonSchema): JsonSchema {
  const normalized = normalizeJsonSchemaDefinition(schema)

  return typeof normalized === 'boolean'
    ? {}
    : normalized
}

/** Converts a valibot schema into provider-compliant strict tool parameters. */
export function toolParametersFromSchema(schema: GenericSchema): JsonSchema {
  return normalizeToolJsonSchema(toJsonSchema(schema))
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function exponentialRetryDelay(attempt: number): number {
  return 500 * 2 ** (attempt - 1)
}

function isRetriableCallError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return true
  }

  if (isRetriableHttpError(error)) {
    return true
  }

  // Malformed tool calls are the model's fault and worth retrying with
  // feedback; anything else (transport, auth, provider errors) is not.
  return error.name === 'InvalidToolCallError'
    || error.name === 'InvalidToolInputError'
    || error.name === 'ToolExecutionError'
}

function isRetriableHttpError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const statusCode = 'statusCode' in error && typeof error.statusCode === 'number'
    ? error.statusCode
    : undefined

  return statusCode !== undefined && (statusCode >= 500 || [408, 429].includes(statusCode))
}

function normalizeJsonSchemaDefinition(schema: boolean | JsonSchema): boolean | JsonSchema {
  if (typeof schema === 'boolean') {
    return schema
  }

  const normalized: JsonSchema = { ...schema }

  delete normalized.$schema

  if (normalized.type === 'object') {
    normalized.additionalProperties = false
  }

  if (normalized.properties) {
    normalized.properties = Object.fromEntries(
      Object.entries(normalized.properties).map(([key, propertySchema]) => [
        key,
        normalizeJsonSchemaDefinition(propertySchema),
      ]),
    )

    // OpenAI strict function calling rejects object schemas unless every
    // property is listed in `required`, so optional valibot fields are forced
    // to be present; validation still runs on the valibot schema.
    normalized.required = Object.keys(normalized.properties)
  }

  if (normalized.items) {
    normalized.items = Array.isArray(normalized.items)
      ? normalized.items.map(item => normalizeJsonSchemaDefinition(item))
      : normalizeJsonSchemaDefinition(normalized.items)
  }

  if (normalized.$defs) {
    normalized.$defs = normalizeJsonSchemaMap(normalized.$defs)
  }

  if (normalized.definitions) {
    normalized.definitions = normalizeJsonSchemaMap(normalized.definitions)
  }

  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (normalized[key]) {
      normalized[key] = normalized[key].map(item => normalizeJsonSchemaDefinition(item))
    }
  }

  if (normalized.not) {
    normalized.not = normalizeJsonSchemaDefinition(normalized.not)
  }

  return normalized
}

function normalizeJsonSchemaMap(map: Record<string, boolean | JsonSchema>): Record<string, boolean | JsonSchema> {
  return Object.fromEntries(
    Object.entries(map).map(([key, schema]) => [
      key,
      normalizeJsonSchemaDefinition(schema),
    ]),
  )
}

function normalizeUsage(usage: unknown): NormalizedUsage | undefined {
  const record = asRecord(usage)

  if (!record) {
    return undefined
  }

  const normalized = {
    inputTokens: numberFromRecord(record, 'inputTokens') ?? numberFromRecord(record, 'input_tokens') ?? numberFromRecord(record, 'prompt_tokens'),
    outputTokens: numberFromRecord(record, 'outputTokens') ?? numberFromRecord(record, 'output_tokens') ?? numberFromRecord(record, 'completion_tokens'),
    totalTokens: numberFromRecord(record, 'totalTokens') ?? numberFromRecord(record, 'total_tokens'),
  }

  return Object.values(normalized).some(value => value !== undefined)
    ? normalized
    : undefined
}

function numberFromRecord(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined
}

function parseStructuredResponse<Schema extends GenericSchema>(
  schema: Schema,
  toolName: string,
  response: GenerateTextResult,
):
  | { error: string, ok: false, retriable: boolean }
  | { ok: true, value: InferOutput<Schema> } {
  if (response.finishReason === 'content_filter') {
    return {
      error: `${toolName} was not returned because the model finished with content_filter`,
      ok: false,
      retriable: false,
    }
  }

  if (response.finishReason === 'length') {
    return {
      error: `${toolName} was not returned completely because the model finished with length`,
      ok: false,
      retriable: true,
    }
  }

  const toolResults = response.toolResults.filter(result => result.toolName === toolName)
  const toolCalls = response.toolCalls.filter(call => call.toolName === toolName)
  const matches = toolResults.length + toolCalls.length

  if (matches === 0) {
    return {
      error: `Missing ${toolName} tool result; finishReason=${response.finishReason}`,
      ok: false,
      retriable: true,
    }
  }

  if (matches > 1) {
    return {
      error: `Expected one ${toolName} tool result, received ${matches}`,
      ok: false,
      retriable: true,
    }
  }

  // xsAI executes tool calls only when a stopWhen condition permits another step; the
  // pending call then carries the same arguments and is consumed directly. See:
  // https://github.com/moeru-ai/xsai/issues/321
  let value: unknown

  try {
    value = toolResults[0] !== undefined
      ? toolResults[0].result
      : JSON.parse(toolCalls[0].args)
  }
  catch (error) {
    return {
      error: `Tool call failed before validation: ${errorMessageFrom(error) ?? String(error)}`,
      ok: false,
      retriable: true,
    }
  }

  try {
    return {
      ok: true,
      value: parse(schema, value),
    }
  }
  catch (error) {
    return {
      error: errorMessageFrom(error) ?? String(error),
      ok: false,
      retriable: true,
    }
  }
}

function recordAttemptUsage<Schema extends GenericSchema>(
  options: GenerateStructuredOptions<Schema>,
  response: GenerateTextResult,
): void {
  const usage = normalizeUsage(response.usage)

  if (!options.metering || !usage) {
    return
  }

  options.metering.recordUsage({
    inputTokens: usage.inputTokens,
    metadata: {
      operation: options.operation,
    },
    modelId: options.model.id,
    outputTokens: usage.outputTokens,
    providerId: options.model.provider.id,
    totalTokens: usage.totalTokens,
  })
}

function retryFeedbackFrom(toolName: string, error: string): string {
  return [
    'Your previous tool call could not be validated.',
    `Validation error: ${error}`,
    `Call ${toolName} again with arguments that exactly match the tool schema.`,
  ].join('\n')
}

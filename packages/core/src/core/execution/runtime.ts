import type { AgentAdapter } from '../../agent/types'
import type { SetupConfig } from '../../config/types'
import type { RuleContext } from '../../dsl/types'
import type { ModelRequirement, ResolvedModel } from '../../models/types'
import type { PreparedRule } from '../preparation'
import type { SourceRuntime } from '../source/types'
import type { Diagnostic, ProgressReporter, RunOptions } from '../types'
import type { RunProgress } from './progress'
import type { RuleRuntime, RuleRuntimeState } from './types'

import { AsyncLocalStorage } from 'node:async_hooks'

import { combineAbortSignals } from '../../agent'
import { withAgentRetry } from '../../agent/retry'
import { resolveModel, UnknownModelError } from '../../models/resolve'
import { stableHash } from '../hash'
import { snapshotDiagnostic, snapshotProgressJobRef, snapshotUsage } from './records'

export function createRuleRuntimes(options: {
  cwd: string
  effectiveAgent: AgentAdapter | undefined
  effectiveSettings: Record<string, unknown>
  progress?: ProgressReporter
  rules: readonly PreparedRule[]
  runOptions: RunOptions
  runProgress: RunProgress
  setupConfig: SetupConfig
  src: SourceRuntime
}): RuleRuntime[] {
  return options.rules.map(({ enabledRule, ruleIndex }) => {
    const executionState = new AsyncLocalStorage<RuleRuntimeState>()
    const agent = options.effectiveAgent
      ? withAgentRetry(request => options.effectiveAgent!({
          ...request,
          signal: combineAbortSignals(executionState.getStore()?.signal, request.signal),
        }), options.runOptions.runner?.agentRetries, {
          onRetry: ({ attempt, maxAttempts }) => {
            const state = executionState.getStore()
            if (!state || state.sealed)
              return
            const startedAt = Date.now()
            try {
              options.progress?.onJobRetry?.({
                attempt,
                job: snapshotProgressJobRef(state.jobRef),
                maxAttempts,
                progress: state.runProgress.snapshot(),
                startedAt,
              })
            }
            catch (cause) {
              if (!state.reporterFailed) {
                state.reporterCause = cause
                state.reporterFailed = true
              }
              throw cause
            }
          },
        })
      : undefined
    const context: RuleContext<readonly unknown[]> = {
      agent,
      cwd: options.cwd,
      id: enabledRule.id,
      localId: enabledRule.localId,
      logger: {
        debug: () => {},
      },
      metering: {
        recordUsage: (record) => {
          const state = executionState.getStore()
          // TODO: (planning-observations) Create-time diagnostics and usage are rejected because they have no rule-job order; revisit only with an owner-approved planning evidence contract.
          if (!state)
            throw new Error('Cannot record usage outside an active rule job.')
          if (state.sealed)
            return

          const usageRecord = snapshotUsage({
            ...record,
            ruleId: record.ruleId ?? enabledRule.id,
          })

          state.bucket.usage.push(usageRecord)
          try {
            options.progress?.onUsage?.({
              job: snapshotProgressJobRef(state.jobRef),
              progress: state.runProgress.snapshot(),
              record: snapshotUsage(usageRecord),
            })
          }
          catch (cause) {
            if (!state.reporterFailed) {
              state.reporterCause = cause
              state.reporterFailed = true
            }
            throw cause
          }
        },
      },
      model: async (selector) => {
        const explicitRequest = options.runOptions.modelOverride
          ?? (typeof selector === 'string'
            ? selector
            : undefined)
        const fallbackRequest = explicitRequest === undefined
          && selector === undefined
          && enabledRule.rule.model === undefined
          ? options.runOptions.defaultModel
          : undefined
        const request = explicitRequest ?? fallbackRequest
        const requirement = mergeModelRequirement(
          enabledRule.rule.model,
          typeof selector === 'string'
            ? undefined
            : selector,
        )
        let resolvedModel: ResolvedModel

        try {
          resolvedModel = resolveModel(options.setupConfig, {
            request,
            requirement,
            ruleId: enabledRule.id,
          })
        }
        catch (error) {
          if (fallbackRequest !== undefined && error instanceof UnknownModelError) {
            throw new Error(
              `Default model "${fallbackRequest}" is not configured. Configure a system default model or select a model for this project.`,
              { cause: error },
            )
          }

          throw error
        }

        const state = executionState.getStore()

        if (state && !state.sealed) {
          state.currentModel = toDiagnosticModel(resolvedModel, request)
        }

        return resolvedModel
      },
      options: enabledRule.options,
      outputLanguage: options.runOptions.outputLanguage,
      report: (descriptor) => {
        const state = executionState.getStore()
        // TODO: (planning-observations) Create-time diagnostics and usage are rejected because they have no rule-job order; revisit only with an owner-approved planning evidence contract.
        if (!state)
          throw new Error('Cannot report a diagnostic outside an active rule job.')
        if (state.sealed)
          return

        const filePath = descriptor.filePath ?? state.activeFilePath

        if (!filePath) {
          throw new Error(`Diagnostic for rule "${enabledRule.id}" is missing filePath.`)
        }

        const diagnosticModel = state.currentModel
          ? { ...state.currentModel }
          : undefined

        state.currentModel = undefined

        const diagnostic = snapshotDiagnostic({
          evidence: descriptor.evidence,
          filePath,
          loc: descriptor.loc,
          message: descriptor.message,
          model: diagnosticModel,
          ruleId: enabledRule.id,
          severity: enabledRule.severity,
        } satisfies Diagnostic)

        state.bucket.diagnostics.push(diagnostic)
        try {
          options.progress?.onDiagnostic?.({
            diagnostic: snapshotDiagnostic(diagnostic),
            job: snapshotProgressJobRef(state.jobRef),
            progress: state.runProgress.snapshot(),
          })
        }
        catch (cause) {
          if (!state.reporterFailed) {
            state.reporterCause = cause
            state.reporterFailed = true
          }
          throw cause
        }
      },
      settings: options.effectiveSettings,
      get signal() {
        return executionState.getStore()?.signal
      },
      src: options.src,
    }

    return {
      cacheable: enabledRule.rule.cache !== false,
      enabledRule,
      executionState,
      handlers: enabledRule.rule.create(context),
      ruleHash: stableHash({
        cache: enabledRule.rule.cache ?? true,
        cacheKey: enabledRule.rule.cacheKey,
        create: String(enabledRule.rule.create),
        id: enabledRule.id,
        localId: enabledRule.localId,
        model: enabledRule.rule.model,
        options: enabledRule.options,
        severity: enabledRule.severity,
      }),
      ruleIndex,
    }
  })
}

function mergeCapabilities(
  base: string[] | undefined,
  extra: string[] | undefined,
): string[] | undefined {
  if (!base && !extra)
    return undefined

  return [
    ...new Set([
      ...(base ?? []),
      ...(extra ?? []),
    ]),
  ]
}

function mergeMinContextWindow(
  base: number | undefined,
  extra: number | undefined,
): number | undefined {
  if (base === undefined)
    return extra
  if (extra === undefined)
    return base
  return Math.max(base, extra)
}

function mergeModelRequirement(
  base: ModelRequirement | undefined,
  extra: ModelRequirement | undefined,
): ModelRequirement | undefined {
  if (!base && !extra)
    return undefined

  const capabilities = mergeCapabilities(base?.capabilities, extra?.capabilities)
  const params = {
    ...(base?.params ?? {}),
    ...(extra?.params ?? {}),
  }

  return {
    capabilities,
    minContextWindow: mergeMinContextWindow(base?.minContextWindow, extra?.minContextWindow),
    params: Object.keys(params).length > 0
      ? params
      : undefined,
    size: extra?.size ?? base?.size,
  }
}

function toDiagnosticModel(
  model: ResolvedModel,
  request: string | undefined,
): NonNullable<Diagnostic['model']> {
  return {
    providerId: model.provider.id,
    requested: request,
    resolvedId: model.id,
  }
}

import type { CacheStore } from '../cache'
import type { RuleScheduler } from '../execution/scheduler'
import type { ExecutionTarget, RuleJob, RuleJobOutcome, RuleRuntime, RuleTargetExecution } from '../execution/types'
import type { PreparedInput } from '../preparation'
import type { ProjectFileSnapshot } from '../project'
import type { AlintFileFailure, ProgressReporter } from '../types'
import type { PlannedSourceTarget, SourceMetadataValue, SourceRuntime, SourceTarget, SourceTargetMetadata } from './types'

import { setImmediate as yieldToEventLoop } from 'node:timers/promises'

import { errorMessageFrom } from '@moeru/std/error'

import { createTargetIdentityResolver, normalizeCachePath } from '../cache'
import { stableHash } from '../hash'
import { isTargetLanguageAccepted, resolveRuleLanguages } from '../languages/rule-languages'

export interface PlanSourceOptions {
  cacheStore: CacheStore
  cwd: string
  progress?: ProgressReporter
  projectSnapshots?: boolean
  ruleRuntimes: RuleRuntime[]
  scheduler: RuleScheduler
  signal?: AbortSignal
  src: SourceRuntime
}

export interface PlanSourcesOptions extends Omit<PlanSourceOptions, 'ruleRuntimes'> {
  createRuleRuntimes: (input: PreparedInput) => RuleRuntime[]
}

export interface SourcePlanResult {
  failure?: AlintFileFailure
  outcomes: Promise<RuleJobOutcome[]>
  project?: ProjectFileSnapshot
}

interface SourceExecutionTarget {
  executions: RuleTargetExecution[]
  target: ExecutionTarget
  targetIndex: number
}

/**
 * Converts one rich extractor result into detached descriptors and admits its compact jobs.
 *
 * The returned outcome promise captures only cache ownership and hashes. This function does not
 * await rule execution, so its `SourceFile`, parser output, and rich targets become unreachable
 * when planning returns.
 */
export async function planSource(
  input: PreparedInput,
  options: PlanSourceOptions,
): Promise<SourcePlanResult> {
  return planSourceWithAdmission(input, options)
}

/**
 * Starts every input read independently, then batches CPU-heavy extraction and job admission.
 */
export async function planSources(
  inputs: readonly PreparedInput[],
  options: PlanSourcesOptions,
): Promise<SourcePlanResult[]> {
  const waitForPlanning = createPlanningAdmission()

  return Promise.all(inputs.map(input => planSourceWithAdmission(input, {
    ...options,
    ruleRuntimes: options.createRuleRuntimes(input),
  }, waitForPlanning)))
}

function createExecutionTargets(
  input: PreparedInput,
  targets: SourceTarget[],
  file: PlannedSourceTarget['file'],
  runtimes: RuleRuntime[],
  cwd: string,
  cacheOwner: ReturnType<CacheStore['beginOwner']>,
): SourceExecutionTarget[] {
  const resolveIdentity = createTargetIdentityResolver(targets.map(target => ({
    filePath: target.kind === 'file' ? normalizeCachePath(cwd, input.path) : undefined,
    identity: target.identity,
    kind: target.kind,
    name: target.name,
    range: target.range,
  })))

  return targets.flatMap((target, targetIndex) => {
    const executions = runtimes
      .map(runtime => sourceExecution(runtime, target.kind, target.language))
      .filter((execution): execution is RuleTargetExecution => execution !== undefined)
    if (executions.length === 0)
      return []
    const identity = resolveIdentity({
      filePath: target.kind === 'file' ? normalizeCachePath(cwd, input.path) : undefined,
      identity: target.identity,
      kind: target.kind,
      name: target.name,
      range: target.range,
    }, targetIndex)
    const plannedTarget: PlannedSourceTarget = {
      file,
      identity: target.identity,
      kind: target.kind,
      language: target.language,
      loc: target.loc && { end: { ...target.loc.end }, start: { ...target.loc.start } },
      metadata: snapshotMetadata(target.metadata),
      name: target.name,
      origin: target.origin && { ...target.origin, range: target.origin.range && { ...target.origin.range } },
      range: target.range && { ...target.range },
    }
    return {
      executions,
      target: {
        activeFilePath: input.path,
        cacheOwner,
        cacheTargetHash: targetSemanticHash(target),
        configHash: input.configHash,
        descriptor: plannedTarget,
        identity,
        kind: target.kind,
        loc: target.loc,
        name: target.name,
        range: target.range,
      },
      targetIndex,
    }
  })
}

function createPlanningAdmission(): () => Promise<void> {
  // NOTICE: This batch keeps source reads concurrent while bounding how long job generation can
  // monopolize the event loop before timers and process signals get a turn.
  const batchSize = 32
  let admitted = 0
  let pendingYield: Promise<void> | undefined

  return async () => {
    let currentPendingYield = pendingYield
    while (currentPendingYield) {
      await currentPendingYield
      currentPendingYield = pendingYield
    }

    admitted += 1
    if (admitted < batchSize)
      return

    admitted = 0
    const currentYield = yieldToEventLoop()
    pendingYield = currentYield

    try {
      await currentYield
    }
    finally {
      if (pendingYield === currentYield)
        pendingYield = undefined
    }
  }
}

function createProjectSnapshot(
  input: PreparedInput,
  language: string,
  path: string,
  contentHash: string,
  targets: SourceTarget[],
): ProjectFileSnapshot {
  return {
    configHash: input.configHash,
    file: { contentHash, language, path, targetCount: targets.length },
    fileIndex: input.fileIndex,
    targets: targets.map(target => ({
      descriptor: {
        filePath: target.file.path,
        identity: target.identity,
        kind: target.kind,
        ...(target.name === undefined ? {} : { name: target.name }),
        ...(target.range === undefined ? {} : { range: { ...target.range } }),
      },
      semanticHash: targetSemanticHash(target),
    })),
  }
}

function createSourceJobs(input: PreparedInput, targets: SourceExecutionTarget[]): RuleJob[] {
  return targets.flatMap(({ executions, target, targetIndex }) => executions.map((execution) => {
    const ruleId = execution.runtime.enabledRule.id
    return {
      execution,
      jobRef: {
        id: stableHash({ fileIndex: input.fileIndex, input: input.path, ruleId, targetIdentity: target.identity, targetIndex }),
        index: 0,
        inputPath: input.path,
        ruleId,
        target: { identity: target.identity, kind: target.kind, name: target.name },
      },
      orderKey: { inputIndex: input.fileIndex, ruleIndex: execution.runtime.ruleIndex, scope: 'source' as const, targetIndex },
      target,
    }
  }))
}

function failureMessage(error: unknown, fallback: string): string {
  try {
    return errorMessageFrom(error) ?? fallback
  }
  catch {
    return fallback
  }
}

function fileFailure(input: PreparedInput, kind: AlintFileFailure['kind'], message: string): AlintFileFailure {
  return { file: { index: input.fileIndex, path: input.path }, kind, message }
}

async function planSourceWithAdmission(
  input: PreparedInput,
  options: PlanSourceOptions,
  waitForPlanning?: () => Promise<void>,
): Promise<SourcePlanResult> {
  if (options.signal?.aborted)
    return { outcomes: Promise.resolve([]) }

  let file
  try {
    file = await options.src.readFile(input.path)
  }
  catch (error) {
    reportFilePlanningComplete(input, 0, options)
    return { failure: fileFailure(input, 'read', failureMessage(error, 'Failed to read source file.')), outcomes: Promise.resolve([]) }
  }

  if (options.signal?.aborted)
    return { outcomes: Promise.resolve([]) }

  await waitForPlanning?.()

  if (options.signal?.aborted)
    return { outcomes: Promise.resolve([]) }

  let targets: SourceTarget[]
  try {
    targets = await input.language.extract(file, {
      cwd: options.cwd,
      languageOptions: input.languageOptions,
      src: options.src,
    })
  }
  catch (error) {
    reportFilePlanningComplete(input, 0, options)
    return { failure: fileFailure(input, 'extract', failureMessage(error, 'Failed to extract source targets.')), outcomes: Promise.resolve([]) }
  }

  const { contentHash } = file
  let cacheOwner
  let jobs: RuleJob[]
  let project: ProjectFileSnapshot | undefined
  try {
    project = options.projectSnapshots === false
      ? undefined
      : createProjectSnapshot(input, file.language, file.path, contentHash, targets)
    cacheOwner = options.cacheStore.beginOwner(
      { kind: 'file', path: file.path },
      { contentHash },
    )
    const baseFile = { contentHash, language: file.language, path: file.path }
    const executionTargets = createExecutionTargets(input, targets, baseFile, options.ruleRuntimes, options.cwd, cacheOwner)
    jobs = createSourceJobs(input, executionTargets)
  }
  catch (error) {
    reportFilePlanningComplete(input, 0, options)
    return { failure: fileFailure(input, 'extract', failureMessage(error, 'Failed to plan source targets.')), outcomes: Promise.resolve([]) }
  }

  if (options.signal?.aborted) {
    cacheOwner.commit({ mode: 'merge' })
    return { outcomes: Promise.resolve([]), project }
  }

  const batch = options.scheduler.schedule(jobs)
  reportFilePlanningComplete(input, batch.jobsAdded, options)
  const outcomes = batch.outcomes.then(async (settled) => {
    cacheOwner.commit(options.signal?.aborted ? { mode: 'merge' } : undefined)
    await options.cacheStore.flush()
    return settled
  })

  return { outcomes, project }
}

function reportFilePlanningComplete(input: PreparedInput, jobsAdded: number, options: PlanSourceOptions): void {
  try {
    const progress = options.scheduler.completeFilePlanning()
    options.progress?.onFileReady?.({
      fileIndex: input.fileIndex,
      inputPath: input.path,
      jobsAdded,
      progress,
    })
  }
  catch (error) {
    options.scheduler.cancelWithError(error)
    throw error
  }
}

function snapshotMetadata(metadata: SourceTargetMetadata | undefined): SourceTargetMetadata | undefined {
  if (metadata === undefined)
    return undefined
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, snapshotMetadataValue(value, new WeakSet())]))
}

function snapshotMetadataValue(value: SourceMetadataValue, ancestors: WeakSet<object>): SourceMetadataValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value
  if (typeof value === 'number' && Number.isFinite(value))
    return value
  if (typeof value !== 'object')
    throw new TypeError('Source target metadata must contain only finite JSON data.')
  if (ancestors.has(value))
    throw new TypeError('Source target metadata must not contain cycles.')
  ancestors.add(value)
  try {
    if (Array.isArray(value))
      return value.map(item => snapshotMetadataValue(item, ancestors))
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError('Source target metadata must contain only plain objects and arrays.')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotMetadataValue(item, ancestors)]))
  }
  finally {
    ancestors.delete(value)
  }
}

function sourceExecution(runtime: RuleRuntime, kind: PlannedSourceTarget['kind'], language: string): RuleTargetExecution | undefined {
  const languages = resolveRuleLanguages(runtime.enabledRule.rule.languages)
  if (languages.kind === 'off' && kind === 'file' && (runtime.handlers.onTargetClass ?? runtime.handlers.onTargetFunction)) {
    return {
      handler: 'language-declaration-error',
      runtime,
    }
  }
  if (!isTargetLanguageAccepted(languages, kind, language))
    return undefined

  if (runtime.handlers.onTargetWith)
    return { handler: 'with', runtime }
  if (kind === 'class' && runtime.handlers.onTargetClass)
    return { handler: 'class', runtime }
  if (kind === 'file' && runtime.handlers.onTargetFile)
    return { handler: 'file', runtime }
  if (kind === 'function' && runtime.handlers.onTargetFunction)
    return { handler: 'function', runtime }
  return undefined
}

/** Keeps per-rule cache fingerprints and compact project snapshots on one semantic target identity. */
function targetSemanticHash(target: SourceTarget): string {
  return stableHash({
    language: target.language,
    loc: target.loc,
    metadata: target.metadata,
    name: target.name,
    origin: target.origin,
    range: target.range,
    text: target.text,
  })
}

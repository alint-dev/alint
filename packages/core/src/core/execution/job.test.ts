import type { EnabledRule } from '../../dsl/types'
import type { CacheEntry, CacheOwnerTransaction } from '../cache'
import type { FileTarget } from '../source/types'
import type { ProgressJobRef } from '../types'
import type { JobOrderKey, RuleJob, RuleRuntime, RuleRuntimeState } from './types'

import { AsyncLocalStorage } from 'node:async_hooks'

import { expect, it, vi } from 'vitest'

import { defineRule } from '../../dsl/define'
import { hashText } from '../hash'
import { createSourceRuntime, SourceChangedError } from '../source/runtime'
import { compareJobOrder, executeRuleJob } from './job'
import { createRunProgress } from './progress'
import { createRuleRuntimes } from './runtime'

it('detaches a completed outcome from the active rule job', async () => {
  const executionState = new AsyncLocalStorage<RuleRuntimeState>()
  const jobRef: ProgressJobRef = {
    id: 'job-1',
    index: 1,
    inputPath: '/repo/source.ts',
    ruleId: 'company/review',
    target: { identity: 'source.ts', kind: 'file' },
  }
  const orderKey = {
    inputIndex: 0,
    ruleIndex: 0,
    scope: 'source' as const,
    targetIndex: 0,
  }
  const rule = defineRule({
    create: () => ({}),
  })
  const cacheOwner: CacheOwnerTransaction = {
    checkpoint: async () => {},
    commit: () => {},
    discard: () => {},
    lookup: () => undefined,
    put: () => {},
  }
  const job: RuleJob = {
    execution: {
      handler: 'file',
      runtime: {
        cacheable: false,
        enabledRule: {
          id: 'company/review',
          localId: 'review',
          options: [],
          rule,
          severity: 'warn' as const,
        },
        executionState,
        handlers: {
          onTargetFile: () => {
            const state = executionState.getStore()
            if (!state)
              throw new Error('Expected an active rule runtime state.')
            state.bucket.diagnostics.push({
              filePath: '/repo/source.ts',
              message: 'diagnostic',
              ruleId: 'company/review',
              severity: 'warn',
            })
            state.bucket.usage.push({
              inputTokens: 1,
              modelId: 'model',
              providerId: 'provider',
              ruleId: 'company/review',
            })
          },
        },
        ruleHash: 'rule-hash',
        ruleIndex: 0,
      },
    },
    jobRef,
    orderKey,
    target: {
      cacheOwner,
      cacheTargetHash: 'target-hash',
      configHash: 'config-hash',
      descriptor: {
        file: {
          contentHash: 'content-hash',
          language: 'typescript',
          path: '/repo/source.ts',
        },
        identity: 'source.ts',
        kind: 'file',
        language: 'typescript',
      },
      identity: 'source.ts',
      kind: 'file' as const,
    },
  }

  const outcome = await executeRuleJob(job, {
    cache: { modelHash: 'model-hash' },
    runProgress: startedProgress(),
  })

  expect(outcome).toEqual({
    cache: 'miss',
    diagnostics: [
      {
        filePath: '/repo/source.ts',
        message: 'diagnostic',
        ruleId: 'company/review',
        severity: 'warn',
      },
    ],
    jobRef,
    orderKey,
    state: 'completed',
    usage: [
      {
        inputTokens: 1,
        modelId: 'model',
        providerId: 'provider',
        ruleId: 'company/review',
      },
    ],
  })
  expect(JSON.stringify(outcome)).not.toContain('retained source sentinel')
})

it.each([
  [
    'throwing message getter',
    () => Object.defineProperty({}, 'message', {
      get: () => { throw new Error('hostile getter') },
    }),
  ],
  [
    'hostile proxy',
    () => new Proxy({}, {
      get: () => { throw new Error('hostile proxy') },
    }),
  ],
])('turns a %s into a detached handler failure', async (_name, createCause) => {
  const executionState = new AsyncLocalStorage<RuleRuntimeState>()
  const rule = defineRule({
    create: () => ({}),
  })
  const job = createTestJob({
    executionState,
    rule,
    run: () => {
      throw createCause()
    },
  })

  await expect(executeRuleJob(job, {
    cache: { modelHash: 'model-hash' },
    runProgress: startedProgress(),
  })).resolves.toMatchObject({
    cache: 'miss',
    failure: {
      kind: 'handler',
      message: 'Unknown rule failure.',
    },
    state: 'failed',
  })
})

it.each([
  [
    'Error',
    new Error('ordinary failure'),
    'ordinary failure',
  ],
  ['string', 'string failure', 'string failure'],
])('preserves an ordinary %s failure message', async (_name, cause, message) => {
  const executionState = new AsyncLocalStorage<RuleRuntimeState>()
  const rule = defineRule({
    create: () => ({}),
  })
  const outcome = await executeRuleJob(createTestJob({
    executionState,
    rule,
    run: () => {
      throw cause
    },
  }), {
    cache: { modelHash: 'model-hash' },
    runProgress: startedProgress(),
  })

  expect(outcome).toMatchObject({
    failure: { message },
    state: 'failed',
  })
})

it('skips the handler and its execution-time source read on a cache hit', async () => {
  const executionState = new AsyncLocalStorage<RuleRuntimeState>()
  const rule = defineRule({
    cache: true,
    create: () => ({}),
  })
  const run = vi.fn()
  const job = createTestJob({ executionState, rule, run })
  job.execution.runtime.cacheable = true
  job.target.cacheOwner = {
    checkpoint: async () => {},
    commit: () => {},
    discard: () => {},
    lookup: () => ({
      diagnostics: [],
      fingerprint: {
        configHash: 'config-hash',
        modelHash: 'model-hash',
        ruleHash: 'rule-hash',
        targetHash: 'target-hash',
      },
      target: { hash: 'target-hash', identity: 'source.ts', kind: 'file' },
      usage: [],
    }),
    put: () => {},
  }

  const outcome = await executeRuleJob(job, {
    cache: { modelHash: 'model-hash' },
    runProgress: startedProgress(),
  })

  expect(outcome.state).toBe('cached')
  expect(run).not.toHaveBeenCalled()
})

it('rejects a completed job when its cache transaction write fails', async () => {
  const executionState = new AsyncLocalStorage<RuleRuntimeState>()
  const sentinel = new Error('cache transaction write failed')
  const rule = defineRule({
    cache: true,
    create: () => ({}),
  })
  const job = createTestJob({
    cacheOwner: {
      checkpoint: async () => {},
      commit: () => {},
      discard: () => {},
      lookup: () => undefined,
      put: () => {
        throw sentinel
      },
    },
    executionState,
    rule,
    run: () => {},
  })
  job.execution.runtime.cacheable = true

  await expect(executeRuleJob(job, {
    cache: { modelHash: 'model-hash' },
    runProgress: startedProgress(),
  })).rejects.toBe(sentinel)
})

it('checkpoints a completed cacheable job without deriving owner metadata', async () => {
  const executionState = new AsyncLocalStorage<RuleRuntimeState>()
  const checkpoint = vi.fn(async () => {})
  const rule = defineRule({
    cache: true,
    create: () => ({}),
  })
  const job = createTestJob({
    cacheOwner: {
      checkpoint,
      commit: () => {},
      discard: () => {},
      lookup: () => undefined,
      put: () => {},
    },
    executionState,
    rule,
    run: () => {},
  })
  job.execution.runtime.cacheable = true

  await executeRuleJob(job, {
    cache: { modelHash: 'model-hash' },
    runProgress: startedProgress(),
  })

  expect(checkpoint).toHaveBeenCalledTimes(1)
  expect(checkpoint).toHaveBeenCalledWith()
})

it('reports descriptor mismatches as source-changed failures with both hashes', async () => {
  const executionState = new AsyncLocalStorage<RuleRuntimeState>()
  const rule = defineRule({
    create: () => ({}),
  })
  const plannedHash = hashText('planned')
  const actualHash = hashText('changed')
  const job = createTestJob({
    executionState,
    rule,
    run: async () => {
      throw new SourceChangedError('/repo/source.ts', plannedHash, actualHash)
    },
  })

  const outcome = await executeRuleJob(job, {
    cache: { modelHash: 'model-hash' },
    runProgress: startedProgress(),
  })

  expect(outcome).toMatchObject({
    failure: {
      kind: 'source-changed',
      message: expect.stringContaining(plannedHash),
    },
    state: 'failed',
  })
  expect(outcome.state === 'failed' && outcome.failure.message).toContain(actualHash)
})

it('detaches a failed outcome from the active rule job', async () => {
  const executionState = new AsyncLocalStorage<RuleRuntimeState>()
  const rule = defineRule({
    create: () => ({}),
  })
  const job = createTestJob({
    executionState,
    rule,
    run: () => {
      throw new Error('original failure')
    },
  })
  const outcome = await executeRuleJob(job, {
    cache: { modelHash: 'model-hash' },
    runProgress: startedProgress(),
  })
  job.jobRef.id = 'mutated job id'
  job.jobRef.target.identity = 'mutated target'

  expect(outcome).toMatchObject({
    failure: {
      job: {
        id: 'job-1',
        target: { identity: 'source.ts', kind: 'file' },
      },
      message: 'original failure',
    },
    jobRef: {
      id: 'job-1',
      target: { identity: 'source.ts', kind: 'file' },
    },
    state: 'failed',
  })
  expect(outcome.state === 'failed' && outcome.failure.job).not.toBe(outcome.jobRef)
  expect(JSON.stringify(outcome)).not.toContain('mutated')
})

it('seals terminal records and isolates progress, cache, and outcome snapshots', async () => {
  const evidence = { source: 'public evidence payload' }
  const metadata = { source: 'public usage payload' }
  let releaseLate!: () => void
  const lateGate = new Promise<void>((resolve) => {
    releaseLate = resolve
  })
  let lateFinished!: Promise<void>
  const rule = defineRule({
    create: ctx => ({
      onTargetFile: () => {
        ctx.report({
          evidence,
          loc: {
            start: { column: 2, line: 1 },
          },
          message: 'original diagnostic',
        })
        ctx.metering.recordUsage({
          inputTokens: 3,
          metadata,
          modelId: 'model',
          providerId: 'provider',
        })
        lateFinished = lateGate.then(() => {
          ctx.report({ message: 'late diagnostic' })
          ctx.metering.recordUsage({ inputTokens: 100, modelId: 'late', providerId: 'late' })
        })
      },
    }),
  })
  const diagnosticsProgress: string[] = []
  const usageProgress: number[] = []
  const runProgress = startedProgress()
  const [runtime] = createRuleRuntimes({
    cwd: '/repo',
    effectiveAgent: undefined,
    effectiveSettings: {},
    progress: {
      onDiagnostic: ({ diagnostic }) => {
        diagnosticsProgress.push(diagnostic.message)
        diagnostic.message = 'mutated by reporter'
        if (diagnostic.loc)
          diagnostic.loc.start.line = 99
      },
      onUsage: ({ record }) => {
        usageProgress.push(record.inputTokens ?? 0)
        record.inputTokens = 99
      },
    },
    rules: [
      {
        enabledRule: {
          id: 'company/review',
          localId: 'review',
          options: [],
          rule,
          severity: 'warn',
        },
        ruleIndex: 0,
      },
    ],
    runOptions: {},
    runProgress,
    setupConfig: { providers: [], version: 1 },
    src: createSourceRuntime({
      readFile: () => {
        throw new Error('unused')
      },
    }),
  })
  if (!runtime)
    throw new Error('Expected a rule runtime.')
  const sourceTarget: FileTarget = {
    file: {
      contentHash: 'content-hash',
      language: 'typescript',
      path: '/repo/source.ts',
    },
    identity: 'source.ts',
    kind: 'file',
    language: 'typescript',
  }
  let cachedEntry: CacheEntry | undefined
  const cacheOwner: CacheOwnerTransaction = {
    checkpoint: async () => {},
    commit: () => {},
    discard: () => {},
    lookup: () => undefined,
    put: (_slot, entry) => {
      cachedEntry = entry
    },
  }
  const job = createTestJob({
    cacheOwner,
    executionState: runtime.executionState,
    rule,
    run: () => runtime.handlers.onTargetFile?.(sourceTarget),
    runtime,
  })
  job.target.loc = {
    end: { column: 8, line: 2 },
    start: { column: 2, line: 1 },
  }
  job.target.range = { end: 8, start: 2 }
  Object.assign(job.target.loc, { backlink: 'retained target sentinel' })
  Object.assign(job.target.range, { backlink: 'retained target sentinel' })

  const outcome = await executeRuleJob(job, {
    cache: { modelHash: 'model-hash' },
    runProgress,
  })

  job.target.loc.start.line = 42
  job.target.range.start = 42
  Object.assign(job.target.loc, { after: 'retained target sentinel' })
  Object.assign(job.target.range, { after: 'retained target sentinel' })

  releaseLate()
  await lateFinished

  expect(diagnosticsProgress).toEqual(['original diagnostic'])
  expect(usageProgress).toEqual([3])
  expect(outcome.diagnostics).toEqual([
    {
      evidence,
      filePath: '/repo/source.ts',
      loc: {
        start: { column: 2, line: 1 },
      },
      message: 'original diagnostic',
      model: undefined,
      ruleId: 'company/review',
      severity: 'warn',
    },
  ])
  expect(outcome.usage).toEqual([
    {
      inputTokens: 3,
      metadata,
      modelId: 'model',
      providerId: 'provider',
      ruleId: 'company/review',
    },
  ])
  expect(cachedEntry?.diagnostics).toEqual(outcome.diagnostics)
  expect(cachedEntry?.usage).toEqual(outcome.usage)
  expect(cachedEntry?.diagnostics).not.toBe(outcome.diagnostics)
  expect(cachedEntry?.diagnostics[0]).not.toBe(outcome.diagnostics[0])
  expect(cachedEntry?.diagnostics[0]?.loc).not.toBe(outcome.diagnostics[0]?.loc)
  expect(cachedEntry?.diagnostics[0]?.loc?.start).not.toBe(outcome.diagnostics[0]?.loc?.start)
  expect(cachedEntry?.usage).not.toBe(outcome.usage)
  expect(cachedEntry?.usage[0]).not.toBe(outcome.usage[0])
  expect(outcome.diagnostics[0]?.evidence).toBe(evidence)
  expect(outcome.usage[0]?.metadata).toBe(metadata)

  outcome.diagnostics[0]!.message = 'mutated outcome'
  outcome.diagnostics[0]!.loc!.start.line = 42
  outcome.usage[0]!.inputTokens = 42
  expect(cachedEntry?.diagnostics[0]?.message).toBe('original diagnostic')
  expect(cachedEntry?.diagnostics[0]?.loc?.start.line).toBe(1)
  expect(cachedEntry?.usage[0]?.inputTokens).toBe(3)
  expect(cachedEntry?.target).toEqual({
    hash: expect.any(String),
    identity: 'source.ts',
    kind: 'file',
    loc: {
      end: { column: 8, line: 2 },
      start: { column: 2, line: 1 },
    },
    name: undefined,
    range: { end: 8, start: 2 },
  })
  expect(JSON.stringify(cachedEntry?.target)).not.toContain('retained target sentinel')
})

it('compares job order by scope, input, target, then prepared rule index', () => {
  const keys: JobOrderKey[] = [
    {
      inputIndex: 0,
      ruleIndex: 0,
      scope: 'project',
      targetIndex: 0,
    },
    {
      inputIndex: 0,
      ruleIndex: 2,
      scope: 'source',
      targetIndex: 0,
    },
    {
      inputIndex: 0,
      ruleIndex: 1,
      scope: 'directory',
      targetIndex: 0,
    },
    {
      inputIndex: 1,
      ruleIndex: 0,
      scope: 'source',
      targetIndex: 0,
    },
    {
      inputIndex: 0,
      ruleIndex: 0,
      scope: 'source',
      targetIndex: 1,
    },
    {
      inputIndex: 0,
      ruleIndex: 1,
      scope: 'source',
      targetIndex: 0,
    },
  ]

  expect(keys.toSorted(compareJobOrder)).toEqual([
    {
      inputIndex: 0,
      ruleIndex: 1,
      scope: 'source',
      targetIndex: 0,
    },
    {
      inputIndex: 0,
      ruleIndex: 2,
      scope: 'source',
      targetIndex: 0,
    },
    {
      inputIndex: 0,
      ruleIndex: 0,
      scope: 'source',
      targetIndex: 1,
    },
    {
      inputIndex: 1,
      ruleIndex: 0,
      scope: 'source',
      targetIndex: 0,
    },
    {
      inputIndex: 0,
      ruleIndex: 1,
      scope: 'directory',
      targetIndex: 0,
    },
    {
      inputIndex: 0,
      ruleIndex: 0,
      scope: 'project',
      targetIndex: 0,
    },
  ])
})

function createTestJob(options: {
  cacheOwner?: CacheOwnerTransaction
  executionState: AsyncLocalStorage<RuleRuntimeState>
  rule: EnabledRule['rule']
  run: () => Promise<void> | void
  runtime?: RuleRuntime
}): RuleJob {
  const baseRuntime: RuleRuntime = options.runtime ?? {
    cacheable: false,
    enabledRule: {
      id: 'company/review',
      localId: 'review',
      options: [],
      rule: options.rule,
      severity: 'warn',
    },
    executionState: options.executionState,
    handlers: {},
    ruleHash: 'rule-hash',
    ruleIndex: 0,
  }
  const runtime: RuleRuntime = {
    ...baseRuntime,
    handlers: { onTargetFile: options.run },
  }
  return {
    execution: { handler: 'file', runtime },
    jobRef: {
      id: 'job-1',
      index: 1,
      inputPath: '/repo/source.ts',
      ruleId: 'company/review',
      target: { identity: 'source.ts', kind: 'file' },
    },
    orderKey: {
      inputIndex: 0,
      ruleIndex: 0,
      scope: 'source',
      targetIndex: 0,
    },
    target: {
      activeFilePath: '/repo/source.ts',
      cacheOwner: options.cacheOwner,
      cacheTargetHash: 'target-hash',
      configHash: 'config-hash',
      descriptor: {
        file: {
          contentHash: 'content-hash',
          language: 'typescript',
          path: '/repo/source.ts',
        },
        identity: 'source.ts',
        kind: 'file',
        language: 'typescript',
      },
      identity: 'source.ts',
      kind: 'file',
    },
  }
}

function startedProgress() {
  const progress = createRunProgress(1)
  progress.queue()
  progress.start()
  return progress
}

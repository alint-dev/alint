import type { CacheOwnerTransaction, CacheStore } from '../cache'
import type { RuleRuntime } from '../execution/types'
import type { PreparedInput } from '../preparation'
import type { SourceTargetMetadata } from './types'

import { AsyncLocalStorage } from 'node:async_hooks'

import { describe, expect, it, vi } from 'vitest'

import { defineRule } from '../../dsl/define'
import { compareJobOrder } from '../execution/job'
import { createRunProgress } from '../execution/progress'
import { RuleScheduler } from '../execution/scheduler'
import { hashText } from '../hash'
import { planSource, planSources } from './planner'
import { createSourceRuntime } from './runtime'

function metadataWithUnsupportedValue(key: string, value: unknown): SourceTargetMetadata {
  const metadata = {}
  Reflect.set(metadata, key, value)
  return metadata
}

describe('source planning', () => {
  it('detaches outcomes and project metadata before releasing source text', async () => {
    const sentinel = 'source planning sentinel'
    const commits: Array<undefined | { contentHash?: string, mode?: 'merge' | 'replace' }> = []
    const owner = createOwner(commits)
    const beginOwner = vi.fn(() => owner)
    const cacheStore: CacheStore = { beginOwner, flush: async () => {}, location: '', reconcile: async () => {} }
    const input = createInput(0, '/repo/demo.custom', async file => [
      { file, identity: 'same', kind: 'symbol', language: 'custom', text: `${file.text}:first` },
      { file, identity: 'same', kind: 'symbol', language: 'custom', text: `${file.text}:second` },
    ])
    const src = createSourceRuntime({ readFile: async input => ({ contentHash: hashText(sentinel), language: 'custom', lines: [sentinel], path: sourcePath(input), text: sentinel }) })
    const scheduler = createScheduler(2)

    const result = await planSource(input, {
      cacheStore,
      cwd: '/repo',
      ruleRuntimes: [createRuntime()],
      scheduler,
      src,
    })
    await scheduler.close()

    expect(result.failure).toBeUndefined()
    const outcomes = await result.outcomes
    expect(outcomes).toHaveLength(2)
    expect(result.project?.file.path).toBe('/repo/demo.custom')
    expect(result.project?.file.targetCount).toBe(2)
    expect(JSON.stringify(result.project)).not.toContain(sentinel)
    expect(JSON.stringify(outcomes)).not.toContain(sentinel)
    expect(beginOwner).toHaveBeenCalledWith(
      { kind: 'file', path: '/repo/demo.custom' },
      { contentHash: hashText(sentinel) },
    )
    expect(commits).toEqual([undefined])
  })

  it('returns an extract failure without opening cache ownership or scheduling jobs', async () => {
    const beginOwner = vi.fn(() => createOwner([]))
    const scheduler = createScheduler(2)
    const input = createInput(0, '/repo/demo.custom', () => {
      throw new Error('bad parser')
    })

    const result = await planSource(input, {
      cacheStore: { beginOwner, flush: async () => {}, location: '', reconcile: async () => {} },
      cwd: '/repo',
      ruleRuntimes: [createRuntime()],
      scheduler,
      src: createSourceRuntime({ readFile: async input => ({ contentHash: hashText('text'), language: 'custom', lines: ['text'], path: sourcePath(input), text: 'text' }) }),
    })
    await scheduler.close()

    expect(result.failure).toEqual({ file: { index: 0, path: '/repo/demo.custom' }, kind: 'extract', message: 'bad parser' })
    expect(result.project).toBeUndefined()
    expect(await result.outcomes).toEqual([])
    expect(beginOwner).not.toHaveBeenCalled()
    expect(scheduler.snapshot().execution.planned).toBe(0)
  })

  it('reports unsupported rule metadata as a file planning failure', async () => {
    const scheduler = createScheduler(2)
    const input = createInput(0, '/repo/demo.custom', file => [{
      file,
      identity: 'file',
      kind: 'file',
      language: 'custom',
      metadata: metadataWithUnsupportedValue('unsupported', 1n),
      text: file.text,
    }])

    const result = await planSource(input, {
      cacheStore: createCacheStore(createOwner([])),
      cwd: '/repo',
      projectSnapshots: false,
      ruleRuntimes: [createRuntime()],
      scheduler,
      src: createSourceRuntime({ readFile: async input => sourceFile(input) }),
    })
    await scheduler.close()

    expect(result.failure).toMatchObject({
      file: { index: 0, path: '/repo/demo.custom' },
      kind: 'extract',
      message: 'Source target metadata must contain only finite JSON data.',
    })
    expect(scheduler.snapshot()).toMatchObject({ filesPlanned: 1, jobsTotal: 0 })
  })

  it('plans later sources while scheduled rule jobs remain blocked', async () => {
    const releases: Array<() => void> = []
    const inputs = Array.from({ length: 20 }, (_, index) => createInput(index, `/repo/${index}.custom`, file => [
      { file, identity: String(index), kind: 'symbol', language: 'custom', text: file.text },
    ]))
    const scheduler = createScheduler(20, async (job) => {
      await new Promise<void>(resolve => releases.push(resolve))
      return completed(job)
    })

    const results = await planSources(inputs, {
      cacheStore: createCacheStore(createOwner([])),
      createRuleRuntimes: () => [createRuntime()],
      cwd: '/repo',
      scheduler,
      src: createSourceRuntime({ readFile: async input => sourceFile(input) }),
    })

    await until(() => releases.length === 20)

    for (const release of releases)
      release()
    const outcomes = (await Promise.all(results.map(result => result.outcomes))).flat().sort((left, right) => compareJobOrder(left.orderKey, right.orderKey))
    await scheduler.close()

    expect(outcomes.map(outcome => outcome.orderKey.inputIndex)).toEqual(Array.from({ length: 20 }, (_, index) => index))
  })

  it('does not extract sources whose concurrent reads finish after aborting', async () => {
    const controller = new AbortController()
    const reads: string[] = []
    const releases: Array<() => void> = []
    let extractions = 0
    const inputs = Array.from({ length: 4 }, (_, index) => createInput(index, `/repo/${index}.custom`, (file) => {
      extractions += 1
      return [{ file, identity: String(index), kind: 'symbol', language: 'custom', text: file.text }]
    }))
    const scheduler = createScheduler(1)
    const pending = planSources(inputs, {
      cacheStore: createCacheStore(createOwner([])),
      createRuleRuntimes: () => [createRuntime()],
      cwd: '/repo',
      scheduler,
      signal: controller.signal,
      src: createSourceRuntime({
        readFile: async (input) => {
          const path = sourcePath(input)
          reads.push(path)
          await new Promise<void>((resolve) => {
            releases.push(resolve)
          })
          return { contentHash: hashText(path), language: 'custom', lines: [path], path, text: path }
        },
      }),
    })

    await until(() => releases.length === inputs.length)
    controller.abort('stop')
    for (const release of releases)
      release()
    await pending
    await scheduler.close()

    expect(reads).toEqual(inputs.map(input => input.path))
    expect(extractions).toBe(0)
    expect(scheduler.snapshot().execution.planned).toBe(0)
  })

  it('yields during large planning bursts so timer-driven cancellation stops job admission', async () => {
    const controller = new AbortController()
    const inputs = Array.from({ length: 1_000 }, (_, index) => createInput(index, `/repo/${index}.custom`, file => [
      { file, identity: String(index), kind: 'symbol', language: 'custom', text: file.text },
    ]))
    const scheduler = new RuleScheduler({
      clock: () => 1,
      concurrency: 1,
      execute: async job => completed(job),
      progress: createRunProgress(inputs.length),
      signal: controller.signal,
    })
    const abortTimer = setTimeout(() => controller.abort('stop'), 0)

    await planSources(inputs, {
      cacheStore: createCacheStore(createOwner([])),
      createRuleRuntimes: () => [createRuntime()],
      cwd: '/repo',
      scheduler,
      signal: controller.signal,
      src: createSourceRuntime({ readFile: async input => sourceFile(input) }),
    })
    await new Promise<void>(resolve => setTimeout(resolve, 10))
    await scheduler.close()
    clearTimeout(abortTimer)

    expect(controller.signal.aborted).toBe(true)
    expect(scheduler.snapshot().execution.planned).toBeLessThan(inputs.length)
  })
})

function completed(job: Parameters<ConstructorParameters<typeof RuleScheduler>[0]['execute']>[0]) {
  return { cache: 'miss' as const, diagnostics: [], jobRef: job.jobRef, orderKey: job.orderKey, state: 'completed' as const, usage: [] }
}

function createCacheStore(owner: CacheOwnerTransaction): CacheStore {
  return { beginOwner: () => owner, flush: async () => {}, location: '', reconcile: async () => {} }
}

function createInput(fileIndex: number, path: string, extract: PreparedInput['language']['extract']): PreparedInput {
  return {
    configHash: 'config',
    fileIndex,
    language: { extract, name: 'custom' },
    languageOptions: {},
    path,
    rules: [],
    settings: {},
  }
}

function createOwner(commits: Array<undefined | { contentHash?: string, mode?: 'merge' | 'replace' }>): CacheOwnerTransaction {
  return { checkpoint: async () => {}, commit: metadata => commits.push(metadata), discard: () => {}, lookup: () => undefined, put: () => {} }
}

function createRuntime(): RuleRuntime {
  const rule = defineRule({ create: () => ({ onTargetWith: () => {} }), languages: 'any' })
  return {
    cacheable: true,
    enabledRule: { id: 'plugin/rule', localId: 'rule', options: [], rule, severity: 'warn' },
    executionState: new AsyncLocalStorage(),
    handlers: rule.create({} as never),
    ruleHash: 'rule',
    ruleIndex: 0,
  }
}

function createScheduler(concurrency: number, execute = async (job: Parameters<ConstructorParameters<typeof RuleScheduler>[0]['execute']>[0]) => completed(job)) {
  return new RuleScheduler({ clock: () => 1, concurrency, execute, progress: createRunProgress(20) })
}

function sourceFile(input: Parameters<ReturnType<typeof createSourceRuntime>['readFile']>[0]) {
  const path = sourcePath(input)
  return { contentHash: hashText(path), language: 'custom', lines: [path], path, text: path }
}

function sourcePath(input: Parameters<ReturnType<typeof createSourceRuntime>['readFile']>[0]): string {
  return typeof input === 'string' ? input : input.path
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate())
      return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('condition not reached')
}

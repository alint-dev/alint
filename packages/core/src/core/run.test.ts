import type { AgentAdapter } from '../agent/types'
import type { RunnerConfig, SetupConfig } from '../config/types'
import type { PluginDefinition, ProjectTarget, RuleConfigEntry, RuleContext, RuleDefinition } from '../dsl/types'
import type { ProgressJobRef, ProgressReporter } from '../index'
import type { SourceTargetMetadata } from './source/types'

import { getEventListeners } from 'node:events'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { number, object, optional } from 'valibot'
import { describe, expect, it, vi } from 'vitest'

import { requireAgent, RetryableAgentError } from '../agent'
import { defineConfig, definePlugin, defineRule } from '../dsl/define'
import { readCacheBody } from './cache'
import { hashText, stableHash } from './hash'
import { ProjectIndexBuilder } from './project'
import { AlintAbortError, AlintRunCancelledError, AlintRunError, runAlint } from './run'

function metadataWithUnsupportedValue(key: string, value: unknown): SourceTargetMetadata {
  const metadata = {}
  Reflect.set(metadata, key, value)
  return metadata
}

async function waitForCacheBody(
  path: string,
  ready: (body: Awaited<ReturnType<typeof readCacheBody>>) => boolean,
): Promise<Awaited<ReturnType<typeof readCacheBody>>> {
  return vi.waitUntil(async () => {
    try {
      const body = await readCacheBody(path)
      return ready(body) ? body : false
    }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return false
      throw error
    }
  }, { timeout: 5_000 })
}

describe('runAlint', () => {
  function createSetupConfig(): SetupConfig {
    return {
      providers: [
        {
          endpoint: 'http://localhost:11434/v1',
          id: 'ollama',
          models: [
            {
              aliases: ['default'],
              capabilities: ['structured-output'],
              id: 'local:qwen-8b',
              name: 'qwen:8b',
              size: 'small',
            },
            {
              aliases: ['override'],
              capabilities: ['structured-output'],
              id: 'local:qwen-32b',
              name: 'qwen:32b',
              size: 'large',
            },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    }
  }

  it('validates rule timeout before planning an empty run', async () => {
    await expect(runAlint({ runner: { timeoutMs: 0 } }))
      .rejects
      .toThrow(new TypeError('Rule execution timeout must be a finite positive integer.'))
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid rule concurrency %s before planning a zero-job run',
    async (ruleConcurrency) => {
      const events: string[] = []

      await expect(runAlint({
        progress: {
          onPrepareStart: () => events.push('start'),
          onRunEnd: () => events.push('end'),
        },
        runner: { ruleConcurrency },
        setupConfig: createSetupConfig(),
      })).rejects.toThrow(new TypeError('Rule execution concurrency must be a finite positive integer.'))

      expect(events).toEqual([])
    },
  )

  it('rejects an unknown language in a later input before extracting or reading an earlier input', async () => {
    const extract = vi.fn(() => [])
    const plugin = definePlugin({
      languages: {
        custom: {
          extensions: ['.custom'],
          extract,
          name: 'custom',
        },
      },
    })

    await expect(runAlint({
      config: defineConfig([
        { plugins: { company: plugin } },
        { files: ['later.custom'], language: 'unknown' },
      ]),
      cwd: '/repo',
      files: ['missing.custom', 'later.custom'],
    })).rejects.toThrow('Unknown language "unknown".')

    expect(extract).not.toHaveBeenCalled()
  })

  it('closes the scheduler when project rule creation fails', async () => {
    const controller = new AbortController()
    const sentinel = new Error('project rule creation failed')
    const rule = defineRule({
      create: () => {
        throw sentinel
      },
    })

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    await expect(runAlint({
      config: createConfig({ review: rule }, { 'company/review': 'warn' }),
      signal: controller.signal,
    })).rejects.toBe(sentinel)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('closes the scheduler when probing a project handler getter fails', async () => {
    const controller = new AbortController()
    const sentinel = new Error('project handler getter failed')
    const rule = defineRule({
      create: () => ({
        get onTargetProject(): (target: ProjectTarget) => void {
          throw sentinel
        },
      }),
    })

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    await expect(runAlint({
      config: createConfig({ review: rule }, { 'company/review': 'warn' }),
      signal: controller.signal,
    })).rejects.toBe(sentinel)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('keeps unrelated source and directory jobs running after ordered read and extract failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-file-failures-'))
    const missingPath = join(root, 'missing.txt')
    const badPath = join(root, 'bad.custom')
    const goodPath = join(root, 'good.custom')
    let sourceCalls = 0
    let directoryCalls = 0
    let projectCalls = 0
    await writeFile(badPath, 'bad')
    await writeFile(goodPath, 'good')
    const rule = defineRule({
      create: () => ({
        onTargetDirectory: () => { directoryCalls += 1 },
        onTargetFile: () => { sourceCalls += 1 },
        onTargetProject: () => { projectCalls += 1 },
      }),
    })
    const plugin = definePlugin({
      languages: {
        custom: {
          extensions: ['.custom'],
          extract: (file) => {
            if (file.text === 'bad')
              throw new Error('custom extraction failed')
            return [{ file, identity: 'file', kind: 'file', language: 'custom', text: file.text }]
          },
          name: 'custom',
        },
      },
      rules: { review: rule },
    })

    let runError: unknown
    try {
      await runAlint({
        config: defineConfig([
          { plugins: { company: plugin }, rules: { 'company/review': 'warn' } },
          { files: ['**/*.custom'], language: 'custom' },
        ]),
        cwd: root,
        directories: [root],
        files: [missingPath, badPath, goodPath],
        runner: { cache: false },
        setupConfig: createSetupConfig(),
      })
    }
    catch (error) {
      runError = error
    }

    expect(runError).toBeInstanceOf(AlintRunError)
    expect((runError as AlintRunError).message).toBe('2 alint executions failed.')
    expect((runError as AlintRunError).failures[0]).toMatchObject({ file: { index: 0, path: missingPath }, kind: 'read' })
    expect((runError as AlintRunError).failures[1]).toEqual({ file: { index: 1, path: badPath }, kind: 'extract', message: 'custom extraction failed' })
    expect(sourceCalls).toBe(1)
    expect(directoryCalls).toBe(1)
    expect(projectCalls).toBe(0)
  })

  function createConfig(
    rules: Record<string, RuleDefinition>,
    enabledRules: Record<string, RuleConfigEntry>,
    pluginExtras: Omit<PluginDefinition, 'rules'> = {},
    itemExtras: Record<string, unknown> = {},
  ) {
    return defineConfig([
      {
        ...itemExtras,
        plugins: {
          company: definePlugin({
            ...pluginExtras,
            rules,
          }),
        },
        rules: enabledRules,
      },
    ])
  }

  async function runSingleAgentRule(options: {
    adapter: AgentAdapter
    runner?: RunnerConfig
  }) {
    const root = await mkdtemp(join(tmpdir(), 'alint-agent-retry-'))
    const filePath = join(root, 'demo.txt')

    await writeFile(filePath, 'hello\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFile: async (target) => {
          const agent = requireAgent(ctx)
          const file = await ctx.src.readFile(target.file)
          const { answer } = await agent({
            instructions: 'review',
            model: await ctx.model('default'),
            prompt: file.text,
            tools: [],
          })

          ctx.report({ message: answer })
        },
      }),
    })

    return runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
        {},
        { agent: options.adapter, files: ['**/*.txt'], language: 'plaintext' },
      ),
      cwd: root,
      files: [filePath],
      runner: options.runner,
      setupConfig: createSetupConfig(),
    })
  }

  it('does not expose runner clock overrides', () => {
    const options: Parameters<typeof runAlint>[0] = {}

    // @ts-expect-error runner timing must use the real runtime clock.
    expect(options.runner?.clock).toBeUndefined()
    expect(options).toBeDefined()
  })

  it('queues every job before starting jobs and emits each job lifecycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-job-progress-'))
    const filePath = join(root, 'demo.txt')
    const events: string[] = []
    const jobs: ProgressJobRef[] = []

    await writeFile(filePath, 'hello\n')

    const firstRule = defineRule({
      create: () => ({
        onTargetFile: () => {},
      }),
    })
    const secondRule = defineRule({
      create: () => ({
        onTargetFile: () => {},
      }),
    })

    await runAlint({
      config: createConfig(
        { first: firstRule, second: secondRule },
        { 'company/first': 'warn', 'company/second': 'warn' },
        {},
        { language: 'plaintext' },
      ),
      cwd: root,
      files: [filePath],
      progress: {
        onJobEnd: ({ job, state }) => events.push(`end:${job.index}:${state}`),
        onJobQueued: ({ job }) => {
          jobs.push(job)
          events.push(`queued:${job.index}`)
        },
        onJobStart: ({ job }) => events.push(`start:${job.index}`),
      },
      setupConfig: createSetupConfig(),
    })

    expect(jobs).toEqual([
      {
        id: expect.any(String),
        index: 1,
        inputPath: filePath,
        ruleId: 'company/first',
        target: {
          identity: 'file:demo.txt',
          kind: 'file',
        },
      },
      {
        id: expect.any(String),
        index: 2,
        inputPath: filePath,
        ruleId: 'company/second',
        target: {
          identity: 'file:demo.txt',
          kind: 'file',
        },
      },
    ])
    expect(events.slice(0, 2)).toEqual(['queued:1', 'queued:2'])
    expect(events).toEqual([
      'queued:1',
      'queued:2',
      'start:1',
      'start:2',
      'end:1:completed',
      'end:2:completed',
    ])
  })

  it('reports ordered stages with detached snapshots and a monotonic admitted denominator', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-stage-progress-'))
    const filePath = join(root, 'demo.txt')
    const events: string[] = []
    const denominators: number[] = []
    await writeFile(filePath, 'hello\n')
    const first = defineRule({ create: () => ({ onTargetFile: () => {} }) })
    const second = defineRule({ create: () => ({ onTargetFile: () => {} }) })

    await runAlint({
      config: createConfig(
        { first, second },
        { 'company/first': 'warn', 'company/second': 'warn' },
        {},
        { language: 'plaintext' },
      ),
      cwd: root,
      files: [filePath],
      progress: {
        onExecuteEnd: ({ progress }) => {
          events.push(`execute:end:${progress.planningComplete}:${progress.jobsCompleted}/${progress.jobsTotal}`)
          denominators.push(progress.jobsTotal)
          progress.execution.planned = 999
        },
        onExecuteStart: ({ progress }) => {
          events.push(`execute:start:${progress.jobsTotal}`)
          denominators.push(progress.jobsTotal)
        },
        onFileReady: ({ inputPath, jobsAdded, progress }) => {
          events.push(`file:${inputPath}:${jobsAdded}:${progress.jobsTotal}`)
          denominators.push(progress.jobsTotal)
        },
        onJobEnd: ({ job, progress }) => {
          events.push(`end:${job.index}:${progress.jobsCompleted}`)
          denominators.push(progress.jobsTotal)
        },
        onJobQueued: ({ job, progress }) => {
          events.push(`queue:${job.index}:${progress.jobsTotal}`)
          denominators.push(progress.jobsTotal)
          progress.execution.planned = 999
        },
        onJobStart: ({ job, progress }) => {
          events.push(`start:${job.index}:${progress.jobsStarted}`)
          denominators.push(progress.jobsTotal)
        },
        onPrepareEnd: ({ filesTotal }) => events.push(`prepare:end:${filesTotal}`),
        onPrepareStart: () => events.push('prepare:start'),
        onRunEnd: ({ progress }) => events.push(`run:end:${progress.planningComplete}:${progress.jobsTotal}`),
      },
      setupConfig: createSetupConfig(),
    })

    expect(events).toEqual([
      'prepare:start',
      'prepare:end:1',
      'execute:start:0',
      'queue:1:1',
      'queue:2:2',
      `file:${filePath}:2:2`,
      'start:1:1',
      'start:2:2',
      'end:1:1',
      'end:2:2',
      'execute:end:true:2/2',
      'run:end:true:2',
    ])
    expect(denominators).toEqual([...denominators].sort((left, right) => left - right))
  })

  it('admits each file source jobs before reporting that file ready', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-file-admission-progress-'))
    const firstPath = join(root, 'first.custom')
    const secondPath = join(root, 'second.custom')
    await writeFile(firstPath, 'one\n')
    await writeFile(secondPath, 'one,two\n')
    const fileReady: Array<{ inputPath: string, jobsAdded: number, jobsTotal: number, queuedForFile: number }> = []
    const queuedByPath = new Map<string, number>()
    const rule = defineRule({
      create: () => ({ onTargetFunction: () => {} }),
      languages: 'any',
    })

    await runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
        {
          languages: {
            custom: {
              extensions: ['.custom'],
              extract: file => file.text.trim().split(',').map((name, index) => ({
                file,
                identity: `${name}:${index}`,
                kind: 'function' as const,
                language: 'custom/plain',
                name,
                text: name,
              })),
              name: 'custom/plain',
            },
          },
        },
        { language: 'custom/plain' },
      ),
      cwd: root,
      files: [firstPath, secondPath],
      progress: {
        onFileReady: ({ inputPath, jobsAdded, progress }) => fileReady.push({
          inputPath,
          jobsAdded,
          jobsTotal: progress.jobsTotal,
          queuedForFile: queuedByPath.get(inputPath) ?? 0,
        }),
        onJobQueued: ({ job }) => queuedByPath.set(job.inputPath, (queuedByPath.get(job.inputPath) ?? 0) + 1),
      },
      setupConfig: createSetupConfig(),
    })

    const readyByPath = new Map(fileReady.map(event => [event.inputPath, event]))
    expect(fileReady).toHaveLength(2)
    expect(readyByPath.get(firstPath)?.jobsAdded).toBe(1)
    expect(readyByPath.get(firstPath)?.queuedForFile).toBe(1)
    expect(readyByPath.get(secondPath)?.jobsAdded).toBe(2)
    expect(readyByPath.get(secondPath)?.queuedForFile).toBe(2)
    expect(fileReady[0]?.jobsTotal).toBe(fileReady[0]?.jobsAdded)
    expect(fileReady[1]?.jobsTotal).toBe(3)
    expect(fileReady.map(event => event.jobsTotal)).toEqual(fileReady.map(event => event.jobsTotal).toSorted((left, right) => left - right))
  })

  it('keeps file and job progress exact when a later file fails extraction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-later-extract-progress-'))
    const firstPath = join(root, 'first.custom')
    const secondPath = join(root, 'second.custom')
    const failingPath = join(root, 'failing.custom')
    await writeFile(firstPath, 'one')
    await writeFile(secondPath, 'one,two')
    await writeFile(failingPath, 'fail')
    const fileReady: Array<{ inputPath: string, jobsAdded: number, jobsTotal: number }> = []
    let filesTotal: number | undefined
    let executeEnd: undefined | { final: boolean, jobsTotal: number }
    let runEnd: undefined | { final: boolean, jobsTotal: number }
    let projectCalls = 0
    const rule = defineRule({
      create: () => ({
        onTargetFunction: () => {},
        onTargetProject: () => { projectCalls += 1 },
      }),
      languages: 'any',
    })
    const plugin = definePlugin({
      languages: {
        custom: {
          extensions: ['.custom'],
          extract: (file) => {
            if (file.text === 'fail')
              throw new Error('later extraction failed')
            return file.text.split(',').map((name, index) => ({
              file,
              identity: `${name}:${index}`,
              kind: 'function' as const,
              language: 'custom',
              name,
              text: name,
            }))
          },
          name: 'custom',
        },
      },
      rules: { review: rule },
    })

    let runError: unknown
    try {
      await runAlint({
        config: defineConfig([
          { plugins: { company: plugin }, rules: { 'company/review': 'warn' } },
          { files: ['**/*.custom'], language: 'custom' },
        ]),
        cwd: root,
        files: [firstPath, secondPath, failingPath],
        progress: {
          onExecuteEnd: ({ progress }) => {
            executeEnd = { final: progress.planningComplete, jobsTotal: progress.jobsTotal }
          },
          onFileReady: ({ inputPath, jobsAdded, progress }) => {
            fileReady.push({ inputPath, jobsAdded, jobsTotal: progress.jobsTotal })
          },
          onPrepareEnd: (payload) => { filesTotal = payload.filesTotal },
          onRunEnd: ({ progress }) => {
            runEnd = { final: progress.planningComplete, jobsTotal: progress.jobsTotal }
          },
        },
        runner: { cache: false, ruleConcurrency: 1 },
        setupConfig: createSetupConfig(),
      })
    }
    catch (error) {
      runError = error
    }

    expect(filesTotal).toBe(3)
    expect(fileReady).toHaveLength(3)
    const readyByPath = new Map(fileReady.map(event => [event.inputPath, event]))
    expect(readyByPath.get(firstPath)?.jobsAdded).toBe(1)
    expect(readyByPath.get(secondPath)?.jobsAdded).toBe(2)
    expect(readyByPath.get(failingPath)?.jobsAdded).toBe(0)
    expect(Math.max(...fileReady.map(event => event.jobsTotal))).toBe(3)
    expect(fileReady.map(event => event.jobsTotal)).toEqual(fileReady.map(event => event.jobsTotal).toSorted((left, right) => left - right))
    expect(executeEnd?.final).toBe(true)
    expect(executeEnd?.jobsTotal).toBe(3)
    expect(runEnd?.final).toBe(true)
    expect(runEnd?.jobsTotal).toBe(3)
    expect(projectCalls).toBe(0)
    expect(runError).toBeInstanceOf(AlintRunError)
    expect((runError as AlintRunError).failures[0]).toEqual({
      file: { index: 2, path: failingPath },
      kind: 'extract',
      message: 'later extraction failed',
    })
    expect((runError as AlintRunError).result.execution.planned).toBe(3)
  })

  it.each([1, 2])('cleans up only admitted jobs when queued reporter call %i fails', async (failureCall) => {
    const root = await mkdtemp(join(tmpdir(), 'alint-queue-reporter-failure-'))
    const filePath = join(root, 'demo.txt')
    const sentinel = new Error('queue reporter failed')
    const snapshots: Array<{ jobsCompleted: number, jobsStarted: number, jobsTotal: number }> = []
    let calls = 0
    let ended = false
    await writeFile(filePath, 'hello\n')
    const first = defineRule({ create: () => ({ onTargetFile: () => {} }) })
    const second = defineRule({ create: () => ({ onTargetFile: () => {} }) })

    await expect(runAlint({
      config: createConfig(
        { first, second },
        { 'company/first': 'warn', 'company/second': 'warn' },
        {},
        { language: 'plaintext' },
      ),
      cwd: root,
      files: [filePath],
      progress: {
        onExecuteEnd: () => { ended = true },
        onJobQueued: ({ progress }) => {
          calls += 1
          snapshots.push(progress)
          if (calls === failureCall)
            throw sentinel
        },
      },
      setupConfig: createSetupConfig(),
    })).rejects.toBe(sentinel)

    expect(snapshots).toHaveLength(failureCall)
    expect(snapshots.at(-1)).toMatchObject({ jobsCompleted: 0, jobsStarted: 0, jobsTotal: failureCall })
    expect(ended).toBe(false)
  })

  it('cancels admitted jobs without running handlers when file-ready reporting fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-file-ready-reporter-failure-'))
    const filePath = join(root, 'demo.txt')
    const sentinel = new Error('file-ready reporter failed')
    const terminalSentinel = new Error('terminal reporter failed during cancellation')
    const visited: string[] = []
    const ended: string[] = []
    await writeFile(filePath, 'hello\n')
    const first = defineRule({
      create: () => ({
        onTargetFile: () => {
          visited.push('first')
        },
      }),
    })
    const second = defineRule({
      create: () => ({
        onTargetFile: () => {
          visited.push('second')
        },
      }),
    })

    await expect(runAlint({
      config: createConfig(
        { first, second },
        { 'company/first': 'warn', 'company/second': 'warn' },
        {},
        { language: 'plaintext' },
      ),
      cwd: root,
      files: [filePath],
      progress: {
        onFileReady: () => { throw sentinel },
        onJobEnd: ({ state }) => {
          ended.push(state)
          throw terminalSentinel
        },
      },
      setupConfig: createSetupConfig(),
    })).rejects.toBe(sentinel)

    expect(visited).toEqual([])
    expect(ended).toEqual(['cancelled', 'cancelled'])
  })

  it('finalizes admitted jobs after a start reporter failure before rethrowing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-start-reporter-failure-'))
    const filePath = join(root, 'demo.txt')
    const sentinel = new Error('start reporter failed')
    let finalProgress: Parameters<NonNullable<ProgressReporter['onRunEnd']>>[0]['progress'] | undefined
    await writeFile(filePath, 'hello\n')
    const first = defineRule({ create: () => ({ onTargetFile: () => {} }) })
    const second = defineRule({ create: () => ({ onTargetFile: () => {} }) })

    await expect(runAlint({
      config: createConfig(
        { first, second },
        { 'company/first': 'warn', 'company/second': 'warn' },
        {},
        { language: 'plaintext' },
      ),
      cwd: root,
      files: [filePath],
      progress: {
        onJobStart: () => { throw sentinel },
        onRunEnd: ({ progress }) => { finalProgress = progress },
      },
      setupConfig: createSetupConfig(),
    })).rejects.toBe(sentinel)

    expect(finalProgress).toMatchObject({ jobsCompleted: 2, jobsStarted: 2, jobsTotal: 2, planningComplete: true })
    expect(finalProgress?.execution).toMatchObject({ cancelled: 2, planned: 2, queued: 0, running: 0 })
  })

  it('preserves completed outcomes when a later start reporter fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-partial-infrastructure-result-'))
    const filePath = join(root, 'demo.txt')
    const sentinel = new Error('second start reporter failed')
    const diagnostics: string[] = []
    let execution: Parameters<NonNullable<ProgressReporter['onRunEnd']>>[0]['execution'] | undefined
    let inputTokens: number | undefined
    await writeFile(filePath, 'hello\n')
    const first = defineRule({
      create: ctx => ({
        onTargetFile: () => {
          ctx.report({ message: 'first completed' })
          ctx.metering.recordUsage({ inputTokens: 3, modelId: 'model', providerId: 'provider' })
        },
      }),
    })
    const second = defineRule({ create: () => ({ onTargetFile: () => {} }) })

    await expect(runAlint({
      config: createConfig(
        { first, second },
        { 'company/first': 'warn', 'company/second': 'warn' },
        {},
        { language: 'plaintext' },
      ),
      cwd: root,
      files: [filePath],
      progress: {
        onJobStart: ({ job }) => {
          if (job.index === 2)
            throw sentinel
        },
        onRunEnd: (payload) => {
          diagnostics.push(...payload.diagnostics.map(diagnostic => diagnostic.message))
          execution = payload.execution
          inputTokens = payload.usage.inputTokens
        },
      },
      runner: { cache: false, ruleConcurrency: 1 },
      setupConfig: createSetupConfig(),
    })).rejects.toBe(sentinel)

    expect(diagnostics).toEqual(['first completed'])
    expect(execution).toMatchObject({ cancelled: 1, completed: 1, planned: 2, queued: 0, running: 0 })
    expect(inputTokens).toBe(3)
  })

  it('keeps queued job references limited to stable job and target identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-rule-progress-metadata-'))
    const firstPath = join(root, 'first.txt')
    const secondPath = join(root, 'second.txt')
    const jobs: ProgressJobRef[] = []

    await writeFile(firstPath, 'first\n')
    await writeFile(secondPath, 'second\n')

    const one = defineRule({ create: () => ({ onTargetFile: () => {} }) })
    const two = defineRule({ create: () => ({ onTargetFile: () => {} }) })

    await runAlint({
      config: createConfig(
        { one, two },
        { 'company/one': 'warn', 'company/two': 'warn' },
        {},
        { language: 'plaintext' },
      ),
      files: [firstPath, secondPath],
      progress: {
        onJobQueued: ({ job }) => jobs.push(job),
      },
      setupConfig: createSetupConfig(),
    })

    const jobsByPath = Map.groupBy(jobs, job => job.inputPath)
    expect(jobs.map(job => job.index)).toEqual([1, 2, 3, 4])
    expect(jobs.every(job => Object.keys(job).sort().join(',') === 'id,index,inputPath,ruleId,target')).toBe(true)
    expect(jobsByPath.get(firstPath)?.map(job => job.ruleId)).toEqual(['company/one', 'company/two'])
    expect(jobsByPath.get(secondPath)?.map(job => job.ruleId)).toEqual(['company/one', 'company/two'])
  })

  it('assigns unique job IDs to repeated inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-repeated-job-id-'))
    const filePath = join(root, 'demo.txt')
    const jobs: ProgressJobRef[] = []
    await writeFile(filePath, 'hello\n')
    const rule = defineRule({
      create: () => ({
        onTargetFile: () => {},
      }),
    })

    await runAlint({
      config: createConfig({ review: rule }, { 'company/review': 'warn' }, {}, { language: 'plaintext' }),
      cwd: root,
      files: [filePath, filePath],
      progress: { onJobQueued: ({ job }) => jobs.push(job) },
      runner: { cache: false },
      setupConfig: createSetupConfig(),
    })

    expect(jobs.map(job => job.index)).toEqual([1, 2])
    expect(new Set(jobs.map(job => job.id)).size).toBe(2)
  })

  it('exposes the run signal only through the active rule execution context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-rule-signal-'))
    const filePath = join(root, 'demo.txt')
    const controller = new AbortController()
    const observed: Array<AbortSignal | undefined> = []

    await writeFile(filePath, 'hello\n')

    const rule = defineRule({
      create: (ctx) => {
        observed.push(ctx.signal)

        return {
          onTargetFile: () => {
            observed.push(ctx.signal)
          },
        }
      },
    })

    await runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
        {},
        { language: 'plaintext' },
      ),
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
      signal: controller.signal,
    })

    expect(observed[0]).toBeUndefined()
    expect(observed[1]).toBeUndefined()
    expect(observed[2]).toBeInstanceOf(AbortSignal)
    expect(observed[2]).not.toBe(controller.signal)
    expect(observed[2]?.aborted).toBe(false)
  })

  it('passes parsed rule options to rule contexts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-rule-options-'))
    await writeFile(join(root, 'source.txt'), 'hello\n', 'utf8')
    const observedOptions: unknown[] = []
    const rule = defineRule({
      create: (context) => {
        observedOptions.push(...context.options)

        return {
          onTargetFile: () => {},
        }
      },
      options: [
        object({
          maxLines: optional(number(), 10),
        }),
      ],
    })

    await runAlint({
      config: defineConfig([
        {
          files: ['source.txt'],
          plugins: {
            company: definePlugin({
              rules: {
                review: rule,
              },
            }),
          },
          rules: {
            'company/review': ['warn', {}],
          },
        },
      ]),
      cwd: root,
      files: ['source.txt'],
    })

    expect(observedOptions).toEqual([{ maxLines: 10 }])
  })

  it('runs explicit onTargetWith rules for .go through plaintext', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-go-target-'))
    const filePath = join(root, 'main.go')
    const visited: string[] = []

    await writeFile(filePath, 'package main\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFile: async (target) => {
          const file = await ctx.src.readFile(target.file)
          visited.push(`${target.kind}:${target.language}:${file.text}`)
          ctx.report({
            message: `checked ${target.language}`,
          })
        },
      }),
    })

    const result = await runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
        {},
        { files: ['**/*.go'], language: 'plaintext' },
      ),
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(visited).toEqual([
      'file:plaintext:package main\n',
    ])
    expect(result.diagnostics).toMatchObject([
      {
        filePath,
        message: 'checked plaintext',
        ruleId: 'company/review',
        severity: 'warn',
      },
    ])
  })

  it('dispatches source targets only to their specialized handlers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-specialized-targets-'))
    const filePath = join(root, 'demo.ts')
    const visited: string[] = []

    await writeFile(filePath, [
      'export class Demo {}',
      'export function load() {}',
    ].join('\n'))

    const rule = defineRule({
      create: () => ({
        onTargetClass: (target) => {
          visited.push(`class:${target.name}`)
        },
        onTargetFile: (target) => {
          visited.push(`file:${target.file.path}`)
        },
        onTargetFunction: (target) => {
          visited.push(`function:${target.name}`)
        },
      }),
      languages: 'any',
    })

    const result = await runAlint({
      config: createConfig({ review: rule }, { 'company/review': 'warn' }),
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(visited).toEqual([
      `file:${filePath}`,
      'class:Demo',
      'function:load',
    ])
    expect(result.execution).toMatchObject({ completed: 3, planned: 3 })
  })

  it('dispatches onTargetWith across source, directory, and project targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-target-with-'))
    const filePath = join(root, 'demo.txt')
    const directoryPath = join(root, 'components')
    const visited: string[] = []

    await writeFile(filePath, 'demo\n')

    const rule = defineRule({
      cache: false,
      create: () => ({
        onTargetWith: (target) => {
          visited.push(target.kind)
        },
      }),
    })

    const result = await runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
        {},
        { language: 'plaintext' },
      ),
      cwd: root,
      directories: [directoryPath],
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(visited).toEqual(['file', 'directory', 'project'])
    expect(result.execution).toMatchObject({ completed: 3, planned: 3 })
  })

  it('keeps distinct source target identities for equal names at different ranges', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-source-target-identity-'))
    const filePath = join(root, 'demo.custom')
    const identities: string[] = []

    await writeFile(filePath, 'same\nsame\n')

    const rule = defineRule({
      create: () => ({
        onTargetFunction: (target) => {
          identities.push(target.identity)
        },
      }),
      languages: 'any',
    })

    await runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
        {
          languages: {
            custom: {
              extensions: ['.custom'],
              extract: file => [
                {
                  file,
                  identity: 'same',
                  kind: 'function',
                  language: 'custom/plain',
                  name: 'same',
                  range: { end: 4, start: 0 },
                  text: 'same',
                },
                {
                  file,
                  identity: 'same',
                  kind: 'function',
                  language: 'custom/plain',
                  name: 'same',
                  range: { end: 9, start: 5 },
                  text: 'same',
                },
              ],
              name: 'custom/plain',
            },
          },
        },
      ),
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    const cacheFile = await readCacheBody(join(root, '.alintcache'))
    const normalizedIdentities = Object.values(cacheFile.entries)
      .map(entry => entry.target.identity)
      .sort()

    expect(identities).toEqual(['same', 'same'])
    expect(normalizedIdentities).toEqual([
      'function:same:0:4',
      'function:same:5:9',
    ])
  })

  it('runs onTargetDirectory for matching explicit directories in input order without files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-directory-target-'))
    const componentA = join(root, 'crates', 'a')
    const example = join(root, 'examples', 'c')
    const componentB = join(root, 'crates', 'b')
    const visited: string[] = []

    const rule = defineRule({
      create: ctx => ({
        onTargetDirectory: (target) => {
          visited.push(target.path)
          ctx.report({
            filePath: target.path,
            message: 'checked directory',
          })
        },
      }),
    })

    const result = await runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
        {},
        { directories: ['crates/*'] },
      ),
      cwd: root,
      directories: [componentA, example, componentB],
      runner: {
        cache: true,
      },
      setupConfig: createSetupConfig(),
    })

    expect(visited).toEqual([
      componentA,
      componentB,
    ])
    expect(result.diagnostics).toMatchObject([
      {
        filePath: componentA,
        message: 'checked directory',
        ruleId: 'company/review',
        severity: 'warn',
      },
      {
        filePath: componentB,
        message: 'checked directory',
        ruleId: 'company/review',
        severity: 'warn',
      },
    ])
  })

  it('does not replay directory targets from cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-directory-cache-'))
    const directoryPath = join(root, 'crates', 'a')
    const cachePath = join(root, '.alintcache')
    const ruleEndEvents: string[] = []
    let handlerCalls = 0

    const rule = defineRule({
      create: () => ({
        onTargetDirectory: () => {
          handlerCalls += 1
        },
      }),
    })
    const config = createConfig(
      { review: rule },
      { 'company/review': 'warn' },
      {},
      { directories: ['crates/*'] },
    )

    for (let run = 0; run < 2; run += 1) {
      await runAlint({
        config,
        cwd: root,
        directories: [directoryPath],
        progress: {
          onJobEnd: payload => ruleEndEvents.push(`${payload.job.target.kind}:${payload.cache}`),
        },
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })
    }

    expect(handlerCalls).toBe(2)
    expect(ruleEndEvents).toEqual([
      'directory:miss',
      'directory:miss',
    ])
  })

  it('retains partial results and directory failure details when onTargetDirectory throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-directory-error-'))
    const directoryPath = join(root, 'crates', 'a')
    const runEndEvents: string[] = []
    const rule = defineRule({
      create: ctx => ({
        onTargetDirectory: (target) => {
          ctx.report({
            filePath: target.path,
            message: 'reported before directory failure',
          })
          throw new Error('directory exploded')
        },
      }),
    })

    let runError: unknown

    try {
      await runAlint({
        config: createConfig(
          { review: rule },
          { 'company/review': 'warn' },
          {},
          { directories: ['crates/*'] },
        ),
        cwd: root,
        directories: [directoryPath],
        progress: {
          onRunEnd: payload => runEndEvents.push(`${payload.diagnostics.length}:${payload.execution.failed}/${payload.execution.planned}`),
        },
        setupConfig: createSetupConfig(),
      })
    }
    catch (error) {
      runError = error
    }

    expect(runError).toBeInstanceOf(AlintRunError)
    expect(runError).toMatchObject({
      failures: [{
        job: {
          inputPath: directoryPath,
          ruleId: 'company/review',
          target: { kind: 'directory' },
        },
        kind: 'handler',
        message: 'directory exploded',
      }],
      result: {
        diagnostics: [{
          filePath: directoryPath,
          message: 'reported before directory failure',
        }],
      },
    })
    expect(runEndEvents).toEqual(['1:1/1'])
  })

  it('runs one project target at cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-target-'))
    const visited: string[] = []

    const rule = defineRule({
      create: () => ({
        onTargetProject: (target) => {
          visited.push(`${target.kind}:${target.root}`)
        },
      }),
    })

    await runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
      ),
      cwd: root,
      setupConfig: createSetupConfig(),
    })

    expect(visited).toEqual([
      `project:${root}`,
    ])

    const cacheFile = await readCacheBody(join(root, '.alintcache'))
    const entry = Object.values(cacheFile.entries)[0]
    const projectHash = new ProjectIndexBuilder(root).build().hash

    expect(Object.keys(cacheFile.entries)).toHaveLength(1)
    expect(entry?.fingerprint.targetHash).toBe(projectHash)
    expect(entry?.target.hash).toBe(projectHash)
    expect(entry?.target.kind).toBe('project')
  })

  it('clears stale project slots after a complete run removes every project handler', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-cache-remove-handlers-'))
    const cachePath = join(root, '.alintcache')
    const rule = defineRule({ create: () => ({ onTargetProject: () => {} }) })

    await runAlint({
      config: createConfig({ review: rule }, { 'company/review': 'warn' }),
      cwd: root,
      runner: { cache: { location: cachePath } },
      setupConfig: createSetupConfig(),
    })
    const warmed = await readCacheBody(cachePath)
    expect(Object.values(warmed.owners).find(owner => owner.kind === 'project')?.slots).toHaveLength(1)

    await runAlint({
      config: defineConfig([]),
      cwd: root,
      runner: { cache: { location: cachePath } },
      setupConfig: createSetupConfig(),
    })
    const cleared = await readCacheBody(cachePath)
    const projectOwner = Object.values(cleared.owners).find(owner => owner.kind === 'project')

    expect(projectOwner?.slots).toEqual([])
    expect(Object.values(cleared.entries).filter(entry => entry.target.kind === 'project')).toEqual([])
  })

  it('preserves stale project slots when source preparation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-cache-source-failure-'))
    const cachePath = join(root, '.alintcache')
    const missingPath = join(root, 'missing.txt')
    const rule = defineRule({ create: () => ({ onTargetProject: () => {} }) })

    await runAlint({
      config: createConfig({ review: rule }, { 'company/review': 'warn' }),
      cwd: root,
      runner: { cache: { location: cachePath } },
      setupConfig: createSetupConfig(),
    })
    const warmed = await readCacheBody(cachePath)
    const warmedSlots = Object.values(warmed.owners).find(owner => owner.kind === 'project')?.slots
    expect(warmedSlots).toHaveLength(1)

    await expect(runAlint({
      config: defineConfig([]),
      cwd: root,
      files: [missingPath],
      runner: { cache: { location: cachePath } },
      setupConfig: createSetupConfig(),
    })).rejects.toBeInstanceOf(AlintRunError)
    const preserved = await readCacheBody(cachePath)
    const projectOwner = Object.values(preserved.owners).find(owner => owner.kind === 'project')

    expect(projectOwner?.slots).toEqual(warmedSlots)
    expect(Object.values(preserved.entries).filter(entry => entry.target.kind === 'project')).toHaveLength(1)
  })

  it('keeps the existing source cache target hash alongside the project override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-source-cache-hash-'))
    const filePath = join(root, 'demo.txt')
    const text = 'source text\n'

    await writeFile(filePath, text)

    const rule = defineRule({
      create: () => ({ onTargetWith: () => {} }),
    })

    await runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
        {},
        { language: 'plaintext' },
      ),
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    const cacheFile = await readCacheBody(join(root, '.alintcache'))
    const sourceEntry = Object.values(cacheFile.entries).find(entry => entry.target.kind === 'file')
    const sourceHash = stableHash({
      language: 'plaintext',
      origin: { physicalPath: filePath },
      text,
    })

    expect(sourceEntry?.fingerprint.targetHash).toBe(sourceHash)
    expect(sourceEntry?.target.hash).toBe(sourceHash)
  })

  it('does not inspect extracted target metadata when project targets are disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-disabled-index-'))
    const filePath = join(root, 'demo.custom')

    await writeFile(filePath, 'unchanged\n')

    const rule = defineRule({ create: () => ({ onTargetProject: () => {} }) })
    const plugin = definePlugin({
      languages: {
        custom: {
          extensions: ['.custom'],
          extract: file => [{
            file,
            identity: 'file',
            kind: 'file',
            language: 'custom/plain',
            metadata: metadataWithUnsupportedValue('value', 1n),
            text: file.text,
          }],
          name: 'custom/plain',
        },
      },
      rules: { review: rule },
    })

    const result = await runAlint({
      config: defineConfig([
        { plugins: { company: plugin }, rules: { 'company/review': 'warn' } },
        { files: ['**/*.custom'], language: 'custom/plain' },
      ]),
      cwd: root,
      files: [filePath],
      projectTargets: false,
      setupConfig: createSetupConfig(),
    })

    expect(result.execution.planned).toBe(0)
  })

  it('does not inspect extracted target metadata without project handlers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-no-handlers-index-'))
    const filePath = join(root, 'demo.custom')

    await writeFile(filePath, 'unchanged\n')

    const rule = defineRule({ create: () => ({}) })
    const plugin = definePlugin({
      languages: {
        custom: {
          extensions: ['.custom'],
          extract: file => [{
            file,
            identity: 'file',
            kind: 'file',
            language: 'custom/plain',
            metadata: metadataWithUnsupportedValue('value', 1n),
            text: file.text,
          }],
          name: 'custom/plain',
        },
      },
      rules: { review: rule },
    })

    const result = await runAlint({
      config: defineConfig([
        { plugins: { company: plugin }, rules: { 'company/review': 'warn' } },
        { files: ['**/*.custom'], language: 'custom/plain' },
      ]),
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(result.execution.planned).toBe(0)
  })

  it('does not inspect extracted target metadata when the project is ignored', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-ignored-index-'))
    const filePath = join(root, 'demo.custom')
    const cyclicMetadata = metadataWithUnsupportedValue('self', undefined)
    Reflect.set(cyclicMetadata, 'self', cyclicMetadata)
    let extractionCalls = 0

    await writeFile(filePath, 'unchanged\n')

    const rule = defineRule({ create: () => ({ onTargetProject: () => {} }) })
    const plugin = definePlugin({
      languages: {
        custom: {
          extensions: ['.custom'],
          extract: (file) => {
            extractionCalls += 1
            return [{
              file,
              identity: 'file',
              kind: 'file',
              language: 'custom/plain',
              metadata: cyclicMetadata,
              text: file.text,
            }]
          },
          name: 'custom/plain',
        },
      },
      rules: { review: rule },
    })

    const result = await runAlint({
      config: defineConfig([
        { basePath: tmpdir(), extends: [{ ignores: [basename(root)] }] },
        { plugins: { company: plugin }, rules: { 'company/review': 'warn' } },
        { files: ['**/*.custom'], language: 'custom/plain' },
      ]),
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(extractionCalls).toBe(1)
    expect(result.execution.planned).toBe(0)
  })

  it('keeps project cache hashes distinct for observable roots sharing one cache', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'alint-project-cache-root-a-'))
    const secondRoot = await mkdtemp(join(tmpdir(), 'alint-project-cache-root-b-'))
    const cacheRoot = await mkdtemp(join(tmpdir(), 'alint-project-cache-shared-'))
    const cachePath = join(cacheRoot, '.alintcache')
    let handlerCalls = 0

    const rule = defineRule({
      create: ctx => ({
        onTargetProject: (target) => {
          handlerCalls += 1
          ctx.report({ filePath: target.root, message: target.root })
        },
      }),
    })
    const config = createConfig({ review: rule }, { 'company/review': 'warn' })

    const first = await runAlint({
      config,
      cwd: firstRoot,
      runner: { cache: { location: cachePath } },
      setupConfig: createSetupConfig(),
    })
    const second = await runAlint({
      config,
      cwd: secondRoot,
      runner: { cache: { location: cachePath } },
      setupConfig: createSetupConfig(),
    })

    expect(handlerCalls).toBe(2)
    expect(first.diagnostics[0]?.message).toBe(firstRoot)
    expect(second.diagnostics[0]?.message).toBe(secondRoot)
  })

  it('provides one project target containing compact file and target descriptors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-content-'))
    const firstPath = join(root, 'first.ts')
    const secondPath = join(root, 'second.ts')
    const visited: ProjectTarget[] = []

    await writeFile(firstPath, 'export const first = 1\n')
    await writeFile(secondPath, 'export const second = 2\n')

    const rule = defineRule({
      create: () => ({
        onTargetProject: (target) => {
          visited.push(target)
        },
      }),
    })

    await runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
      ),
      cwd: root,
      files: [secondPath, firstPath],
      setupConfig: createSetupConfig(),
    })

    expect(visited).toHaveLength(1)
    expect(visited[0]).toMatchObject({
      kind: 'project',
      root,
    })
    expect(visited[0]?.files).toEqual([
      {
        contentHash: hashText('export const second = 2\n'),
        language: 'typescript',
        path: secondPath,
        targetCount: 1,
      },
      {
        contentHash: hashText('export const first = 1\n'),
        language: 'typescript',
        path: firstPath,
        targetCount: 1,
      },
    ])
    expect(visited[0]?.targets).toEqual([
      expect.objectContaining({ filePath: secondPath, identity: 'file', kind: 'file' }),
      expect.objectContaining({ filePath: firstPath, identity: 'file', kind: 'file' }),
    ])
    expect(JSON.stringify(visited[0])).not.toContain('export const')
    expect(JSON.stringify(visited[0])).not.toContain('metadata')

    const cacheFile = await readCacheBody(join(root, '.alintcache'))
    const projectEntryKeys = Object.entries(cacheFile.entries)
      .filter(([, entry]) => entry.target.kind === 'project')
      .map(([key]) => key)

    expect(projectEntryKeys).toHaveLength(1)
    expect(Object.values(cacheFile.owners).find(owner => owner.kind === 'project')).toEqual(
      expect.objectContaining({ path: '.', slots: projectEntryKeys }),
    )
  })

  it('keeps project descriptors in input order when extraction completes out of order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-order-'))
    const firstPath = join(root, 'first.custom')
    const secondPath = join(root, 'second.custom')
    const firstMayFinish = Promise.withResolvers<void>()
    const visited: ProjectTarget[] = []

    await writeFile(firstPath, 'first\n')
    await writeFile(secondPath, 'second\n')

    const rule = defineRule({
      create: () => ({
        onTargetProject: (target) => {
          visited.push(target)
        },
      }),
    })
    const plugin = definePlugin({
      languages: {
        custom: {
          extensions: ['.custom'],
          extract: async (file) => {
            if (file.path === firstPath)
              await firstMayFinish.promise
            else
              firstMayFinish.resolve()

            return [{
              file,
              identity: 'file',
              kind: 'file',
              language: 'custom/plain',
              origin: { physicalPath: file.path },
              text: file.text,
            }]
          },
          name: 'custom/plain',
        },
      },
      rules: { review: rule },
    })

    await runAlint({
      config: defineConfig([
        {
          plugins: { company: plugin },
          rules: { 'company/review': 'warn' },
        },
        {
          files: ['**/*.custom'],
          language: 'custom/plain',
        },
      ]),
      cwd: root,
      files: [firstPath, secondPath],
      setupConfig: createSetupConfig(),
    })

    expect(visited[0]?.files.map(file => file.path)).toEqual([firstPath, secondPath])
    expect(visited[0]?.targets).toEqual([
      expect.objectContaining({ filePath: firstPath, identity: 'file', kind: 'file' }),
      expect.objectContaining({ filePath: secondPath, identity: 'file', kind: 'file' }),
    ])
  })

  it('invalidates the project cache when participating file content changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-cache-content-'))
    const filePath = join(root, 'demo.ts')
    let handlerCalls = 0

    await writeFile(filePath, 'export const value = 1\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetProject: async (target) => {
          handlerCalls += 1
          const file = await ctx.src.readFile(target.files[0]!.path)
          ctx.report({
            filePath: file.path,
            message: file.text,
          })
        },
      }),
    })
    const config = createConfig(
      { review: rule },
      { 'company/review': 'warn' },
    )
    const first = await runAlint({
      config,
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    await writeFile(filePath, 'export const value = 2\n')

    const second = await runAlint({
      config,
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(handlerCalls).toBe(2)
    expect(first.diagnostics[0]?.message).toBe('export const value = 1\n')
    expect(second.diagnostics[0]?.message).toBe('export const value = 2\n')
  })

  it('invalidates the project cache when file extraction config changes without content changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-cache-config-'))
    const filePath = join(root, 'demo.custom')
    const cachePath = join(root, '.alintcache')
    const ruleEndEvents: string[] = []
    let handlerCalls = 0

    await writeFile(filePath, 'unchanged\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetProject: (target) => {
          handlerCalls += 1
          ctx.report({
            filePath: target.files[0]?.path,
            message: 'project config changed',
          })
        },
      }),
    })
    const plugin = definePlugin({
      languages: {
        custom: {
          extensions: ['.custom'],
          extract: (file, options) => {
            const version = options.languageOptions.version
            if (typeof version !== 'number')
              throw new TypeError('Expected numeric language version.')
            return [{
              file,
              identity: 'file',
              kind: 'file',
              language: 'custom/plain',
              metadata: { version },
              origin: { physicalPath: file.path },
              text: file.text,
            }]
          },
          name: 'custom/plain',
        },
      },
      rules: { review: rule },
    })
    const createProjectConfig = (version: number) => defineConfig([
      {
        plugins: { company: plugin },
        rules: { 'company/review': 'warn' },
      },
      {
        files: ['**/*.custom'],
        language: 'custom/plain',
        languageOptions: { version },
      },
    ])

    await runAlint({
      config: createProjectConfig(1),
      cwd: root,
      files: [filePath],
      runner: { cache: { location: cachePath } },
      setupConfig: createSetupConfig(),
    })

    const second = await runAlint({
      config: createProjectConfig(2),
      cwd: root,
      files: [filePath],
      progress: {
        onJobEnd: payload => ruleEndEvents.push(`${payload.job.target.kind}:${payload.cache}`),
      },
      runner: { cache: { location: cachePath } },
      setupConfig: createSetupConfig(),
    })

    expect(handlerCalls).toBe(2)
    expect(second.diagnostics[0]?.message).toBe('project config changed')
    expect(ruleEndEvents).toEqual(['project:miss'])
  })

  it('invalidates the project cache when extracted targets change without config or content changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-cache-targets-'))
    const filePath = join(root, 'demo.custom')
    const cachePath = join(root, '.alintcache')
    const ruleEndEvents: string[] = []
    let handlerCalls = 0

    await writeFile(filePath, 'unchanged\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetProject: (target) => {
          handlerCalls += 1
          ctx.report({
            filePath: target.files[0]?.path,
            message: 'extracted target changed',
          })
        },
      }),
    })
    const createProjectConfig = (version: number) => createConfig(
      { review: rule },
      { 'company/review': 'warn' },
      {
        languages: {
          custom: {
            extensions: ['.custom'],
            extract: file => [{
              file,
              identity: 'file',
              kind: 'file',
              language: 'custom/plain',
              metadata: { version },
              origin: { physicalPath: file.path },
              text: `extracted-${version}`,
            }],
            name: 'custom/plain',
          },
        },
      },
      { language: 'custom/plain', languageOptions: { stable: true } },
    )

    await runAlint({
      config: createProjectConfig(1),
      cwd: root,
      files: [filePath],
      runner: { cache: { location: cachePath } },
      setupConfig: createSetupConfig(),
    })

    const second = await runAlint({
      config: createProjectConfig(2),
      cwd: root,
      files: [filePath],
      progress: {
        onJobEnd: payload => ruleEndEvents.push(`${payload.job.target.kind}:${payload.cache}`),
      },
      runner: { cache: { location: cachePath } },
      setupConfig: createSetupConfig(),
    })

    expect(handlerCalls).toBe(2)
    expect(second.diagnostics[0]?.message).toBe('extracted target changed')
    expect(ruleEndEvents).toEqual(['project:miss'])
  })

  it('does not run a project handler when the project root is globally ignored', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-ignore-'))
    let handlerCalls = 0

    const rule = defineRule({
      create: () => ({
        onTargetProject: () => {
          handlerCalls += 1
        },
      }),
    })

    await runAlint({
      config: defineConfig([
        { ignores: ['**'] },
        createConfig(
          { review: rule },
          { 'company/review': 'warn' },
        ),
      ]),
      cwd: root,
      setupConfig: createSetupConfig(),
    })

    expect(handlerCalls).toBe(0)
  })

  it('requires an explicit filePath for project diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-diagnostic-path-'))
    const rule = defineRule({
      create: ctx => ({
        onTargetProject: () => {
          ctx.report({ message: 'project issue' })
        },
      }),
    })

    await expect(runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
      ),
      cwd: root,
      setupConfig: createSetupConfig(),
    })).rejects.toMatchObject({
      failures: [{ message: 'Diagnostic for rule "company/review" is missing filePath.' }],
      message: '1 rule execution failed.',
      name: 'AlintRunError',
    })
  })

  it('accepts an explicit participating filePath for project diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-diagnostic-file-'))
    const filePath = join(root, 'demo.ts')

    await writeFile(filePath, 'export const demo = true\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetProject: (target) => {
          ctx.report({
            filePath: target.files[0]?.path,
            message: 'project issue',
          })
        },
      }),
    })

    const result = await runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
      ),
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(result.diagnostics).toMatchObject([{
      filePath,
      message: 'project issue',
    }])
  })

  it('retains partial results and project failure details when onTargetProject throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-error-'))
    const filePath = join(root, 'demo.ts')
    const runEndEvents: string[] = []

    await writeFile(filePath, 'export const demo = true\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetProject: (target) => {
          ctx.report({
            filePath: target.files[0]?.path,
            message: 'reported before project failure',
          })
          throw new Error('project exploded')
        },
      }),
    })

    let runError: unknown

    try {
      await runAlint({
        config: createConfig(
          { review: rule },
          { 'company/review': 'warn' },
        ),
        cwd: root,
        files: [filePath],
        progress: {
          onRunEnd: payload => runEndEvents.push(`${payload.diagnostics.length}:${payload.execution.failed}/${payload.execution.planned}`),
        },
        setupConfig: createSetupConfig(),
      })
    }
    catch (error) {
      runError = error
    }

    expect(runError).toBeInstanceOf(AlintRunError)
    expect(runError).toMatchObject({
      failures: [{
        job: {
          inputPath: root,
          ruleId: 'company/review',
          target: { kind: 'project' },
        },
        kind: 'handler',
        message: 'project exploded',
      }],
      result: {
        diagnostics: [{
          filePath,
          message: 'reported before project failure',
        }],
      },
    })
    expect(runEndEvents).toEqual(['1:1/1'])
  })

  it('does not run project handlers configured only for files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-file-scope-'))
    const filePath = join(root, 'demo.ts')
    let handlerCalls = 0

    await writeFile(filePath, 'export const demo = true\n')

    const rule = defineRule({
      create: () => ({
        onTargetProject: () => {
          handlerCalls += 1
        },
      }),
    })

    await runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
        {},
        { files: ['**/*.ts'] },
      ),
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(handlerCalls).toBe(0)
  })

  it('exposes outputLanguage on rule context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-output-language-'))
    const filePath = join(root, 'demo.ts')

    await writeFile(filePath, 'export function load() {}\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFile: () => {
          ctx.report({
            message: `output language: ${ctx.outputLanguage}`,
          })
        },
      }),
    })

    const result = await runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
      ),
      cwd: root,
      files: [filePath],
      outputLanguage: '简体中文',
      setupConfig: createSetupConfig(),
    })

    expect(result.diagnostics).toMatchObject([
      {
        filePath,
        message: 'output language: 简体中文',
      },
    ])
  })

  it('does not run plugin rules that are registered but not enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-plugin-disabled-'))
    const filePath = join(root, 'demo.ts')
    let handlerCalls = 0

    await writeFile(filePath, 'export function load() {}\n')

    const rule = defineRule({
      create: () => ({
        onTargetWith: () => {
          handlerCalls += 1
        },
      }),
    })

    const result = await runAlint({
      config: defineConfig([
        {
          plugins: {
            company: definePlugin({
              rules: { disabled: rule },
            }),
          },
        },
      ]),
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(handlerCalls).toBe(0)
    expect(result.diagnostics).toEqual([])
  })

  it('uses effective settings when creating rule runtimes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-settings-'))
    const filePath = join(root, 'demo.txt')

    await writeFile(filePath, 'hello\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetWith: () => {
          ctx.report({
            message: String(ctx.settings.message),
          })
        },
      }),
    })

    const result = await runAlint({
      config: createConfig(
        { settings: rule },
        { 'company/settings': 'warn' },
        {},
        {
          files: ['**/*.txt'],
          language: 'plaintext',
          settings: { message: 'from effective config' },
        },
      ),
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(result.diagnostics[0]?.message).toBe('from effective config')
  })

  it('wires ctx.agent from the configured agent adapter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-agent-'))
    const filePath = join(root, 'demo.txt')

    await writeFile(filePath, 'hello\n')

    let called = 0
    const adapter = async () => {
      called += 1

      return { answer: 'from the adapter' }
    }

    const rule = defineRule({
      create: ctx => ({
        onTargetFile: async (target) => {
          const agent = requireAgent(ctx)
          const file = await ctx.src.readFile(target.file)
          const { answer } = await agent({
            instructions: 'review',
            model: await ctx.model('default'),
            prompt: file.text,
            tools: [],
          })

          ctx.report({ message: answer })
        },
      }),
    })

    const result = await runAlint({
      config: createConfig(
        { boundary: rule },
        { 'company/boundary': 'warn' },
        {},
        { agent: adapter, files: ['**/*.txt'], language: 'plaintext' },
      ),
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(called).toBe(1)
    expect(result.diagnostics[0]?.message).toBe('from the adapter')
  })

  it('retries a retryable configured agent with the default agent retries', async () => {
    vi.useFakeTimers()
    let calls = 0

    try {
      const run = runSingleAgentRule({
        adapter: async () => {
          calls += 1
          if (calls < 3)
            throw new RetryableAgentError('temporary failure')
          return { answer: 'recovered' }
        },
      })

      await vi.waitFor(() => expect(calls).toBe(1))
      await vi.advanceTimersByTimeAsync(500)
      await vi.waitFor(() => expect(calls).toBe(2))
      await vi.advanceTimersByTimeAsync(1_000)
      const result = await run

      expect(calls).toBe(3)
      expect(result.diagnostics[0]?.message).toBe('recovered')
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('emits job retry progress for retryable configured agent failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-job-retry-progress-'))
    const filePath = join(root, 'demo.txt')
    const events: string[] = []
    let calls = 0

    await writeFile(filePath, 'hello\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFile: async () => {
          await ctx.agent!({
            instructions: 'review',
            model: await ctx.model(),
            prompt: 'review',
            tools: [],
          })
        },
      }),
    })

    await runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
        {},
        {
          agent: async () => {
            calls += 1
            if (calls < 3)
              throw new RetryableAgentError(`retry ${calls}`)
            return { answer: 'ok' }
          },
          language: 'plaintext',
        },
      ),
      files: [filePath],
      progress: {
        onJobRetry: payload => events.push(`${payload.job.ruleId}:${payload.attempt}/${payload.maxAttempts}`),
      },
      setupConfig: createSetupConfig(),
    })

    expect(events).toEqual([
      'company/review:1/3',
      'company/review:2/3',
    ])
  })

  it('propagates a retry progress reporter exception raised during a handler', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-job-retry-progress-failure-'))
    const filePath = join(root, 'demo.txt')
    const sentinel = new Error('retry reporter failed')
    let calls = 0

    await writeFile(filePath, 'hello\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFile: async () => {
          await ctx.agent!({
            instructions: 'review',
            model: await ctx.model(),
            prompt: 'review',
            tools: [],
          })
        },
      }),
    })

    let runError: unknown
    try {
      await runAlint({
        config: createConfig(
          { review: rule },
          { 'company/review': 'warn' },
          {},
          {
            agent: async () => {
              calls += 1
              if (calls === 1)
                throw new RetryableAgentError('retry once')
              return { answer: 'ok' }
            },
            language: 'plaintext',
          },
        ),
        files: [filePath],
        progress: { onJobRetry: () => { throw sentinel } },
        setupConfig: createSetupConfig(),
      })
    }
    catch (error) {
      runError = error
    }

    expect(runError).toBe(sentinel)
  })

  it('does not retry an ordinary configured agent error', async () => {
    const failure = new Error('ordinary configured agent failure')
    let calls = 0
    let error: unknown

    try {
      await runSingleAgentRule({
        adapter: async () => {
          calls += 1
          throw failure
        },
      })
    }
    catch (caught) {
      error = caught
    }

    expect(calls).toBe(1)
    expect(error).toBeInstanceOf(AlintRunError)
  })

  it('does not retry a retryable configured agent when agent retries are zero', async () => {
    let calls = 0

    await expect(runSingleAgentRule({
      adapter: async () => {
        calls += 1
        throw new RetryableAgentError('retry disabled')
      },
      runner: { agentRetries: 0 },
    })).rejects.toBeInstanceOf(AlintRunError)

    expect(calls).toBe(1)
  })

  it('ignores unused agent retry values when no adapter is configured', async () => {
    await expect(runAlint({
      config: [],
      runner: { agentRetries: -1 },
      setupConfig: createSetupConfig(),
    })).resolves.toMatchObject({ diagnostics: [] })
  })

  it('combines the rule timeout signal with an agent request signal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-agent-signal-'))
    const filePath = join(root, 'demo.txt')
    const requestController = new AbortController()
    let observedRuleSignal: AbortSignal | undefined
    let observedAgentSignal: AbortSignal | undefined

    await writeFile(filePath, 'hello\n')

    const adapter = async (request: Parameters<NonNullable<RuleContext['agent']>>[0]) => {
      observedAgentSignal = request.signal

      await new Promise<void>((resolve) => {
        const fallback = setTimeout(resolve, 50)
        request.signal?.addEventListener('abort', () => {
          clearTimeout(fallback)
          resolve()
        }, { once: true })
      })

      return { answer: 'done' }
    }
    const rule = defineRule({
      create: ctx => ({
        onTargetFile: async (target) => {
          observedRuleSignal = ctx.signal
          const file = await ctx.src.readFile(target.file)
          await requireAgent(ctx)({
            instructions: 'review',
            model: await ctx.model('default'),
            prompt: file.text,
            signal: requestController.signal,
            tools: [],
          })
        },
      }),
    })

    let runError: unknown
    try {
      await runAlint({
        config: createConfig(
          { boundary: rule },
          { 'company/boundary': 'warn' },
          {},
          { agent: adapter, files: ['**/*.txt'], language: 'plaintext' },
        ),
        cwd: root,
        files: [filePath],
        runner: { cache: false, timeoutMs: 5 },
        setupConfig: createSetupConfig(),
      })
    }
    catch (error) {
      runError = error
    }

    expect(runError).toBeInstanceOf(AlintRunError)
    expect((runError as AlintRunError).failures[0]?.kind).toBe('timeout')
    expect(observedRuleSignal?.aborted).toBe(true)
    expect(observedAgentSignal?.aborted).toBe(true)
    expect(requestController.signal.aborted).toBe(false)
  })

  it('ctx.agent throws a clear error when no agent is configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-agent-missing-'))
    const filePath = join(root, 'demo.txt')

    await writeFile(filePath, 'hello\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFile: async (target) => {
          const agent = requireAgent(ctx)
          const file = await ctx.src.readFile(target.file)

          await agent({
            instructions: 'review',
            model: await ctx.model('default'),
            prompt: file.text,
            tools: [],
          })
        },
      }),
    })

    await expect(runAlint({
      config: createConfig(
        { boundary: rule },
        { 'company/boundary': 'warn' },
        {},
        { files: ['**/*.txt'], language: 'plaintext' },
      ),
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
    })).rejects.toMatchObject({
      failures: [{ message: expect.stringMatching(/requires an agent/i) }],
    })
  })

  it('skips ignored files after resolving effective config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-ignore-'))
    const ignoredPath = join(root, 'ignored.ts')
    const checkedPath = join(root, 'checked.ts')
    const visited: string[] = []

    await writeFile(ignoredPath, 'export function ignored() {}\n')
    await writeFile(checkedPath, 'export function checked() {}\n')

    const rule = defineRule({
      create: () => ({
        onTargetFile: (target) => {
          visited.push(target.file.path)
        },
      }),
    })

    await runAlint({
      config: createConfig(
        { visit: rule },
        { 'company/visit': 'warn' },
        {},
        { ignores: ['ignored.ts'] },
      ),
      cwd: root,
      files: [ignoredPath, checkedPath],
      setupConfig: createSetupConfig(),
    })

    expect(visited.every(path => path === checkedPath)).toBe(true)
  })

  it('reports diagnostics with resolved model metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-model-'))
    const filePath = join(root, 'demo.ts')

    await writeFile(filePath, [
      'export function load() {',
      '  return 1',
      '}',
    ].join('\n'))

    const rule = defineRule({
      create: ctx => ({
        onTargetFunction: async (target) => {
          const model = await ctx.model()
          const file = await ctx.src.readFile(target.file)
          const source = target.range ? ctx.src.sliceRange(file, target.range).text : file.text

          ctx.report({
            evidence: {
              modelName: model.name,
              source,
            },
            loc: target.loc,
            message: `loaded by ${model.id}`,
          })
        },
      }),
      languages: 'any',
      model: {
        capabilities: ['structured-output'],
      },
    })

    const result = await runAlint({
      config: createConfig({ 'prefer-load': rule }, { 'company/prefer-load': 'warn' }),
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({
      filePath,
      message: 'loaded by local:qwen-8b',
      model: {
        providerId: 'ollama',
        resolvedId: 'local:qwen-8b',
      },
      ruleId: 'company/prefer-load',
      severity: 'warn',
    })
    expect(result.diagnostics[0]?.loc).toEqual({
      end: { column: 1, line: 3 },
      start: { column: 7, line: 1 },
    })
  })

  it('lets modelOverride force model selection over rule string selectors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-model-override-'))
    const filePath = join(root, 'demo.ts')

    await writeFile(filePath, 'export function load() {}\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFunction: async (target) => {
          const model = await ctx.model('default')

          ctx.report({
            filePath: target.file.path,
            message: `loaded by ${model.id}`,
          })
        },
      }),
      languages: 'any',
      model: {
        capabilities: ['structured-output'],
      },
    })

    const result = await runAlint({
      config: createConfig({ 'prefer-load': rule }, { 'company/prefer-load': 'warn' }),
      files: [filePath],
      modelOverride: 'override',
      setupConfig: createSetupConfig(),
    })

    expect(result.diagnostics[0]).toMatchObject({
      message: 'loaded by local:qwen-32b',
      model: {
        requested: 'override',
        resolvedId: 'local:qwen-32b',
      },
    })
  })

  it('uses defaultModel only when the rule and call have no selector', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-model-default-'))
    const filePath = join(root, 'demo.ts')

    await writeFile(filePath, 'export function load() {}\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFunction: async (target) => {
          const defaultModel = await ctx.model()
          ctx.report({
            filePath: target.file.path,
            message: `default: ${defaultModel.id}`,
          })

          const namedModel = await ctx.model('default')
          ctx.report({
            filePath: target.file.path,
            message: `named: ${namedModel.id}`,
          })

          const selectedModel = await ctx.model({ size: 'small' })
          ctx.report({
            filePath: target.file.path,
            message: `selected: ${selectedModel.id}`,
          })
        },
      }),
      languages: 'any',
    })

    const result = await runAlint({
      config: createConfig({ 'prefer-load': rule }, { 'company/prefer-load': 'warn' }),
      defaultModel: 'override',
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(result.diagnostics.map(diagnostic => diagnostic.message)).toEqual([
      'default: local:qwen-32b',
      'named: local:qwen-8b',
      'selected: local:qwen-8b',
    ])
  })

  it('does not use defaultModel when the rule declares a model requirement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-rule-model-default-'))
    const filePath = join(root, 'demo.ts')

    await writeFile(filePath, 'export function load() {}\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFunction: async (target) => {
          const model = await ctx.model()

          ctx.report({
            filePath: target.file.path,
            message: `loaded by ${model.id}`,
          })
        },
      }),
      languages: 'any',
      model: { size: 'small' },
    })

    const result = await runAlint({
      config: createConfig({ 'prefer-load': rule }, { 'company/prefer-load': 'warn' }),
      defaultModel: 'override',
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(result.diagnostics[0]).toMatchObject({
      message: 'loaded by local:qwen-8b',
      model: {
        requested: undefined,
        resolvedId: 'local:qwen-8b',
      },
    })
  })

  it('explains how to configure a missing defaultModel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-missing-default-model-'))
    const filePath = join(root, 'demo.ts')
    const setupConfig = createSetupConfig()

    setupConfig.providers[0]!.models[0]!.aliases = []
    await writeFile(filePath, 'export function load() {}\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFunction: async () => {
          await ctx.model()
        },
      }),
      languages: 'any',
    })

    await expect(runAlint({
      config: createConfig({ 'prefer-load': rule }, { 'company/prefer-load': 'warn' }),
      defaultModel: 'default',
      files: [filePath],
      setupConfig,
    })).rejects.toMatchObject({
      failures: [{
        message: 'Default model "default" is not configured. Configure a system default model or select a model for this project.',
      }],
    })
  })

  it('does not carry model metadata into later reports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-model-reset-'))
    const filePath = join(root, 'demo.ts')

    await writeFile(filePath, 'export function load() {}\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFile: async () => {
          await ctx.model()
          ctx.report({
            message: 'with model',
          })
          ctx.report({
            message: 'without model',
          })
        },
      }),
      model: {
        capabilities: ['structured-output'],
      },
    })

    const result = await runAlint({
      config: createConfig({ 'report-twice': rule }, { 'company/report-twice': 'warn' }),
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(result.diagnostics).toHaveLength(2)
    expect(result.diagnostics[0]?.model?.resolvedId).toBe('local:qwen-8b')
    expect(result.diagnostics[1]?.model).toBeUndefined()
  })

  it('accumulates usage records emitted by rules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-usage-'))
    const filePath = join(root, 'demo.ts')

    await writeFile(filePath, 'export function load() {}\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFile: (target) => {
          ctx.metering.recordUsage({
            filePath: target.file.path,
            inputTokens: 10,
            metadata: {
              operation: 'judge',
            },
            modelId: 'local:qwen-8b',
            outputTokens: 4,
            providerId: 'ollama',
            totalTokens: 14,
          })
          ctx.metering.recordUsage({
            filePath: target.file.path,
            inputTokens: 3,
            modelId: 'local:qwen-8b',
            outputTokens: 2,
            providerId: 'ollama',
            totalTokens: 5,
          })
        },
      }),
    })

    const result = await runAlint({
      config: createConfig({ 'record-usage': rule }, { 'company/record-usage': 'warn' }),
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(result.usage).toEqual({
      inputTokens: 13,
      outputTokens: 6,
      records: [
        {
          filePath,
          inputTokens: 10,
          metadata: {
            operation: 'judge',
          },
          modelId: 'local:qwen-8b',
          outputTokens: 4,
          providerId: 'ollama',
          ruleId: 'company/record-usage',
          totalTokens: 14,
        },
        {
          filePath,
          inputTokens: 3,
          modelId: 'local:qwen-8b',
          outputTokens: 2,
          providerId: 'ollama',
          ruleId: 'company/record-usage',
          totalTokens: 5,
        },
      ],
      totalTokens: 19,
    })
  })

  describe('target cache', () => {
    it('reuses cached entries when defaultModel is ignored by modelOverride', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-model-override-'))
      const filePath = join(root, 'demo.ts')
      const cachePath = join(root, '.alintcache')
      let handlerCalls = 0

      await writeFile(filePath, 'export function load() {}\n')

      const rule = defineRule({
        create: ctx => ({
          onTargetFunction: async (target) => {
            handlerCalls += 1
            const model = await ctx.model()

            ctx.report({
              filePath: target.file.path,
              message: `loaded by ${model.id}`,
            })
          },
        }),
        languages: 'any',
      })
      const config = createConfig({ 'prefer-load': rule }, { 'company/prefer-load': 'warn' })

      await runAlint({
        config,
        defaultModel: 'default',
        files: [filePath],
        modelOverride: 'override',
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      const result = await runAlint({
        config,
        defaultModel: 'unused-default',
        files: [filePath],
        modelOverride: 'override',
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      expect(handlerCalls).toBe(1)
      expect(result.diagnostics[0]).toMatchObject({
        cached: true,
        message: 'loaded by local:qwen-32b',
        model: {
          requested: 'override',
          resolvedId: 'local:qwen-32b',
        },
      })
    })

    it('reuses existing rule entries when another rule is enabled', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-added-rule-'))
      const filePath = join(root, 'demo.txt')
      const cachePath = join(root, '.alintcache')
      const calls = { first: 0, second: 0 }
      const ruleEndEvents: string[] = []

      await writeFile(filePath, 'unchanged\n')

      const firstRule = defineRule({
        create: () => ({
          onTargetFile: () => {
            calls.first += 1
          },
        }),
      })
      const secondRule = defineRule({
        create: () => ({
          onTargetFile: () => {
            calls.second += 1
          },
        }),
      })

      await runAlint({
        config: createConfig(
          { first: firstRule, second: secondRule },
          { 'company/first': 'warn' },
          {},
          { language: 'plaintext' },
        ),
        files: [filePath],
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      const result = await runAlint({
        config: createConfig(
          { first: firstRule, second: secondRule },
          { 'company/first': 'warn', 'company/second': 'warn' },
          {},
          { language: 'plaintext' },
        ),
        files: [filePath],
        progress: {
          onJobEnd: payload => ruleEndEvents.push(`${payload.job.ruleId}:${payload.cache}`),
        },
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      expect(calls).toEqual({ first: 1, second: 1 })
      expect(ruleEndEvents).toEqual([
        'company/first:hit',
        'company/second:miss',
      ])
      expect(result.execution).toEqual({
        cached: 1,
        cancelled: 0,
        completed: 1,
        failed: 0,
        planned: 2,
        queued: 0,
        running: 0,
        skipped: 0,
      })
    })

    it('invalidates a rule entry when its explicit cache key changes', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-rule-key-'))
      const filePath = join(root, 'demo.txt')
      const cachePath = join(root, '.alintcache')
      const ruleEndEvents: string[] = []
      let handlerCalls = 0

      await writeFile(filePath, 'unchanged\n')

      const create = () => ({
        onTargetFile: () => {
          handlerCalls += 1
        },
      })
      const createVersionedConfig = (cacheKey: string) => createConfig(
        { review: defineRule({ cacheKey, create }) },
        { 'company/review': 'warn' },
        {},
        { language: 'plaintext' },
      )

      await runAlint({
        config: createVersionedConfig('prompt-v1'),
        files: [filePath],
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })
      await runAlint({
        config: createVersionedConfig('prompt-v2'),
        files: [filePath],
        progress: {
          onJobEnd: payload => ruleEndEvents.push(payload.cache),
        },
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })
      const cacheBody = await readCacheBody(cachePath)

      expect(handlerCalls).toBe(2)
      expect(ruleEndEvents).toEqual(['miss'])
      expect(Object.values(cacheBody.owners)[0]?.slots).toHaveLength(1)
      expect(Object.keys(cacheBody.entries)).toHaveLength(1)
    })

    it('reuses cached diagnostics and usage on unchanged targets', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-run-'))
      const filePath = join(root, 'demo.ts')
      const cachePath = join(root, '.alintcache')
      const diagnosticEvents: string[] = []
      const usageEvents: string[] = []
      const ruleEndEvents: string[] = []
      let handlerCalls = 0

      await writeFile(filePath, 'export function load() {}\n')

      const rule = defineRule({
        create: ctx => ({
          onTargetFunction: (target) => {
            handlerCalls += 1
            ctx.report({
              loc: target.loc,
              message: `checked ${target.name}`,
            })
            ctx.metering.recordUsage({
              filePath: target.file.path,
              inputTokens: 7,
              modelId: 'local:qwen-8b',
              outputTokens: 3,
              providerId: 'ollama',
              totalTokens: 10,
            })
          },
        }),
        languages: 'any',
      })
      const config = createConfig({ cached: rule }, { 'company/cached': 'warn' })

      await runAlint({
        config,
        files: [filePath],
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      const result = await runAlint({
        config,
        files: [filePath],
        progress: {
          onDiagnostic: payload => diagnosticEvents.push(`${payload.diagnostic.message}:${payload.job.target.kind}`),
          onJobEnd: payload => ruleEndEvents.push(`${payload.job.target.kind}:${payload.cache}:${payload.state}`),
          onUsage: payload => usageEvents.push(`${payload.record.totalTokens}:${payload.job.target.kind}`),
        },
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })
      const cacheBody = await readCacheBody(cachePath)

      expect(handlerCalls).toBe(1)
      expect(result.diagnostics).toMatchObject([
        {
          cached: true,
          filePath,
          message: 'checked load',
          ruleId: 'company/cached',
        },
      ])
      expect(result.usage).toEqual({
        cached: {
          inputTokens: 7,
          outputTokens: 3,
          records: [expect.objectContaining({
            ruleId: 'company/cached',
            totalTokens: 10,
          })],
          totalTokens: 10,
        },
        inputTokens: 0,
        outputTokens: 0,
        records: [],
        totalTokens: 0,
      })
      expect(result.execution).toEqual({
        cached: 1,
        cancelled: 0,
        completed: 0,
        failed: 0,
        planned: 1,
        queued: 0,
        running: 0,
        skipped: 0,
      })
      expect(diagnosticEvents).toEqual([
        'checked load:function',
      ])
      expect(usageEvents).toEqual([
        '10:function',
      ])
      expect(ruleEndEvents).toEqual([
        'function:hit:cached',
      ])
      expect(Object.values(cacheBody.owners)[0]?.slots).toHaveLength(1)
      expect(Object.keys(cacheBody.entries)).toHaveLength(1)
    })

    it('cancels after rule start without replaying a warm cache entry', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-rule-start-cancel-'))
      const filePath = join(root, 'demo.txt')
      const cachePath = join(root, '.alintcache')
      const controller = new AbortController()
      const reason = new Error('cancelled from rule start')
      const ruleEnds: string[] = []
      let handlerCalls = 0
      await writeFile(filePath, 'hello\n')
      const rule = defineRule({
        create: ctx => ({
          onTargetFile: () => {
            handlerCalls += 1
            ctx.report({ message: 'cached diagnostic' })
            ctx.metering.recordUsage({
              inputTokens: 3,
              modelId: 'cached-model',
              providerId: 'cached-provider',
              totalTokens: 3,
            })
          },
        }),
      })
      const config = createConfig(
        { cancel: rule },
        { 'company/cancel': 'warn' },
        {},
        { language: 'plaintext' },
      )

      await runAlint({
        config,
        files: [filePath],
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      let runError: unknown
      try {
        await runAlint({
          config,
          files: [filePath],
          progress: {
            onJobEnd: payload => ruleEnds.push(`${payload.cache}:${payload.state}`),
            onJobStart: () => controller.abort(reason),
          },
          runner: { cache: { location: cachePath } },
          setupConfig: createSetupConfig(),
          signal: controller.signal,
        })
      }
      catch (error) {
        runError = error
      }

      expect(runError).toBeInstanceOf(AlintRunCancelledError)
      expect((runError as AlintRunCancelledError).cause).toBe(reason)
      expect((runError as AlintRunCancelledError).result).toEqual({
        diagnostics: [],
        execution: {
          cached: 0,
          cancelled: 1,
          completed: 0,
          failed: 0,
          planned: 1,
          queued: 0,
          running: 0,
          skipped: 0,
        },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          records: [],
          totalTokens: 0,
        },
      })
      expect(handlerCalls).toBe(1)
      expect(ruleEnds).toEqual(['miss:cancelled'])

      const retained = await readCacheBody(cachePath)
      expect(Object.values(retained.owners)[0]?.slots).toHaveLength(1)
      expect(Object.keys(retained.entries)).toHaveLength(1)

      const replayed = await runAlint({
        config,
        files: [filePath],
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      expect(handlerCalls).toBe(1)
      expect(replayed.execution.cached).toBe(1)
    })

    it('reruns changed function targets while reusing unchanged siblings', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-siblings-'))
      const filePath = join(root, 'demo.ts')
      const cachePath = join(root, '.alintcache')
      const calls = new Map<string, number>()
      const ruleEndEvents: string[] = []

      await writeFile(filePath, [
        'export function first() {',
        '  return 1',
        '}',
        'export function second() {',
        '  return 2',
        '}',
      ].join('\n'))

      const rule = defineRule({
        create: ctx => ({
          onTargetFunction: async (target) => {
            const name = target.name ?? 'anonymous'
            calls.set(name, (calls.get(name) ?? 0) + 1)
            const file = await ctx.src.readFile(target.file)
            const source = target.range ? ctx.src.sliceRange(file, target.range).text : file.text
            ctx.report({
              message: `${name}:${source.includes('return 3') ? 'changed' : 'original'}`,
            })
          },
        }),
        languages: 'any',
      })
      const config = createConfig({ siblings: rule }, { 'company/siblings': 'warn' })

      await runAlint({
        config,
        files: [filePath],
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      await writeFile(filePath, [
        'export function first() {',
        '  return 1',
        '}',
        'export function second() {',
        '  return 3',
        '}',
      ].join('\n'))

      const result = await runAlint({
        config,
        files: [filePath],
        progress: {
          onJobEnd: payload => ruleEndEvents.push(`${payload.job.target.name ?? payload.job.target.kind}:${payload.cache}`),
        },
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })
      const cacheBody = await readCacheBody(cachePath)

      expect(Object.fromEntries(calls)).toEqual({
        first: 1,
        second: 2,
      })
      expect(result.diagnostics.map(diagnostic => diagnostic.message)).toEqual([
        'first:original',
        'second:changed',
      ])
      expect(ruleEndEvents).toEqual([
        'first:hit',
        'second:miss',
      ])
      expect(Object.values(cacheBody.owners)[0]?.slots).toHaveLength(2)
      expect(Object.keys(cacheBody.entries)).toHaveLength(2)
    })

    it('does not cache rules that opt out', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-opt-out-'))
      const filePath = join(root, 'demo.ts')
      const cachePath = join(root, '.alintcache')
      const ruleEndEvents: string[] = []
      let handlerCalls = 0

      await writeFile(filePath, 'export function load() {}\n')

      const rule = defineRule({
        cache: false,
        create: ctx => ({
          onTargetFunction: (target) => {
            handlerCalls += 1
            ctx.report({
              message: `call ${handlerCalls} ${target.name}`,
            })
          },
        }),
        languages: 'any',
      })
      const config = createConfig({ uncached: rule }, { 'company/uncached': 'warn' })

      await runAlint({
        config,
        files: [filePath],
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })
      const result = await runAlint({
        config,
        files: [filePath],
        progress: {
          onJobEnd: payload => ruleEndEvents.push(`${payload.job.target.kind}:${payload.cache}`),
        },
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      expect(handlerCalls).toBe(2)
      expect(result.diagnostics).toMatchObject([
        {
          message: 'call 2 load',
        },
      ])
      expect(ruleEndEvents).toEqual([
        'function:miss',
      ])
    })

    it('invalidates cached entries when effective settings change', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-settings-'))
      const filePath = join(root, 'demo.txt')
      const cachePath = join(root, '.alintcache')
      const ruleEndEvents: string[] = []

      await writeFile(filePath, 'hello\n')

      const rule = defineRule({
        create: ctx => ({
          onTargetFile: () => {
            ctx.report({
              message: String(ctx.settings.message),
            })
          },
        }),
      })
      const createSettingsConfig = (message: string) => createConfig(
        { settings: rule },
        { 'company/settings': 'warn' },
        {},
        {
          language: 'plaintext',
          settings: { message },
        },
      )

      await runAlint({
        config: createSettingsConfig('first'),
        files: [filePath],
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      const result = await runAlint({
        config: createSettingsConfig('second'),
        files: [filePath],
        progress: {
          onJobEnd: payload => ruleEndEvents.push(payload.cache),
        },
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })
      const cacheBody = await readCacheBody(cachePath)

      expect(result.diagnostics[0]?.message).toBe('second')
      expect(ruleEndEvents).toEqual([
        'miss',
      ])
      expect(Object.values(cacheBody.owners)[0]?.slots).toHaveLength(1)
      expect(Object.keys(cacheBody.entries)).toHaveLength(1)
    })

    it('invalidates cached entries when output language changes', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-output-language-'))
      const filePath = join(root, 'demo.ts')
      const cachePath = join(root, '.alintcache')
      const ruleEndEvents: string[] = []
      let calls = 0

      await writeFile(filePath, 'export function load() {}\n')

      const rule = defineRule({
        create: ctx => ({
          onTargetFunction: () => {
            calls += 1
            ctx.report({
              message: `checked in ${ctx.outputLanguage}`,
            })
          },
        }),
        languages: 'any',
      })
      const config = createConfig({ language: rule }, { 'company/language': 'warn' })

      await runAlint({
        config,
        cwd: root,
        files: [filePath],
        outputLanguage: 'English',
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      const result = await runAlint({
        config,
        cwd: root,
        files: [filePath],
        outputLanguage: '日本語',
        progress: {
          onJobEnd: payload => ruleEndEvents.push(payload.cache),
        },
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })
      const cacheBody = await readCacheBody(cachePath)

      expect(calls).toBe(2)
      expect(result.diagnostics[0]?.message).toBe('checked in 日本語')
      expect(ruleEndEvents).toEqual([
        'miss',
      ])
      expect(Object.values(cacheBody.owners)[0]?.slots).toHaveLength(1)
      expect(Object.keys(cacheBody.entries)).toHaveLength(1)
    })

    it('invalidates cached entries when implicit language resolution changes', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-language-'))
      const filePath = join(root, 'demo.custom')
      const cachePath = join(root, '.alintcache')
      const ruleEndEvents: string[] = []

      await writeFile(filePath, 'hello\n')

      const rule = defineRule({
        create: ctx => ({
          onTargetFile: (target) => {
            ctx.report({
              message: target.language,
            })
          },
        }),
      })
      const createLanguageConfig = (name: string) => createConfig(
        { language: rule },
        { 'company/language': 'warn' },
        {
          languages: {
            custom: {
              extensions: ['.custom'],
              extract: file => [{
                file,
                identity: 'file',
                kind: 'file',
                language: name,
                origin: { physicalPath: file.path },
                text: file.text,
              }],
              name,
            },
          },
        },
      )

      await runAlint({
        config: createLanguageConfig('custom/first'),
        files: [filePath],
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      const result = await runAlint({
        config: createLanguageConfig('custom/second'),
        files: [filePath],
        progress: {
          onJobEnd: payload => ruleEndEvents.push(payload.cache),
        },
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })
      const cacheBody = await readCacheBody(cachePath)

      expect(result.diagnostics[0]?.message).toBe('custom/second')
      expect(ruleEndEvents).toEqual([
        'miss',
      ])
      expect(Object.values(cacheBody.owners)[0]?.slots).toHaveLength(1)
      expect(Object.keys(cacheBody.entries)).toHaveLength(1)
    })

    it('invalidates cached entries when target metadata changes without text changes', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-target-metadata-'))
      const filePath = join(root, 'demo.custom')
      const cachePath = join(root, '.alintcache')
      const ruleEndEvents: string[] = []

      await writeFile(filePath, 'hello\n')

      const rule = defineRule({
        create: ctx => ({
          onTargetFile: (target) => {
            ctx.report({
              message: String(target.metadata?.version),
            })
          },
        }),
      })
      const createMetadataConfig = (version: number) => createConfig(
        { metadata: rule },
        { 'company/metadata': 'warn' },
        {
          languages: {
            custom: {
              extensions: ['.custom'],
              extract: file => [{
                file,
                identity: 'file',
                kind: 'file',
                language: 'custom/plain',
                metadata: { version },
                origin: { physicalPath: file.path },
                text: file.text,
              }],
              name: 'custom/plain',
            },
          },
        },
      )

      await runAlint({
        config: createMetadataConfig(1),
        files: [filePath],
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      const result = await runAlint({
        config: createMetadataConfig(2),
        files: [filePath],
        progress: {
          onJobEnd: payload => ruleEndEvents.push(payload.cache),
        },
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })
      const cacheBody = await readCacheBody(cachePath)

      expect(result.diagnostics[0]?.message).toBe('2')
      expect(ruleEndEvents).toEqual([
        'miss',
      ])
      expect(Object.values(cacheBody.owners)[0]?.slots).toHaveLength(1)
      expect(Object.keys(cacheBody.entries)).toHaveLength(1)
    })

    it('keeps custom target identities distinct when text and kind match', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-target-identity-'))
      const filePath = join(root, 'demo.custom')
      const cachePath = join(root, '.alintcache')
      const firstRunMessages: string[] = []
      const secondRunMessages: string[] = []

      await writeFile(filePath, 'same\n')

      const rule = defineRule({
        create: ctx => ({
          onTargetFile: (target) => {
            ctx.report({
              message: target.identity,
            })
          },
        }),
      })
      const config = createConfig(
        { identity: rule },
        { 'company/identity': 'warn' },
        {
          languages: {
            custom: {
              extensions: ['.custom'],
              extract: file => ['alpha', 'beta'].map(identity => ({
                file,
                identity,
                kind: 'file',
                language: 'custom/plain',
                origin: { physicalPath: file.path },
                text: file.text,
              })),
              name: 'custom/plain',
            },
          },
        },
      )

      const firstResult = await runAlint({
        config,
        files: [filePath],
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      firstRunMessages.push(...firstResult.diagnostics.map(diagnostic => diagnostic.message))

      const secondResult = await runAlint({
        config,
        files: [filePath],
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      secondRunMessages.push(...secondResult.diagnostics.map(diagnostic => diagnostic.message))

      expect(firstRunMessages).toEqual([
        'alpha',
        'beta',
      ])
      expect(secondRunMessages).toEqual([
        'alpha',
        'beta',
      ])
    })

    it('caches duplicate target identities with the same range in distinct slots', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-duplicate-target-identity-'))
      const filePath = join(root, 'demo.custom')
      const cachePath = join(root, '.alintcache')
      const coldIdentities: string[] = []
      const warmIdentities: string[] = []
      let handlerCalls = 0
      await writeFile(filePath, 'source')
      const rule = defineRule({
        create: ctx => ({
          onTargetFunction: (target) => {
            handlerCalls += 1
            ctx.report({ message: String(target.metadata?.label) })
          },
        }),
        languages: 'any',
      })
      const config = createConfig(
        { duplicate: rule },
        { 'company/duplicate': 'warn' },
        {
          languages: {
            custom: {
              extensions: ['.custom'],
              extract: file => ['first', 'second'].map(text => ({
                file,
                identity: 'same',
                kind: 'function' as const,
                language: 'custom',
                metadata: { label: text },
                range: { end: 1, start: 0 },
                text,
              })),
              name: 'custom',
            },
          },
        },
        { language: 'custom' },
      )

      const cold = await runAlint({
        config,
        cwd: root,
        files: [filePath],
        progress: { onJobQueued: ({ job }) => coldIdentities.push(job.target.identity) },
        projectTargets: false,
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })
      const warm = await runAlint({
        config,
        cwd: root,
        files: [filePath],
        progress: { onJobQueued: ({ job }) => warmIdentities.push(job.target.identity) },
        projectTargets: false,
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })
      const body = await readCacheBody(cachePath)

      expect(handlerCalls).toBe(2)
      expect(cold.execution.completed).toBe(2)
      expect(cold.diagnostics.map(diagnostic => diagnostic.message)).toEqual(['first', 'second'])
      expect(new Set(coldIdentities).size).toBe(2)
      expect(warmIdentities).toEqual(coldIdentities)
      expect(warm.execution.cached).toBe(2)
      expect(warm.execution.completed).toBe(0)
      expect(warm.diagnostics.map(diagnostic => diagnostic.message)).toEqual(['first', 'second'])
      expect(Object.values(body.owners)[0]?.slots).toHaveLength(2)
      expect(Object.keys(body.entries)).toHaveLength(2)
    })
  })

  it('rejects create-time diagnostics even with an explicit filePath', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-create-diagnostic-order-'))
    const filePath = join(root, 'demo.txt')
    await writeFile(filePath, 'hello\n')
    const rule = defineRule({
      create: (ctx) => {
        ctx.report({ filePath, message: 'create-time diagnostic' })
        return {}
      },
    })

    await expect(runAlint({
      config: createConfig(
        { create: rule },
        { 'company/create': 'warn' },
        {},
        { language: 'plaintext' },
      ),
      files: [filePath],
      setupConfig: createSetupConfig(),
    })).rejects.toThrow('Cannot report a diagnostic outside an active rule job.')
  })

  it('rejects create-time usage without silently dropping it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-create-usage-order-'))
    const filePath = join(root, 'demo.txt')
    await writeFile(filePath, 'hello\n')
    const rule = defineRule({
      create: (ctx) => {
        ctx.metering.recordUsage({ modelId: 'model', providerId: 'provider' })
        return {}
      },
    })

    await expect(runAlint({
      config: createConfig(
        { create: rule },
        { 'company/create': 'warn' },
        {},
        { language: 'plaintext' },
      ),
      files: [filePath],
      setupConfig: createSetupConfig(),
    })).rejects.toThrow('Cannot record usage outside an active rule job.')
  })

  it('uses four rule permits by default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-default-rule-concurrency-'))
    const files = Array.from({ length: 8 }, (_, index) => join(root, `${index}.txt`))
    await Promise.all(files.map((file, index) => writeFile(file, `${index}\n`)))
    let active = 0
    let maximum = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const rule = defineRule({
      create: () => ({
        onTargetFile: async () => {
          active += 1
          maximum = Math.max(maximum, active)
          if (active === 4)
            release()
          await gate
          active -= 1
        },
      }),
    })

    await runAlint({
      config: createConfig({ concurrency: rule }, { 'company/concurrency': 'warn' }, {}, { language: 'plaintext' }),
      cwd: root,
      files,
      setupConfig: createSetupConfig(),
    })

    expect(maximum).toBe(4)
  })

  it('shares one rule concurrency cap across source, directory, and project jobs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-cross-target-concurrency-'))
    const filePath = join(root, 'demo.ts')
    const directoryPath = join(root, 'workspace')
    await writeFile(filePath, 'export class Demo {}\nexport function demo() {}\n')
    const started: string[] = []
    let active = 0
    let maximum = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const hold = async (kind: string): Promise<void> => {
      started.push(kind)
      active += 1
      maximum = Math.max(maximum, active)
      if (active === 2)
        release()
      await gate
      active -= 1
    }
    const rules = {
      class: defineRule({
        create: () => ({ onTargetClass: () => hold('class') }),
        languages: 'any',
      }),
      directory: defineRule({ create: () => ({ onTargetDirectory: () => hold('directory') }) }),
      file: defineRule({ create: () => ({ onTargetFile: () => hold('file') }) }),
      function: defineRule({
        create: () => ({ onTargetFunction: () => hold('function') }),
        languages: 'any',
      }),
      project: defineRule({ create: () => ({ onTargetProject: () => hold('project') }) }),
    }

    await runAlint({
      config: createConfig(rules, {
        'company/class': 'warn',
        'company/directory': 'warn',
        'company/file': 'warn',
        'company/function': 'warn',
        'company/project': 'warn',
      }),
      cwd: root,
      directories: [directoryPath],
      files: [filePath],
      runner: { ruleConcurrency: 2 },
      setupConfig: createSetupConfig(),
    })

    expect(new Set(started)).toEqual(new Set(['class', 'directory', 'file', 'function', 'project']))
    expect(maximum).toBe(2)
  })

  it('allows one RuleRuntime to overlap while keeping job context isolated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-concurrent-runtime-context-'))
    const filePath = join(root, 'demo.ts')
    await writeFile(filePath, 'export class Demo {}\nexport function demo() {}\n')
    const visited: string[] = []
    let active = 0
    let maximum = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const rule = defineRule({
      create: ctx => ({
        onTargetWith: async (target) => {
          if (target.kind === 'project' || target.kind === 'directory')
            return
          active += 1
          maximum = Math.max(maximum, active)
          ctx.report({ message: target.kind })
          visited.push(`${target.kind}:${ctx.signal?.aborted}`)
          if (active === 3)
            release()
          await gate
          active -= 1
        },
      }),
      languages: 'any',
    })

    await runAlint({
      config: createConfig({ context: rule }, { 'company/context': 'warn' }),
      cwd: root,
      files: [filePath],
      runner: { ruleConcurrency: 8 },
      setupConfig: createSetupConfig(),
    })

    expect(visited).toEqual(['file:false', 'class:false', 'function:false'])
    expect(maximum).toBe(3)
  })

  it('keeps diagnostics, usage, and failures ordered with concurrency 1 and 8', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-opposite-completion-'))
    const filePath = join(root, 'demo.txt')
    await writeFile(filePath, 'hello\n')

    const runWithConcurrency = async (ruleConcurrency: 1 | 8, completionOrder?: number[]) => {
      const releases = Array.from({ length: 2 }, () => {
        let release!: () => void
        const promise = new Promise<void>((resolve) => {
          release = resolve
        })
        return { promise, release }
      })
      let started = 0
      let allStarted!: () => void
      const startedPromise = new Promise<void>((resolve) => {
        allStarted = resolve
      })
      const names = ['first', 'second']
      const observationOrder: string[] = []
      const rules = Object.fromEntries(names.map((name, index) => [name, defineRule({
        create: ctx => ({
          onTargetFile: async () => {
            started += 1
            if (started === names.length)
              allStarted()
            if (completionOrder)
              await releases[index]!.promise
            observationOrder.push(name)
            ctx.report({ message: `${name}:diagnostic:1` })
            ctx.report({ message: `${name}:diagnostic:2` })
            ctx.metering.recordUsage({ inputTokens: index + 1, modelId: `${name}:model:1`, providerId: 'test' })
            ctx.metering.recordUsage({ modelId: `${name}:model:2`, outputTokens: index + 1, providerId: 'test' })
            if (name === 'second')
              throw new Error('second:failure')
          },
        }),
      })]))
      const run = runAlint({
        config: createConfig(rules, {
          'company/first': 'warn',
          'company/second': 'warn',
        }, {}, { language: 'plaintext' }),
        files: [filePath],
        runner: { cache: false, ruleConcurrency },
        setupConfig: createSetupConfig(),
      })

      if (completionOrder) {
        await startedPromise
        for (const index of completionOrder) {
          releases[index]!.release()
          await Promise.resolve()
        }
      }
      let runError: unknown
      try {
        await run
      }
      catch (error) {
        runError = error
      }
      expect(runError).toBeInstanceOf(AlintRunError)
      const error = runError as AlintRunError
      return {
        failures: error.failures,
        observationOrder,
        projected: error.result,
      }
    }

    const sequential = await runWithConcurrency(1)
    const reverse = await runWithConcurrency(8, [1, 0])

    expect(sequential.observationOrder).toEqual(['first', 'second'])
    expect(reverse.observationOrder).toEqual(['second', 'first'])
    expect(reverse.projected).toEqual(sequential.projected)
    expect(reverse.failures).toEqual(sequential.failures)
    expect(sequential.failures).toMatchObject([{ kind: 'handler', message: 'second:failure' }])
    expect(sequential.projected.diagnostics.map(diagnostic => diagnostic.message)).toEqual([
      'first:diagnostic:1',
      'first:diagnostic:2',
      'second:diagnostic:1',
      'second:diagnostic:2',
    ])
    expect(sequential.projected.usage.records.map(record => record.modelId)).toEqual([
      'first:model:1',
      'first:model:2',
      'second:model:1',
      'second:model:2',
    ])
  })

  it('drains later jobs and orders aggregate failures by planned job index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-failure-drain-'))
    const filePath = join(root, 'demo.txt')
    const visited: string[] = []
    const thrownFailures: Error[] = []
    await writeFile(filePath, 'hello\n')
    const names = Array.from({ length: 8 }, (_, index) => `job-${index}`)
    const rules = Object.fromEntries(names.map((name, index) => [name, defineRule({
      create: () => ({
        onTargetFile: () => {
          visited.push(name)
          if (index === 1 || index === 4) {
            const error = new Error(`${name}:failure`)
            thrownFailures.push(error)
            throw error
          }
        },
      }),
    })]))
    const enabledRules = Object.fromEntries(names.map(name => [`company/${name}`, 'warn' as const]))

    let runError: unknown
    try {
      await runAlint({
        config: createConfig(
          rules,
          enabledRules,
          {},
          { language: 'plaintext' },
        ),
        files: [filePath],
        runner: { ruleConcurrency: 3 },
        setupConfig: createSetupConfig(),
      })
    }
    catch (error) {
      runError = error
    }

    expect(runError).toBeInstanceOf(AlintRunError)
    expect((runError as AlintRunError).failures.map(failure => failure.message)).toEqual([
      'job-1:failure',
      'job-4:failure',
    ])
    expect((runError as AlintRunError).result.execution).toMatchObject({ completed: 6, failed: 2, planned: 8, queued: 0, running: 0 })
    expect((runError as AlintRunError).cause).toBeInstanceOf(AggregateError)
    expect(((runError as AlintRunError).cause as AggregateError).errors.map(error => error.message)).toEqual([
      'job-1:failure',
      'job-4:failure',
    ])
    expect(((runError as AlintRunError).cause as AggregateError).errors[0]).not.toBe(thrownFailures[0])
    expect(((runError as AlintRunError).cause as AggregateError).errors[1]).not.toBe(thrownFailures[1])
    expect(visited).toEqual(names)
  })

  it('isolates failures from mutating job progress reporters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-progress-job-snapshot-'))
    const filePath = join(root, 'demo.txt')
    const callbackJobs: ProgressJobRef[] = []
    let originalTargetIdentity = ''
    await writeFile(filePath, 'hello\n')
    const rule = defineRule({
      create: () => ({
        onTargetFile: () => {
          throw new Error('original rule failure')
        },
      }),
    })

    let runError: unknown
    try {
      await runAlint({
        config: createConfig({ review: rule }, { 'company/review': 'warn' }, {}, { language: 'plaintext' }),
        files: [filePath],
        progress: {
          onJobEnd: ({ failure, job }) => {
            callbackJobs.push(job)
            job.id = 'mutated end id'
            job.target.name = 'mutated end target'
            if (failure) {
              failure.message = 'mutated end failure'
              failure.job.inputPath = 'mutated failure path'
              Object.assign(failure, { backlink: 'attached failure sentinel' })
            }
          },
          onJobQueued: ({ job }) => {
            callbackJobs.push(job)
            originalTargetIdentity = job.target.identity
            job.id = 'mutated queued id'
            job.target.name = 'mutated queued target'
          },
          onJobStart: ({ job }) => {
            callbackJobs.push(job)
            job.inputPath = 'mutated start path'
            job.target.identity = 'mutated start target'
          },
        },
        runner: { cache: false },
        setupConfig: createSetupConfig(),
      })
    }
    catch (error) {
      runError = error
    }

    expect(runError).toBeInstanceOf(AlintRunError)
    const failure = (runError as AlintRunError).failures[0]!
    expect(failure.message).toBe('original rule failure')
    expect('job' in failure).toBe(true)
    if (!('job' in failure))
      throw new Error('Expected a rule failure.')
    expect(failure.job.id).not.toContain('mutated')
    expect(failure.job.inputPath).toBe(filePath)
    expect(failure.job.target).toEqual({ identity: originalTargetIdentity, kind: 'file', name: undefined })
    expect(callbackJobs).toHaveLength(3)
    expect(callbackJobs[0]).not.toBe(callbackJobs[1])
    expect(callbackJobs[1]).not.toBe(callbackJobs[2])
    expect(callbackJobs[2]).not.toBe(failure.job)
    expect(JSON.stringify(runError)).not.toContain('attached failure sentinel')
  })

  it('cancels queued jobs without starting them and emits terminal progress', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-mid-run-cancel-'))
    const filePath = join(root, 'demo.ts')
    const controller = new AbortController()
    const starts: number[] = []
    const ends: number[] = []
    await writeFile(filePath, 'export class Demo {}\nexport function demo() {}\n')
    const rule = defineRule({
      create: () => ({ onTargetWith: () => {} }),
      languages: 'any',
    })

    let runError: unknown
    try {
      await runAlint({
        config: createConfig({ cancel: rule }, { 'company/cancel': 'warn' }),
        files: [filePath],
        progress: {
          onJobEnd: payload => ends.push(payload.job.index),
          onJobStart: (payload) => {
            starts.push(payload.job.index)
            controller.abort('stop')
          },
        },
        runner: { ruleConcurrency: 1 },
        setupConfig: createSetupConfig(),
        signal: controller.signal,
      })
    }
    catch (error) {
      runError = error
    }

    expect(runError).toBeInstanceOf(AlintRunCancelledError)
    expect((runError as AlintRunCancelledError).cause).toBe('stop')
    expect((runError as AlintRunCancelledError).result.execution).toMatchObject({ cancelled: 3, queued: 0, running: 0 })
    expect(starts).toEqual([1])
    expect(ends).toEqual([2, 3, 1])
  })

  it('aborts the running handler signal and never starts queued jobs after run cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-handler-cancel-'))
    const filePath = join(root, 'demo.ts')
    const controller = new AbortController()
    const observedSignals: AbortSignal[] = []
    let started = 0

    await writeFile(filePath, 'export class Demo {}\nexport function demo() {}\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetWith: async () => {
          started += 1
          const signal = ctx.signal

          if (!signal)
            throw new Error('missing rule signal')

          observedSignals.push(signal)
          controller.abort('stop')
          await Promise.resolve()
        },
      }),
      languages: 'any',
    })

    let runError: unknown
    try {
      await runAlint({
        config: createConfig({ cancel: rule }, { 'company/cancel': 'warn' }),
        files: [filePath],
        runner: { cache: false, ruleConcurrency: 1 },
        setupConfig: createSetupConfig(),
        signal: controller.signal,
      })
    }
    catch (error) {
      runError = error
    }

    expect(runError).toBeInstanceOf(AlintRunCancelledError)
    expect((runError as AlintRunCancelledError).result.execution).toMatchObject({ cancelled: 3, queued: 0, running: 0 })
    expect(started).toBe(1)
    expect(observedSignals).toHaveLength(1)
    expect(observedSignals[0]?.aborted).toBe(true)
  })

  it('cancels every job without invoking handlers when pre-aborted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-pre-aborted-'))
    const filePath = join(root, 'demo.txt')
    const controller = new AbortController()
    const events: string[] = []
    await writeFile(filePath, 'hello\n')
    controller.abort(undefined)
    const reason = controller.signal.reason
    const rule = defineRule({
      create: () => ({
        onTargetFile: () => {
          events.push('handler')
        },
      }),
    })

    let runError: unknown
    try {
      await runAlint({
        config: createConfig({ cancel: rule }, { 'company/cancel': 'warn' }, {}, { language: 'plaintext' }),
        files: [filePath],
        setupConfig: createSetupConfig(),
        signal: controller.signal,
      })
    }
    catch (error) {
      runError = error
    }

    expect(runError).toBeInstanceOf(AlintRunCancelledError)
    expect((runError as AlintRunCancelledError).cause).toBe(reason)
    expect((runError as AlintRunCancelledError).result.execution).toMatchObject({ cancelled: 0, planned: 0, queued: 0, running: 0 })
    expect(events).toEqual([])
  })

  it('keeps execution state isolated between concurrent files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-concurrent-state-'))
    const firstFilePath = join(root, 'a.txt')
    const secondFilePath = join(root, 'b.txt')
    let resolveFirstModelReady!: () => void
    let resolveSecondReported!: () => void
    const firstModelReady = new Promise<void>((resolve) => {
      resolveFirstModelReady = resolve
    })
    const secondReported = new Promise<void>((resolve) => {
      resolveSecondReported = resolve
    })

    await writeFile(firstFilePath, 'first\n')
    await writeFile(secondFilePath, 'second\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFile: async (target) => {
          if (target.file.path === firstFilePath) {
            const model = await ctx.model('default')
            resolveFirstModelReady()
            await secondReported
            ctx.report({
              message: `first ${model.id}`,
            })
            return
          }

          await firstModelReady

          const model = await ctx.model('override')

          ctx.report({
            message: `second ${model.id}`,
          })
          resolveSecondReported()
        },
      }),
      model: {
        capabilities: ['structured-output'],
      },
    })

    const result = await runAlint({
      config: createConfig(
        { isolated: rule },
        { 'company/isolated': 'warn' },
        {},
        { language: 'plaintext' },
      ),
      files: [firstFilePath, secondFilePath],
      runner: {
        ruleConcurrency: 2,
      },
      setupConfig: createSetupConfig(),
    })

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: firstFilePath,
        message: 'first local:qwen-8b',
        model: expect.objectContaining({
          resolvedId: 'local:qwen-8b',
        }),
      }),
      expect.objectContaining({
        filePath: secondFilePath,
        message: 'second local:qwen-32b',
        model: expect.objectContaining({
          resolvedId: 'local:qwen-32b',
        }),
      }),
    ]))
  })

  it('emits diagnostic progress when rules report findings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-progress-diagnostic-'))
    const filePath = join(root, 'demo.txt')
    const events: string[] = []

    await writeFile(filePath, 'hello\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFile: (target) => {
          ctx.report({
            filePath: target.file.path,
            message: 'Problem found',
          })
        },
      }),
    })

    await runAlint({
      config: createConfig(
        { diagnostic: rule },
        { 'company/diagnostic': 'warn' },
        {},
        { language: 'plaintext' },
      ),
      files: [filePath],
      progress: {
        onDiagnostic: payload => events.push(`${payload.diagnostic.message}:${payload.job.target.kind}`),
      },
      setupConfig: createSetupConfig(),
    })

    expect(events).toEqual([
      'Problem found:file',
    ])
  })

  it('emits usage progress with the current rule path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-progress-usage-'))
    const filePath = join(root, 'demo.ts')
    const usageEvents: string[] = []

    await writeFile(filePath, 'export function load() {}\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFunction: (target) => {
          ctx.metering.recordUsage({
            filePath: target.file.path,
            inputTokens: 4,
            modelId: 'local:qwen-8b',
            outputTokens: 2,
            providerId: 'ollama',
            totalTokens: 6,
          })
        },
      }),
      languages: 'any',
    })

    await runAlint({
      config: createConfig({ 'record-usage': rule }, { 'company/record-usage': 'warn' }),
      files: [filePath],
      progress: {
        onUsage: payload => usageEvents.push([
          payload.job.inputPath,
          payload.job.target.kind,
          payload.job.ruleId,
          payload.record.totalTokens,
        ].join(':')),
      },
      setupConfig: createSetupConfig(),
    })

    expect(usageEvents).toEqual([
      `${filePath}:function:company/record-usage:6`,
    ])
  })

  it('emits failed rule progress before rethrowing rule failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-progress-error-'))
    const filePath = join(root, 'demo.txt')
    const cachePath = join(root, '.alintcache')
    const events: string[] = []

    await writeFile(filePath, 'hello\n')

    const rule = defineRule({
      create: () => ({
        onTargetFile: () => {
          throw new Error('rule exploded')
        },
      }),
    })

    await expect(runAlint({
      config: createConfig(
        { explode: rule },
        { 'company/explode': 'warn' },
        {},
        { language: 'plaintext' },
      ),
      files: [filePath],
      progress: {
        onJobEnd: payload => events.push(`${payload.state}:${payload.job.ruleId}`),
        onRunEnd: payload => events.push(`run:${payload.execution.completed}/${payload.execution.failed}/${payload.execution.planned}`),
      },
      runner: { cache: { location: cachePath } },
      setupConfig: createSetupConfig(),
    })).rejects.toMatchObject({
      failures: [{ message: 'rule exploded' }],
      message: '1 rule execution failed.',
    })

    expect(events).toEqual([
      'failed:company/explode',
      'run:0/1/1',
    ])
    const cacheBody = await readCacheBody(cachePath)
    expect(Object.values(cacheBody.owners)[0]?.slots).toHaveLength(0)
    expect(Object.keys(cacheBody.entries)).toHaveLength(0)
  })

  // https://github.com/moeru-ai/alint/actions/runs/33186281219/job/98899997470?pr=87
  it('persists a completed source file before the run finishes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-file-cache-checkpoint-'))
    const firstPath = join(root, 'first.txt')
    const secondPath = join(root, 'second.txt')
    const cachePath = join(root, '.alintcache')
    let releaseSecond!: () => void
    let secondStarted!: () => void
    const secondIsRunning = new Promise<void>((resolve) => {
      secondStarted = resolve
    })
    const secondCanFinish = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    await writeFile(firstPath, 'first\n')
    await writeFile(secondPath, 'second\n')
    const rule = defineRule({
      create: () => ({
        onTargetFile: async (target) => {
          if (target.file.path === secondPath) {
            secondStarted()
            await secondCanFinish
          }
        },
      }),
    })

    const pendingRun = runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
        {},
        { language: 'plaintext' },
      ),
      cwd: root,
      files: [firstPath, secondPath],
      // ROOT CAUSE:
      //
      // Source planning admits each file after its concurrent read and extraction finish.
      // The second file can enter the scheduler before the first file.
      // With one slot, the blocked second file prevents the first file from completing.
      // Two slots let this test observe a completed file without assuming admission order.
      runner: { cache: { location: cachePath }, ruleConcurrency: 2 },
      setupConfig: createSetupConfig(),
    })

    await secondIsRunning
    try {
      const checkpoint = await waitForCacheBody(
        cachePath,
        body => Object.values(body.owners).some(owner => owner.path === 'first.txt'),
      )

      expect(Object.values(checkpoint.owners).map(owner => owner.path)).toContain('first.txt')
      expect(Object.values(checkpoint.owners).map(owner => owner.path)).not.toContain('second.txt')
    }
    finally {
      releaseSecond()
      await pendingRun
    }
  })

  it('returns a cache persistence error with the completed run result when final persistence fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-file-cache-failure-'))
    const filePath = join(root, 'demo.txt')
    const cachePath = join(root, '.alintcache')
    await writeFile(filePath, 'hello\n')
    const rule = defineRule({
      create: () => ({
        onTargetFile: async () => {
          await rm(cachePath, { force: true, recursive: true })
          await mkdir(cachePath)
        },
      }),
    })

    await expect(runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
        {},
        { language: 'plaintext' },
      ),
      cwd: root,
      files: [filePath],
      runner: { cache: { location: cachePath } },
      setupConfig: createSetupConfig(),
    })).rejects.toMatchObject({
      name: 'AlintCachePersistenceError',
      result: { execution: { completed: 1 } },
    })
  })

  it('detaches the final reporter payload from a successful cached result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-run-end-snapshot-'))
    const filePath = join(root, 'demo.txt')
    await writeFile(filePath, 'hello\n')
    const rule = defineRule({
      create: ctx => ({
        onTargetFile: () => {
          ctx.report({ message: 'original diagnostic' })
          ctx.metering.recordUsage({ inputTokens: 3, modelId: 'model', providerId: 'provider', totalTokens: 3 })
        },
      }),
    })
    const options = {
      config: createConfig({ review: rule }, { 'company/review': 'warn' as const }, {}, { language: 'plaintext' }),
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
    }
    await runAlint(options)

    const result = await runAlint({
      ...options,
      progress: {
        onRunEnd: (payload) => {
          payload.diagnostics[0]!.message = 'mutated diagnostic'
          payload.diagnostics.push({ filePath, message: 'added', ruleId: 'company/review', severity: 'warn' })
          payload.execution.cached = 999
          payload.progress.execution.cached = 999
          payload.usage.totalTokens = 999
          if (payload.usage.cached) {
            payload.usage.cached.totalTokens = 999
            payload.usage.cached.records[0]!.inputTokens = 999
            payload.usage.cached.records.push({ modelId: 'added', providerId: 'added', ruleId: 'company/review' })
          }
        },
      },
    })

    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]?.message).toBe('original diagnostic')
    expect(result.execution.cached).toBe(1)
    expect(result.usage.totalTokens).toBe(0)
    expect(result.usage.cached?.totalTokens).toBe(3)
    expect(result.usage.cached?.records).toHaveLength(1)
    expect(result.usage.cached?.records[0]?.inputTokens).toBe(3)
  })

  it('detaches the final reporter payload from an AlintRunError result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-run-end-error-snapshot-'))
    const filePath = join(root, 'demo.txt')
    await writeFile(filePath, 'hello\n')
    const rule = defineRule({
      create: ctx => ({
        onTargetFile: () => {
          ctx.report({ message: 'before failure' })
          throw new Error('rule failed')
        },
      }),
    })

    let runError: unknown
    try {
      await runAlint({
        config: createConfig({ review: rule }, { 'company/review': 'warn' }, {}, { language: 'plaintext' }),
        cwd: root,
        files: [filePath],
        progress: {
          onRunEnd: (payload) => {
            payload.diagnostics[0]!.message = 'mutated diagnostic'
            payload.execution.failed = 999
            payload.usage.records.push({ modelId: 'added', providerId: 'added', ruleId: 'company/review' })
          },
        },
        setupConfig: createSetupConfig(),
      })
    }
    catch (error) {
      runError = error
    }

    expect(runError).toBeInstanceOf(AlintRunError)
    expect((runError as AlintRunError).result.diagnostics[0]?.message).toBe('before failure')
    expect((runError as AlintRunError).result.execution.failed).toBe(1)
    expect((runError as AlintRunError).result.usage.records).toEqual([])
  })

  it.each(['diagnostic', 'usage'] as const)('propagates a %s reporter exception raised during a handler', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'alint-live-diagnostic-progress-'))
    const filePath = join(root, 'demo.txt')
    const sentinel = new Error('live diagnostic reporter failed')
    await writeFile(filePath, 'hello\n')
    const rule = defineRule({
      create: ctx => ({
        onTargetFile: () => kind === 'diagnostic'
          ? ctx.report({ message: 'finding' })
          : ctx.metering.recordUsage({ modelId: 'test', providerId: 'test' }),
      }),
    })

    let runError: unknown
    try {
      await runAlint({
        config: createConfig({ live: rule }, { 'company/live': 'warn' }, {}, { language: 'plaintext' }),
        files: [filePath],
        progress: {
          onDiagnostic: kind === 'diagnostic' ? () => { throw sentinel } : undefined,
          onUsage: kind === 'usage' ? () => { throw sentinel } : undefined,
        },
        setupConfig: createSetupConfig(),
      })
    }
    catch (error) {
      runError = error
    }

    expect(runError).toBe(sentinel)
  })

  it('propagates a reporter exception caught by the handler', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-caught-diagnostic-progress-'))
    const filePath = join(root, 'demo.txt')
    const firstSentinel = new Error('first caught diagnostic reporter failed')
    const secondSentinel = new Error('second caught diagnostic reporter failed')
    const sentinels = [firstSentinel, secondSentinel]
    let callbackIndex = 0
    await writeFile(filePath, 'hello\n')
    const rule = defineRule({
      create: ctx => ({
        onTargetFile: () => {
          for (const message of ['first finding', 'second finding']) {
            try {
              ctx.report({ message })
            }
            catch {
              // A rule cannot suppress an infrastructure failure from the reporter.
            }
          }
        },
      }),
    })

    let runError: unknown
    try {
      await runAlint({
        config: createConfig({ live: rule }, { 'company/live': 'warn' }, {}, { language: 'plaintext' }),
        files: [filePath],
        progress: { onDiagnostic: () => { throw sentinels[callbackIndex++] } },
        setupConfig: createSetupConfig(),
      })
    }
    catch (error) {
      runError = error
    }

    expect(runError).toBe(firstSentinel)
  })

  describe('cacheOnly', () => {
    const reportingRule = () => defineRule({
      create: ctx => ({
        onTargetFunction: (target) => {
          ctx.report({ message: `checked ${target.name}` })
          ctx.metering.recordUsage({
            filePath: target.file.path,
            inputTokens: 7,
            modelId: 'local:qwen-8b',
            outputTokens: 3,
            providerId: 'ollama',
            totalTokens: 10,
          })
        },
      }),
      languages: 'any',
    })

    it('leaves legacy cache bytes unchanged even without input files', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-only-legacy-'))
      const cachePath = join(root, '.alintcache')
      const original = '{"legacy":true}\n'
      await writeFile(cachePath, original)

      await runAlint({
        cacheOnly: true,
        cwd: root,
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      expect(await readFile(cachePath, 'utf8')).toBe(original)
    })

    it('skips rules that miss cache instead of executing them', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-only-miss-'))
      const filePath = join(root, 'demo.ts')
      const ruleEndEvents: string[] = []
      let handlerCalls = 0

      await writeFile(filePath, 'export function load() {}\n')

      const rule = defineRule({
        create: ctx => ({
          onTargetFunction: (target) => {
            handlerCalls += 1
            ctx.report({ message: `checked ${target.name}` })
          },
        }),
        languages: 'any',
      })

      const result = await runAlint({
        cacheOnly: true,
        config: createConfig({ review: rule }, { 'company/review': 'warn' }),
        cwd: root,
        files: [filePath],
        progress: {
          onJobEnd: payload => ruleEndEvents.push(`${payload.cache}:${payload.state}`),
        },
        setupConfig: createSetupConfig(),
      })

      expect(handlerCalls).toBe(0)
      expect(result.diagnostics).toEqual([])
      expect(result.execution).toEqual({
        cached: 0,
        cancelled: 0,
        completed: 0,
        failed: 0,
        planned: 1,
        queued: 0,
        running: 0,
        skipped: 1,
      })
      expect(ruleEndEvents).toEqual(['miss:skipped'])
    })

    it('replays cached diagnostics and usage without running the rule again', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-only-hit-'))
      const filePath = join(root, 'demo.ts')
      const cachePath = join(root, '.alintcache')
      const ruleEndEvents: string[] = []
      let handlerCalls = 0

      await writeFile(filePath, 'export function load() {}\n')

      const rule = defineRule({
        create: ctx => ({
          onTargetFunction: (target) => {
            handlerCalls += 1
            ctx.report({ message: `checked ${target.name}` })
            ctx.metering.recordUsage({
              filePath: target.file.path,
              inputTokens: 7,
              modelId: 'local:qwen-8b',
              outputTokens: 3,
              providerId: 'ollama',
              totalTokens: 10,
            })
          },
        }),
        languages: 'any',
      })
      const config = createConfig({ review: rule }, { 'company/review': 'warn' })

      await runAlint({
        config,
        cwd: root,
        files: [filePath],
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      const result = await runAlint({
        cacheOnly: true,
        config,
        cwd: root,
        files: [filePath],
        progress: {
          onJobEnd: payload => ruleEndEvents.push(`${payload.cache}:${payload.state}`),
        },
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      expect(handlerCalls).toBe(1)
      expect(result.diagnostics).toMatchObject([
        {
          cached: true,
          filePath,
          message: 'checked load',
          ruleId: 'company/review',
        },
      ])
      expect(result.usage.cached?.totalTokens).toBe(10)
      expect(result.usage.totalTokens).toBe(0)
      expect(result.execution).toEqual({
        cached: 1,
        cancelled: 0,
        completed: 0,
        failed: 0,
        planned: 1,
        queued: 0,
        running: 0,
        skipped: 0,
      })
      expect(ruleEndEvents).toEqual(['hit:cached'])
    })

    it('reports cached findings while counting the rules that still need a paid run', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-only-mixed-'))
      const filePath = join(root, 'demo.ts')
      const cachePath = join(root, '.alintcache')
      const ruleEndEvents: string[] = []
      const calls = { first: 0, second: 0 }

      await writeFile(filePath, 'export function load() {}\n')

      const firstRule = defineRule({
        create: ctx => ({
          onTargetFunction: (target) => {
            calls.first += 1
            ctx.report({ message: `first checked ${target.name}` })
          },
        }),
        languages: 'any',
      })
      const secondRule = defineRule({
        create: ctx => ({
          onTargetFunction: (target) => {
            calls.second += 1
            ctx.report({ message: `second checked ${target.name}` })
          },
        }),
        languages: 'any',
      })
      const rules = { first: firstRule, second: secondRule }

      await runAlint({
        config: createConfig(rules, { 'company/first': 'warn' }),
        cwd: root,
        files: [filePath],
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      const result = await runAlint({
        cacheOnly: true,
        config: createConfig(rules, { 'company/first': 'warn', 'company/second': 'warn' }),
        cwd: root,
        files: [filePath],
        progress: {
          onJobEnd: payload => ruleEndEvents.push(`${payload.job.ruleId}:${payload.cache}:${payload.state}`),
        },
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      expect(calls).toEqual({ first: 1, second: 0 })
      expect(result.diagnostics).toMatchObject([
        { message: 'first checked load', ruleId: 'company/first' },
      ])
      expect(result.execution).toEqual({
        cached: 1,
        cancelled: 0,
        completed: 0,
        failed: 0,
        planned: 2,
        queued: 0,
        running: 0,
        skipped: 1,
      })
      expect(ruleEndEvents).toEqual([
        'company/first:hit:cached',
        'company/second:miss:skipped',
      ])
    })

    it('skips rules that opt out of caching, since they can never be served from cache', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-only-opt-out-'))
      const filePath = join(root, 'demo.ts')
      const ruleEndEvents: string[] = []
      let handlerCalls = 0

      await writeFile(filePath, 'export function load() {}\n')

      const rule = defineRule({
        cache: false,
        create: () => ({
          onTargetFunction: () => {
            handlerCalls += 1
          },
        }),
        languages: 'any',
      })

      const result = await runAlint({
        cacheOnly: true,
        config: createConfig({ uncached: rule }, { 'company/uncached': 'warn' }),
        cwd: root,
        files: [filePath],
        progress: {
          onJobEnd: payload => ruleEndEvents.push(`${payload.cache}:${payload.state}`),
        },
        setupConfig: createSetupConfig(),
      })

      expect(handlerCalls).toBe(0)
      expect(result.execution).toMatchObject({ skipped: 1 })
      expect(ruleEndEvents).toEqual(['miss:skipped'])
    })

    it('leaves an existing cache file untouched even when the source changed under it', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-only-no-write-'))
      const filePath = join(root, 'demo.ts')
      const cachePath = join(root, '.alintcache')
      const config = createConfig({ review: reportingRule() }, { 'company/review': 'warn' })

      await writeFile(filePath, 'export function load() {}\n')
      await runAlint({
        config,
        cwd: root,
        files: [filePath],
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      const warmed = await readFile(cachePath, 'utf8')

      // Editing the source makes the target miss, so a reconciling run would rewrite both the
      // file's content hash and its entry list. A cacheOnly run must not touch either.
      await writeFile(filePath, 'export function load() {\n  return 1\n}\n')

      const result = await runAlint({
        cacheOnly: true,
        config,
        cwd: root,
        files: [filePath],
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      expect(result.execution).toMatchObject({ cached: 0, skipped: 1 })
      expect(await readFile(cachePath, 'utf8')).toBe(warmed)
    })

    it('does not create a cache file when none exists yet', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-only-no-create-'))
      const filePath = join(root, 'demo.ts')

      await writeFile(filePath, 'export function load() {}\n')

      await runAlint({
        cacheOnly: true,
        config: createConfig({ review: reportingRule() }, { 'company/review': 'warn' }),
        cwd: root,
        files: [filePath],
        setupConfig: createSetupConfig(),
      })

      await expect(access(join(root, '.alintcache'))).rejects.toThrow()
    })
  })

  describe('signal', () => {
    it('stops starting rules once the run is aborted', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-abort-stops-'))
      const filePath = join(root, 'demo.ts')
      const controller = new AbortController()
      const visited: string[] = []

      await writeFile(filePath, [
        'export function first() {}',
        'export function second() {}',
        'export function third() {}',
      ].join('\n'))

      // Abort from inside the first rule, standing in for a user cancelling mid-run.
      const rule = defineRule({
        create: () => ({
          onTargetFunction: (target) => {
            visited.push(target.name ?? 'anonymous')
            controller.abort()
          },
        }),
        languages: 'any',
      })

      let runError: unknown

      try {
        await runAlint({
          config: createConfig({ review: rule }, { 'company/review': 'warn' }),
          cwd: root,
          files: [filePath],
          setupConfig: createSetupConfig(),
          signal: controller.signal,
        })
      }
      catch (error) {
        runError = error
      }

      expect(runError).toBeInstanceOf(AlintAbortError)
      expect(visited).toEqual(['first'])
    })

    it('retains completed work when a later job is externally aborted', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-abort-retains-completed-'))
      const filePath = join(root, 'demo.ts')
      const cachePath = join(root, '.alintcache')
      const controller = new AbortController()
      const calls = { first: 0, second: 0 }
      await writeFile(filePath, [
        'export function first() {}',
        'export function second() {}',
      ].join('\n'))
      const rule = defineRule({
        create: () => ({
          onTargetFunction: (target) => {
            if (target.name === 'first')
              calls.first += 1
            if (target.name === 'second')
              calls.second += 1
          },
        }),
        languages: 'any',
      })
      const config = createConfig({ review: rule }, { 'company/review': 'warn' })

      await expect(runAlint({
        config,
        cwd: root,
        files: [filePath],
        progress: {
          onJobStart: ({ job }) => {
            if (job.target.name === 'second')
              controller.abort()
          },
        },
        runner: { cache: { location: cachePath }, ruleConcurrency: 1 },
        setupConfig: createSetupConfig(),
        signal: controller.signal,
      })).rejects.toBeInstanceOf(AlintAbortError)
      const abortedBody = await readCacheBody(cachePath)

      expect(calls).toEqual({ first: 1, second: 0 })
      expect(Object.values(abortedBody.owners)[0]?.slots).toHaveLength(1)
      expect(Object.keys(abortedBody.entries)).toHaveLength(1)
      expect(Object.values(abortedBody.entries)[0]?.target.name).toBe('first')

      const replayed = await runAlint({
        config,
        cwd: root,
        files: [filePath],
        runner: { cache: { location: cachePath }, ruleConcurrency: 1 },
        setupConfig: createSetupConfig(),
      })

      expect(calls).toEqual({ first: 1, second: 1 })
      expect(replayed.execution.cached).toBe(1)
      expect(replayed.execution.completed).toBe(1)
    })

    it('persists a completed job while a later job for the same file is still running', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-job-checkpoint-'))
      const filePath = join(root, 'demo.ts')
      const cachePath = join(root, '.alintcache')
      let releaseSecond!: () => void
      let signalSecondStarted!: () => void
      const secondCanFinish = new Promise<void>((resolve) => {
        releaseSecond = resolve
      })
      const secondStarted = new Promise<void>((resolve) => {
        signalSecondStarted = resolve
      })
      await writeFile(filePath, [
        'export function first() {}',
        'export function second() {}',
      ].join('\n'))
      const rule = defineRule({
        create: ctx => ({
          onTargetFunction: async (target) => {
            ctx.report({ message: `checked ${target.name}` })
            if (target.name === 'second') {
              signalSecondStarted()
              await secondCanFinish
            }
          },
        }),
        languages: 'any',
      })

      const running = runAlint({
        config: createConfig({ review: rule }, { 'company/review': 'warn' }),
        cwd: root,
        files: [filePath],
        runner: { cache: { location: cachePath }, ruleConcurrency: 1 },
        setupConfig: createSetupConfig(),
      })

      await secondStarted
      let checkpoint: Awaited<ReturnType<typeof readCacheBody>> | undefined
      try {
        checkpoint = await readCacheBody(cachePath)
      }
      finally {
        releaseSecond()
        await running
      }

      expect(Object.keys(checkpoint.entries)).toHaveLength(1)
      expect(Object.values(checkpoint.entries)[0]?.target.name).toBe('first')
    })

    it('preserves a completed repeated-input owner when a later overlapping session aborts', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-abort-repeated-input-owner-'))
      const filePath = join(root, 'demo.custom')
      const cachePath = join(root, '.alintcache')
      const controller = new AbortController()
      let handlerCalls = 0
      let extractionCalls = 0
      let releaseExtractions!: () => void
      const extractionsReady = new Promise<void>((resolve) => {
        releaseExtractions = resolve
      })
      await writeFile(filePath, 'hello')
      const rule = defineRule({
        create: ctx => ({
          onTargetFile: async () => {
            handlerCalls += 1
            if (handlerCalls === 2) {
              await new Promise<void>((resolve) => {
                ctx.signal?.addEventListener('abort', () => resolve(), { once: true })
              })
              return
            }
            ctx.report({ message: 'completed' })
          },
        }),
      })
      const plugin = definePlugin({
        languages: {
          custom: {
            extensions: ['.custom'],
            extract: async (file) => {
              extractionCalls += 1
              if (extractionCalls === 2)
                releaseExtractions()
              await extractionsReady
              return [{ file, identity: 'file', kind: 'file', language: 'custom', text: file.text }]
            },
            name: 'custom',
          },
        },
        rules: { repeated: rule },
      })
      const config = defineConfig([
        { plugins: { company: plugin }, rules: { 'company/repeated': 'warn' } },
        { files: ['**/*.custom'], language: 'custom' },
      ])

      await expect(runAlint({
        config,
        cwd: root,
        files: [filePath, filePath],
        progress: {
          onJobEnd: ({ job }) => {
            if (job.index === 1)
              setTimeout(() => controller.abort('stop repeated input'), 0)
          },
        },
        projectTargets: false,
        runner: { cache: { location: cachePath }, ruleConcurrency: 2 },
        setupConfig: createSetupConfig(),
        signal: controller.signal,
      })).rejects.toBeInstanceOf(AlintAbortError)

      const replayed = await runAlint({
        config,
        cwd: root,
        files: [filePath],
        projectTargets: false,
        runner: { cache: { location: cachePath }, ruleConcurrency: 1 },
        setupConfig: createSetupConfig(),
      })

      expect(handlerCalls).toBe(2)
      expect(replayed.execution.cached).toBe(1)
      expect(replayed.execution.completed).toBe(0)
      expect(replayed.diagnostics[0]?.message).toBe('completed')
    })

    it('reports an abort as cancellation rather than a rule failure', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-abort-not-errored-'))
      const filePath = join(root, 'demo.ts')
      const controller = new AbortController()
      const ruleEndEvents: string[] = []

      await writeFile(filePath, 'export function load() {}\n')

      // A rule whose model call is cancelled throws, exactly as generateStructured would.
      const rule = defineRule({
        create: ctx => ({
          onTargetFunction: () => {
            controller.abort()
            ctx.signal?.throwIfAborted()
          },
        }),
        languages: 'any',
      })

      let runError: unknown

      try {
        await runAlint({
          config: createConfig({ review: rule }, { 'company/review': 'warn' }),
          cwd: root,
          files: [filePath],
          progress: {
            onJobEnd: payload => ruleEndEvents.push(payload.state),
          },
          setupConfig: createSetupConfig(),
          signal: controller.signal,
        })
      }
      catch (error) {
        runError = error
      }

      expect(runError).toBeInstanceOf(AlintAbortError)
      expect((runError as AlintAbortError).result.execution.failed).toBe(0)
      expect(ruleEndEvents).toEqual(['cancelled'])
    })

    it('keeps diagnostics but does not cache a job cancelled by the external signal', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-abort-keeps-work-'))
      const filePath = join(root, 'demo.ts')
      const cachePath = join(root, '.alintcache')
      const controller = new AbortController()
      const handlerCalls: string[] = []

      await writeFile(filePath, [
        'export function first() {}',
        'export function second() {}',
      ].join('\n'))

      const rule = defineRule({
        create: ctx => ({
          onTargetFunction: (target) => {
            handlerCalls.push(target.name ?? 'anonymous')
            ctx.report({ message: `checked ${target.name}` })

            if (target.name === 'first') {
              controller.abort()
            }
          },
        }),
        languages: 'any',
      })
      const config = createConfig({ review: rule }, { 'company/review': 'warn' })

      let runError: unknown

      try {
        await runAlint({
          config,
          cwd: root,
          files: [filePath],
          runner: { cache: { location: cachePath } },
          setupConfig: createSetupConfig(),
          signal: controller.signal,
        })
      }
      catch (error) {
        runError = error
      }

      expect(runError).toBeInstanceOf(AlintAbortError)
      expect((runError as AlintAbortError).result.diagnostics).toMatchObject([
        { message: 'checked first' },
      ])

      const replayed = await runAlint({
        config,
        cwd: root,
        files: [filePath],
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      expect(handlerCalls).toEqual(['first', 'first', 'second'])
      expect(replayed.diagnostics).toMatchObject([
        { message: 'checked first' },
        { message: 'checked second' },
      ])
    })

    it('does not reach a rule when the signal is already aborted', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-abort-upfront-'))
      const filePath = join(root, 'demo.ts')
      const controller = new AbortController()
      let handlerCalls = 0

      await writeFile(filePath, 'export function load() {}\n')
      controller.abort()

      const rule = defineRule({
        create: () => ({
          onTargetFunction: () => {
            handlerCalls += 1
          },
        }),
        languages: 'any',
      })

      await expect(runAlint({
        config: createConfig({ review: rule }, { 'company/review': 'warn' }),
        cwd: root,
        files: [filePath],
        setupConfig: createSetupConfig(),
        signal: controller.signal,
      })).rejects.toBeInstanceOf(AlintAbortError)

      expect(handlerCalls).toBe(0)
    })

    it('exposes the signal on rule context so rules can forward it', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-abort-ctx-'))
      const filePath = join(root, 'demo.ts')
      const controller = new AbortController()
      const seen: (AbortSignal | undefined)[] = []

      await writeFile(filePath, 'export function load() {}\n')

      const rule = defineRule({
        create: ctx => ({
          onTargetFunction: () => {
            seen.push(ctx.signal)
          },
        }),
        languages: 'any',
      })

      await runAlint({
        config: createConfig({ review: rule }, { 'company/review': 'warn' }),
        cwd: root,
        files: [filePath],
        setupConfig: createSetupConfig(),
        signal: controller.signal,
      })

      expect(seen).toHaveLength(1)
      expect(seen[0]?.aborted).toBe(false)
    })
  })

  describe('projectTargets', () => {
    it('does not create project-only rule handlers when project targets are disabled', async () => {
      const create = vi.fn(() => ({ onTargetProject: () => {} }))
      const rule = defineRule({ create })

      await runAlint({
        config: createConfig({ review: rule }, { 'company/review': 'warn' }),
        projectTargets: false,
        setupConfig: createSetupConfig(),
      })

      expect(create).not.toHaveBeenCalled()
    })

    it('skips the project pass when projectTargets is false', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-project-targets-off-'))
      const filePath = join(root, 'demo.ts')
      let projectCalls = 0
      let fileCalls = 0

      await writeFile(filePath, 'export function load() {}\n')

      const rule = defineRule({
        create: () => ({
          onTargetFile: () => {
            fileCalls += 1
          },
          onTargetProject: () => {
            projectCalls += 1
          },
        }),
      })

      const result = await runAlint({
        config: createConfig({ review: rule }, { 'company/review': 'warn' }),
        cwd: root,
        files: [filePath],
        projectTargets: false,
        setupConfig: createSetupConfig(),
      })

      expect(projectCalls).toBe(0)
      // File-scoped work still runs; only the project pass is dropped.
      expect(fileCalls).toBe(1)
      // The skipped project execution must not inflate the planned count either.
      expect(result.execution).toMatchObject({ completed: 1, planned: 1 })
    })

    it('runs the project pass by default', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-project-targets-default-'))
      const filePath = join(root, 'demo.ts')
      let projectCalls = 0

      await writeFile(filePath, 'export function load() {}\n')

      const rule = defineRule({
        create: () => ({
          onTargetProject: () => {
            projectCalls += 1
          },
        }),
      })

      await runAlint({
        config: createConfig({ review: rule }, { 'company/review': 'warn' }),
        cwd: root,
        files: [filePath],
        setupConfig: createSetupConfig(),
      })

      expect(projectCalls).toBe(1)
    })

    it('drops only the project kind for an onTargetWith rule', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-project-targets-with-'))
      const filePath = join(root, 'demo.txt')
      const directoryPath = join(root, 'components')
      const visited: string[] = []

      await writeFile(filePath, 'demo\n')

      const rule = defineRule({
        cache: false,
        create: () => ({
          onTargetWith: (target) => {
            visited.push(target.kind)
          },
        }),
      })

      await runAlint({
        config: createConfig(
          { review: rule },
          { 'company/review': 'warn' },
          {},
          { language: 'plaintext' },
        ),
        cwd: root,
        directories: [directoryPath],
        files: [filePath],
        projectTargets: false,
        setupConfig: createSetupConfig(),
      })

      // Without projectTargets: false this is ['file', 'directory', 'project'].
      expect(visited).toEqual(['file', 'directory'])
    })

    it('does not report project rules as skipped in a partial cacheOnly run', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-project-targets-cache-only-'))
      const filePath = join(root, 'demo.ts')
      const jobEndEvents: string[] = []

      await writeFile(filePath, 'export function load() {}\n')

      // A project-only rule can never be served from a per-file cache, so a passive editor
      // pass must exclude it rather than count it forever as "needs a run".
      const rule = defineRule({
        create: () => ({
          onTargetProject: () => {},
        }),
      })

      const result = await runAlint({
        cacheOnly: true,
        config: createConfig({ review: rule }, { 'company/review': 'warn' }),
        cwd: root,
        files: [filePath],
        progress: {
          onJobEnd: payload => jobEndEvents.push(`${payload.job.target.kind}:${payload.state}`),
        },
        projectTargets: false,
        setupConfig: createSetupConfig(),
      })

      expect(jobEndEvents).toEqual([])
      expect(result.execution).toMatchObject({ planned: 0, skipped: 0 })
    })
  })
})

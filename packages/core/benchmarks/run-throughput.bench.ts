import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, bench } from 'vitest'

import { defineConfig, definePlugin, defineRule, runAlint } from '../src/index'
import { createManyFiles } from './data'

const setupConfig = { providers: [], version: 1 } as const
const smallFixtures = createManyFiles(1_000, 1)
const semanticFixtures = Array.from({ length: 120 }, (_, fileIndex) => ({
  path: `semantic/file-${fileIndex}.mock`,
  text: Array.from({ length: 80 }, (_, targetIndex) => `/* TARGET ${targetIndex} */\nvalue-${fileIndex}-${targetIndex}\n`).join(''),
}))
const fileRule = defineRule({
  create: () => ({
    onTargetFile: () => {},
  }),
})
const functionRule = defineRule({
  cache: true,
  create: () => ({
    onTargetFunction: () => {},
  }),
})
let projectCalls = 0
const projectRule = defineRule({
  create: () => ({
    onTargetProject: () => { projectCalls += 1 },
  }),
})
const plugin = definePlugin({
  languages: {
    mock: {
      extensions: ['.mock'],
      extract: (file) => {
        const targets = []
        const pattern = /\/\* TARGET (\d+) \*\/\n([\s\S]*?)(?=\/\* TARGET |$)/g
        for (const match of file.text.matchAll(pattern)) {
          const index = Number(match[1])
          const text = match[2] ?? ''
          const start = (match.index ?? 0) + match[0].length - text.length
          targets.push({
            file,
            identity: `function:${index}`,
            kind: 'function' as const,
            language: 'benchmark/mock',
            range: { end: start + text.length, start },
            text,
          })
        }
        return targets
      },
      name: 'benchmark/mock',
    },
  },
  rules: {
    file: fileRule,
    first: functionRule,
    fourth: functionRule,
    project: projectRule,
    second: functionRule,
    third: functionRule,
  },
})
const baseConfig = {
  plugins: { benchmark: plugin },
}
const fileConfig = defineConfig([
  {
    ...baseConfig,
    rules: { 'benchmark/file': 'warn' },
  },
  {
    files: ['**/*.ts'],
    language: 'plaintext',
  },
])
const oneFunctionConfig = defineConfig([
  {
    ...baseConfig,
    rules: { 'benchmark/first': 'warn' },
  },
  {
    files: ['**/*.mock'],
    language: 'benchmark/mock',
  },
])
const fourFunctionConfig = defineConfig([
  {
    ...baseConfig,
    rules: {
      'benchmark/first': 'warn',
      'benchmark/fourth': 'warn',
      'benchmark/second': 'warn',
      'benchmark/third': 'warn',
    },
  },
  {
    files: ['**/*.mock'],
    language: 'benchmark/mock',
  },
])
const projectConfig = defineConfig([
  {
    ...baseConfig,
    rules: { 'benchmark/project': 'warn' },
  },
  {
    files: ['**/*.mock'],
    language: 'benchmark/mock',
  },
])

let root: string
let smallFiles: string[]
let semanticFiles: string[]

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'alint-run-throughput-'))
  await mkdir(join(root, 'src'))
  await mkdir(join(root, 'semantic'))
  await Promise.all([
    ...smallFixtures,
    ...semanticFixtures,
  ].map(fixture =>
    writeFile(join(root, fixture.path), fixture.text),
  ))
  smallFiles = smallFixtures.map(fixture => join(root, fixture.path))
  semanticFiles = semanticFixtures.map(fixture => join(root, fixture.path))

  // Smoke every matrix cell outside the timing boundary so a fast empty run cannot become a trend.
  assertExecution('small smoke', (await runAlint({
    config: fileConfig,
    cwd: root,
    files: smallFiles,
    projectTargets: false,
    runner: { cache: false },
    setupConfig,
  })).execution, { completed: 1_000, planned: 1_000 })
  assertExecution('semantic smoke', (await runAlint({
    config: oneFunctionConfig,
    cwd: root,
    files: semanticFiles,
    projectTargets: false,
    runner: { cache: false },
    setupConfig,
  })).execution, { completed: 9_600, planned: 9_600 })
  assertExecution('four-rule smoke', (await runAlint({
    config: fourFunctionConfig,
    cwd: root,
    files: semanticFiles,
    projectTargets: false,
    runner: { cache: false },
    setupConfig,
  })).execution, { completed: 38_400, planned: 38_400 })
  const projectCallsBeforeSmoke = projectCalls
  assertExecution('project smoke', (await runAlint({
    config: projectConfig,
    cwd: root,
    files: semanticFiles,
    runner: { cache: false },
    setupConfig,
  })).execution, { completed: 1, planned: 1 })
  assertProjectCalls(projectCallsBeforeSmoke)

  // Populate and then verify the cache outside the timed boundary so every measured job is a hit.
  assertExecution('cache population', (await runAlint({
    config: oneFunctionConfig,
    cwd: root,
    files: semanticFiles,
    projectTargets: false,
    setupConfig,
  })).execution, { completed: 9_600, planned: 9_600 })
  assertExecution('warm-cache smoke', (await runAlint({
    config: oneFunctionConfig,
    cwd: root,
    files: semanticFiles,
    projectTargets: false,
    setupConfig,
  })).execution, { cached: 9_600, planned: 9_600 })
})

afterAll(async () => {
  await rm(root, { force: true, recursive: true })
})

bench('runs 1,000 small files with one file rule', async () => {
  const result = await runAlint({
    config: fileConfig,
    cwd: root,
    files: smallFiles,
    projectTargets: false,
    runner: { cache: false },
    setupConfig,
  })
  assertExecution('small benchmark', result.execution, { completed: 1_000, planned: 1_000 })
})

bench('runs 120 files with 80 semantic targets each', async () => {
  const result = await runAlint({
    config: oneFunctionConfig,
    cwd: root,
    files: semanticFiles,
    projectTargets: false,
    runner: { cache: false },
    setupConfig,
  })
  assertExecution('semantic benchmark', result.execution, { completed: 9_600, planned: 9_600 })
})

bench('runs 120 files with 80 semantic targets and four rules', async () => {
  const result = await runAlint({
    config: fourFunctionConfig,
    cwd: root,
    files: semanticFiles,
    projectTargets: false,
    runner: { cache: false },
    setupConfig,
  })
  assertExecution('four-rule benchmark', result.execution, { completed: 38_400, planned: 38_400 })
})

bench('runs one compact project rule over 9,600 targets', async () => {
  const callsBefore = projectCalls
  const result = await runAlint({
    config: projectConfig,
    cwd: root,
    files: semanticFiles,
    runner: { cache: false },
    setupConfig,
  })
  assertExecution('project benchmark', result.execution, { completed: 1, planned: 1 })
  assertProjectCalls(callsBefore)
})

bench('runs 9,600 targets from a fully warm cache', async () => {
  const result = await runAlint({
    config: oneFunctionConfig,
    cwd: root,
    files: semanticFiles,
    projectTargets: false,
    setupConfig,
  })
  assertExecution('warm-cache benchmark', result.execution, { cached: 9_600, planned: 9_600 })
})

function assertExecution(
  label: string,
  actual: {
    cached: number
    cancelled: number
    completed: number
    failed: number
    planned: number
    queued: number
    running: number
    skipped: number
  },
  expected: { cached?: number, completed?: number, planned: number },
): void {
  const exact = {
    cached: expected.cached ?? 0,
    cancelled: 0,
    completed: expected.completed ?? 0,
    failed: 0,
    planned: expected.planned,
    queued: 0,
    running: 0,
    skipped: 0,
  }
  for (const key of Object.keys(exact) as Array<keyof typeof exact>) {
    if (actual[key] !== exact[key])
      throw new Error(`${label}: expected ${key}=${exact[key]}, received ${actual[key]}.`)
  }
}

function assertProjectCalls(before: number): void {
  if (projectCalls !== before + 1)
    throw new Error(`Expected one project handler call, received ${projectCalls - before}.`)
}

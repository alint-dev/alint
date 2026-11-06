import type {
  BaseSourceFile,
  PlannedSourceTarget,
  ProgressReporter,
  ProgressSnapshot,
  ProjectFileEntry,
  ProjectTargetEntry,
  SourceFile,
  SourceMetadataValue,
} from './index'

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, expectTypeOf, it } from 'vitest'

import * as core from './index'

describe('core public entrypoints', () => {
  it('exports compact project descriptors from the root entrypoint', () => {
    expectTypeOf<keyof ProjectFileEntry>().toEqualTypeOf<'contentHash' | 'language' | 'path' | 'targetCount'>()
    expectTypeOf<keyof ProjectTargetEntry>().toEqualTypeOf<'filePath' | 'identity' | 'kind' | 'name' | 'range'>()
    const progress = {
      execution: {
        cached: 0,
        cancelled: 0,
        completed: 0,
        failed: 0,
        planned: 0,
        queued: 0,
        running: 0,
        skipped: 0,
      },
      filesPlanned: 0,
      filesTotal: 1,
      jobsCompleted: 0,
      jobsStarted: 0,
      jobsTotal: 0,
      planningComplete: false,
    } satisfies ProgressSnapshot
    const reporter = {
      onExecuteEnd: (payload) => {
        expectTypeOf(payload.progress).toEqualTypeOf<ProgressSnapshot>()
      },
      onExecuteStart: (payload) => {
        expectTypeOf(payload.progress).toEqualTypeOf<ProgressSnapshot>()
      },
      onPrepareEnd: (payload) => {
        expectTypeOf(payload.filesTotal).toEqualTypeOf<number>()
      },
      onPrepareStart: (payload) => {
        expectTypeOf(payload.startedAt).toEqualTypeOf<number | undefined>()
      },
    } satisfies ProgressReporter

    expectTypeOf(progress).toMatchTypeOf<ProgressSnapshot>()
    expectTypeOf(reporter).toMatchTypeOf<ProgressReporter>()
  })

  it('exports compact source descriptors from the root entrypoint', () => {
    expectTypeOf<keyof BaseSourceFile>().toEqualTypeOf<'contentHash' | 'language' | 'path'>()
    expectTypeOf<SourceFile>().toMatchTypeOf<BaseSourceFile>()
    expectTypeOf<keyof PlannedSourceTarget>().toEqualTypeOf<'file' | 'identity' | 'kind' | 'language' | 'loc' | 'metadata' | 'name' | 'origin' | 'range'>()
    expectTypeOf<() => void>().not.toMatchTypeOf<SourceMetadataValue>()
  })

  it('does not create runtime exports for public type contracts', () => {
    expect(core).not.toHaveProperty('ProjectFileEntry')
    expect(core).not.toHaveProperty('ProjectTargetEntry')
    expect(core).not.toHaveProperty('ProgressSnapshot')
    expect(core).not.toHaveProperty('ProgressReporter')
  })

  it('runs a project rule with compact entries and explicit source reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-public-project-rule-'))
    try {
      const filePath = join(root, 'demo.ts')
      const readPaths: string[] = []
      let projectCalls = 0
      await writeFile(filePath, 'deprecated-api()\n')

      const projectRule = core.defineRule({
        create: ctx => ({
          async onTargetProject(project) {
            projectCalls += 1
            for (const entry of project.files) {
              expect(entry).not.toHaveProperty('text')
              expect(entry).not.toHaveProperty('metadata')
              readPaths.push(entry.path)
              const file = await ctx.src.readFile(entry.path)
              if (file.text.includes('deprecated-api'))
                ctx.report({ filePath: entry.path, message: 'deprecated API used' })
            }
            expect(project.targets.length).toBeGreaterThan(0)
            for (const entry of project.targets) {
              expect(entry).not.toHaveProperty('text')
              expect(entry).not.toHaveProperty('metadata')
            }
          },
        }),
      })
      const plugin = core.definePlugin({
        rules: { project: projectRule },
      })
      const result = await core.runAlint({
        config: core.defineConfig([
          {
            plugins: { test: plugin },
            rules: { 'test/project': 'warn' },
          },
        ]),
        cwd: root,
        files: [filePath],
        runner: { cache: false },
      })

      expect(projectCalls).toBe(1)
      expect(readPaths).toEqual([filePath])
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          filePath,
          message: 'deprecated API used',
          ruleId: 'test/project',
          severity: 'warn',
        }),
      ])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('keeps JavaScript language extraction behind a dedicated export', async () => {
    const [rootEntry, packageJsonText] = await Promise.all([
      readFile(new URL('./index.ts', import.meta.url), 'utf8'),
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ])
    const packageJson = JSON.parse(packageJsonText) as {
      exports?: Record<string, unknown>
    }

    expect(rootEntry).not.toContain('extractJsSourceTargets')
    expect(packageJson.exports).toHaveProperty('./languages/js')
  })
})

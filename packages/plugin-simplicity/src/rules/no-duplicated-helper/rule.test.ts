import type { AgentAdapter, AgentRequest, AgentTool } from '@alint-js/core/agent'
import type { DiagnosticDescriptor, FileTarget, RuleContext } from '@alint-js/plugin'

import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { createFixtureContext, createFixtureIndex, fixtureHelper, FIXTURES_DIR } from '../../repo/fixtures'
import { duplicatedHelperRule, resolveDuplicatedHelperAgent } from './rule'

interface Run {
  agentRequests: AgentRequest[]
  contextFor: (settings?: Record<string, unknown>) => RuleContext
  cwd: string
  debug: string[]
  diagnostics: DiagnosticDescriptor[]
}

/**
 * One run with a scripted agent. Nothing is mocked: `act` is handed the real tools the rule built,
 * over a real index of the real fixture files.
 */
function createRun(
  act: (tools: Map<string, AgentTool>) => Promise<void> = async () => {},
  cwd: string = FIXTURES_DIR,
): Run {
  const agentRequests: AgentRequest[] = []
  const debug: string[] = []
  const diagnostics: DiagnosticDescriptor[] = []

  const agent: AgentAdapter = async (request) => {
    agentRequests.push(request)
    await act(new Map(request.tools.map(tool => [tool.name, tool])))

    return { answer: 'done' }
  }

  // One `src` for the whole run, so every file shares one repository index.
  const src = createFixtureContext().src

  return {
    agentRequests,
    contextFor: (settings = {}): RuleContext => createFixtureContext({
      agent,
      cwd,
      logger: {
        debug: (...args) => void debug.push(args.join(' ')),
      },
      report: diagnostic => void diagnostics.push(diagnostic),
      settings,
      src,
    }),
    cwd,
    debug,
    diagnostics,
  }
}

/** The fixture workspace, copied, so a run may write its cache into it. */
async function createWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'simplicity-'))

  await cp(FIXTURES_DIR, cwd, {
    filter: source => basename(source) !== '.alint',
    recursive: true,
  })

  return cwd
}

async function lint(run: Run, relativePath: string, settings?: Record<string, unknown>): Promise<void> {
  const path = resolve(run.cwd, relativePath)
  const target: FileTarget = {
    file: { contentHash: 'unused', language: 'plaintext', path },
    identity: 'file',
    kind: 'file',
    language: 'plaintext',
  }

  await duplicatedHelperRule.create(run.contextFor(settings)).onTargetFile?.(target)
}

const AST_ONLY = {
  simplicity: {
    cache: false,
    ignores: ['alint.config.ts'],
    judge: false,
  },
}

describe('no-duplicated-helper, the AST approach', () => {
  it('reports a character-for-character copy, in every language, with no agent and no tokens', async () => {
    const index = await createFixtureIndex()
    const cases = [
      { copy: 'ts/archive.ts', file: 'ts/store.ts', name: 'isNodeError' },
      { copy: 'rust/archive.rs', file: 'rust/store.rs', name: 'is_missing' },
      { copy: 'go/archive.go', file: 'go/store.go', name: 'isMissing' },
      // Python's copies carry different docstrings. A docstring is a statement, not a comment,
      // so an extractor that took it for code would put the prose in the fingerprint.
      { copy: 'python/archive.py', file: 'python/store.py', name: 'is_missing' },
    ]

    for (const { copy, file, name } of cases) {
      const run = createRun()
      await lint(run, file, AST_ONLY)

      const twin = fixtureHelper(index, copy, name)

      expect(run.agentRequests).toHaveLength(0)
      expect(run.diagnostics).toHaveLength(1)
      expect(run.diagnostics[0].message).toBe(`Helper "${name}" is also defined at ${twin.id}.`)
      expect(run.diagnostics[0].evidence).toMatchObject({ match: 'exact' })
    }
  })

  it('reports a copy that renamed only what it declares, in every language', async () => {
    const cases = [
      { file: 'ts/renamed.ts', name: 'hasErrorCode' },
      { file: 'rust/renamed.rs', name: 'is_absent' },
      { file: 'go/renamed.go', name: 'isAbsent' },
      { file: 'python/renamed.py', name: 'is_absent' },
    ]

    for (const { file, name } of cases) {
      const run = createRun()
      await lint(run, file, AST_ONLY)

      expect(run.agentRequests).toHaveLength(0)
      expect(run.diagnostics).toHaveLength(1)
      expect(run.diagnostics[0].message).toContain(`Helper "${name}" is a renamed copy of`)
      expect(run.diagnostics[0].message).toContain('only the names it declares differ')
      expect(run.diagnostics[0].evidence).toMatchObject({ match: 'renamed' })
    }
  })

  it('says nothing about two accessors that share a shape and nothing else, in every language', async () => {
    for (const file of [
      'ts/accessors.ts',
      'rust/accessors.rs',
      'go/accessors.go',
      'python/accessors.py',
    ]) {
      const run = createRun()
      await lint(run, file, AST_ONLY)

      expect(run.diagnostics).toStrictEqual([])
    }
  })

  it('reports a twin wherever it stands, so the order files are linted in cannot matter', async () => {
    const forwards = createRun()
    await lint(forwards, 'ts/store.ts', AST_ONLY)
    await lint(forwards, 'ts/archive.ts', AST_ONLY)

    const backwards = createRun()
    await lint(backwards, 'ts/archive.ts', AST_ONLY)
    await lint(backwards, 'ts/store.ts', AST_ONLY)

    expect(forwards.diagnostics).toHaveLength(2)
    expect(backwards.diagnostics).toHaveLength(2)
    expect(new Set(backwards.diagnostics.map(d => d.message)))
      .toStrictEqual(new Set(forwards.diagnostics.map(d => d.message)))
  })
})

describe('no-duplicated-helper, the agentic approach', () => {
  it('provides a default agent so TOML configs can enable semantic duplicate review', () => {
    expect(resolveDuplicatedHelperAgent(createFixtureContext())).toBeTypeOf('function')
  })

  it('is never asked about a helper a fingerprint already settled', async () => {
    const run = createRun()

    // Every helper in `archive.ts` is an exact copy, so there is nothing left to ask.
    await lint(run, 'ts/archive.ts', {
      simplicity: {
        cache: false,
        ignores: ['alint.config.ts'],
      },
    })

    expect(run.diagnostics).toHaveLength(1)
    expect(run.agentRequests).toHaveLength(0)
  })

  it('hands the agent only the helpers no fingerprint could settle', async () => {
    const index = await createFixtureIndex()
    const run = createRun()

    await lint(run, 'ts/reimplemented.ts', {
      simplicity: {
        cache: false,
        ignores: ['alint.config.ts'],
      },
    })

    expect(run.agentRequests).toHaveLength(1)
    expect(run.agentRequests[0].prompt).toContain(fixtureHelper(index, 'ts/reimplemented.ts', 'isNodeErrorCode').id)
    expect(run.agentRequests[0].prompt).toContain('isNodeErrorCode')
    expect(run.agentRequests[0].instructions).toContain('ALREADY been found and reported')
  })

  it('gives the agent the whole index, not a shortlist', async () => {
    const run = createRun(async (tools) => {
      // Reaches helpers in files this run never linted.
      const listed = String(await tools.get('list_helpers')!.execute({ language: 'python' }))
      expect(listed).toContain('python/store.py')
    })

    await lint(run, 'ts/reimplemented.ts', {
      simplicity: {
        cache: false,
        ignores: ['alint.config.ts'],
      },
    })

    expect(run.agentRequests).toHaveLength(1)
  })

  it('reports what the agent finds by searching for behaviour, not by name', async () => {
    const index = await createFixtureIndex()
    const helper = fixtureHelper(index, 'ts/reimplemented.ts', 'isNodeErrorCode')
    const twin = fixtureHelper(index, 'ts/store.ts', 'isNodeError')

    const run = createRun(async (tools) => {
      // The two share no significant name word, so only a body search can reach the pair.
      const hits = String(await tools.get('search_helper_bodies')!.execute({ language: 'typescript', query: 'code' }))
      expect(hits).toContain(twin.id)

      await tools.get('report_duplicate')!.execute({
        helperId: helper.id,
        reason: 'Both ask whether an error carries a filesystem error code.',
        twinId: twin.id,
      })
    })

    await lint(run, 'ts/reimplemented.ts', {
      simplicity: {
        cache: false,
        ignores: ['alint.config.ts'],
      },
    })

    expect(run.diagnostics).toHaveLength(1)

    const [diagnostic] = run.diagnostics
    expect(diagnostic.message).toBe(`Helper "isNodeErrorCode" duplicates "isNodeError" at ${twin.id}: Both ask whether an error carries a filesystem error code.`)
    expect(diagnostic.loc?.start.line).toBe(helper.line)
    expect(diagnostic.evidence).toMatchObject({
      match: 'reimplemented',
      reason: 'Both ask whether an error carries a filesystem error code.',
    })
  })

  it('reports nothing when the agent decides nothing qualifies', async () => {
    const run = createRun()

    await lint(run, 'ts/walk.ts', {
      simplicity: {
        cache: false,
        ignores: ['alint.config.ts'],
      },
    })

    expect(run.agentRequests).toHaveLength(1)
    expect(run.diagnostics).toStrictEqual([])
  })

  it('keeps the fingerprint findings when the agent fails', async () => {
    const failing = createRun(() => {
      throw new Error('the model is down')
    })

    // `walk.ts` has nothing for the fingerprints, so a failed agent leaves it silent.
    await lint(failing, 'ts/walk.ts', {
      simplicity: {
        cache: false,
        ignores: ['alint.config.ts'],
      },
    })
    expect(failing.diagnostics).toStrictEqual([])
    expect(failing.debug.join('\n')).toContain('the model is down')

    const store = createRun(() => {
      throw new Error('the model is down')
    })
    await lint(store, 'ts/store.ts', {
      simplicity: {
        cache: false,
        ignores: ['alint.config.ts'],
      },
    })
    expect(store.diagnostics).toHaveLength(1)
    expect(store.diagnostics[0].evidence).toMatchObject({ match: 'exact' })
  })

  it('does not ask twice about a workspace nobody touched', async () => {
    const cwd = await createWorkspace()
    const index = await createFixtureIndex()

    try {
      const settings = {
        simplicity: {
          ignores: ['alint.config.ts'],
        },
      }
      const answer = async (tools: Map<string, AgentTool>) => {
        await tools.get('report_duplicate')!.execute({
          helperId: fixtureHelper(index, 'ts/reimplemented.ts', 'isNodeErrorCode').id,
          reason: 'Both ask whether an error carries a code.',
          twinId: fixtureHelper(index, 'ts/store.ts', 'isNodeError').id,
        })
      }

      const first = createRun(answer, cwd)
      await lint(first, 'ts/reimplemented.ts', settings)

      expect(first.agentRequests).toHaveLength(1)
      expect(first.diagnostics).toHaveLength(1)

      // A new run means a cold in-memory cache, so only the cache on disk can carry the decision.
      const second = createRun(answer, cwd)
      await lint(second, 'ts/reimplemented.ts', settings)

      expect(second.agentRequests).toHaveLength(0)
      expect(second.diagnostics).toHaveLength(1)
      expect(second.diagnostics[0].message).toBe(first.diagnostics[0].message)
    }
    finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  it('runs no agent at all when the judge is off', async () => {
    const act = vi.fn()
    const run = createRun(act)

    await lint(run, 'ts/walk.ts', AST_ONLY)

    expect(act).not.toHaveBeenCalled()
    expect(run.agentRequests).toHaveLength(0)
  })
})

describe('no-duplicated-helper, files it will not touch', () => {
  it('ignores a file whose extension has no grammar', async () => {
    const run = createRun()

    await duplicatedHelperRule.create(run.contextFor(AST_ONLY)).onTargetFile?.({
      file: {
        contentHash: 'unused',
        language: 'plaintext',
        path: resolve(FIXTURES_DIR, 'README.md'),
      },
      identity: 'file',
      kind: 'file',
      language: 'plaintext',
    })

    expect(run.diagnostics).toStrictEqual([])
  })

  it('rejects settings it cannot read', () => {
    expect(() => duplicatedHelperRule.create(createRun().contextFor({
      simplicity: { maxLines: 0 },
    })))
      .toThrow('simplicity/no-duplicated-helper: invalid "settings.simplicity": "maxLines"')
    expect(() => duplicatedHelperRule.create(createRun().contextFor({
      simplicity: { judge: 'no' },
    })))
      .toThrow('"judge"')
    expect(() => duplicatedHelperRule.create(createRun().contextFor({ simplicity: [] })))
      .toThrow('invalid "settings.simplicity"')
  })
})

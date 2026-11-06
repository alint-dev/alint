import type { AgentTool } from '@alint-js/core/agent'

import type { IndexedHelper } from '../../repo'
import type { AgentFinding } from './tools'

import { beforeEach, describe, expect, it } from 'vitest'

import { createFixtureIndex, fixtureHelper } from '../../repo/fixtures'
import { createDuplicateTools } from './tools'

let findings: AgentFinding[]
let tools: AgentTool[]
let index: Awaited<ReturnType<typeof createFixtureIndex>>

/** `ts/reimplemented.ts` is the file under review: only its helpers may be reported. */
beforeEach(async () => {
  index = await createFixtureIndex()
  findings = []
  tools = createDuplicateTools({
    findings,
    index,
    reviewing: index.helpers.filter(helper => helper.id.startsWith('ts/reimplemented.ts:')),
  })
})

async function call(name: string, input: unknown): Promise<string> {
  return String(await tool(name).execute(input))
}

function helperIn(file: string, name: string): IndexedHelper {
  return fixtureHelper(index, file, name)
}

function idOf(file: string, name: string): string {
  return helperIn(file, name).id
}

function tool(name: string): AgentTool {
  const found = tools.find(entry => entry.name === name)

  if (found === undefined) {
    throw new Error(`no tool named ${name}`)
  }

  return found
}

describe('the tool surface', () => {
  it('gives the agent exactly the tools it needs, and no more', () => {
    expect(tools.map(entry => entry.name).sort()).toStrictEqual([
      'find_similar',
      'get_helper',
      'list_helpers',
      'report_duplicate',
      'search_helper_bodies',
    ])
  })
})

describe('list_helpers', () => {
  it('lists helpers as id-and-name lines, not as code', async () => {
    const output = await call('list_helpers', { language: 'python' })

    expect(output).toContain('python/store.py')
    expect(output).toContain('is_missing')
    expect(output).not.toContain('errno.ENOENT')
  })

  it('filters by directory and by name', async () => {
    const output = await call('list_helpers', { directory: 'go/', name_contains: 'missing' })

    expect(output).toContain('go/store.go')
    expect(output).toContain('go/archive.go')
    expect(output).not.toContain('ReadName')
  })

  it('says so in words when nothing matched', async () => {
    const output = await call('list_helpers', { name_contains: 'nothingIsNamedThis' })

    expect(output).toBe('No helper matched. Try a broader filter, or drop one.')
  })
})

describe('get_helper', () => {
  it('returns one helper in full', async () => {
    const id = idOf('ts/store.ts', 'isNodeError')
    const output = await call('get_helper', { id })

    expect(output).toContain(`${id} (typescript)`)
    expect(output).toContain('function isNodeError(error: unknown)')
  })

  it('tells the agent how to find a real id when it invents one', async () => {
    const output = await call('get_helper', { id: 'nope.ts:1' })

    expect(output).toContain('No helper has the id "nope.ts:1"')
    expect(output).toContain('list_helpers')
  })
})

describe('search_helper_bodies', () => {
  // `isNodeErrorCode` shares no significant name word with `isNodeError`: only a body search reaches it.
  it('finds a helper by what its body does, not by what it is called', async () => {
    const output = await call('search_helper_bodies', { language: 'typescript', query: 'code' })

    expect(output).toContain('ts/reimplemented.ts')
    expect(output).toContain('isNodeErrorCode')
  })

  it('searches the normalized body, so formatting and comments cannot hide a match', async () => {
    const output = await call('search_helper_bodies', { query: 'instanceof Error' })

    expect(output).toContain(idOf('ts/store.ts', 'isNodeError'))
    expect(output).toContain('ts/renamed.ts')
  })

  it('returns ids and names, never the matched code', async () => {
    const output = await call('search_helper_bodies', { query: 'instanceof Error' })

    // NOTICE: SWE-agent found that showing context around each hit confuses the model.
    expect(output).not.toContain('return error instanceof Error')
  })

  it('says so in words when nothing matched', async () => {
    const output = await call('search_helper_bodies', { query: 'zzz_not_in_any_body' })

    expect(output).toContain('No helper body contains "zzz_not_in_any_body"')
  })

  it('refuses an empty query', async () => {
    const output = await call('search_helper_bodies', { query: '  ' })

    expect(output).toContain('query is required')
  })
})

describe('find_similar', () => {
  it('ranks by overlap, closest first, and never returns the helper itself', async () => {
    const isNodeError = idOf('ts/store.ts', 'isNodeError')
    const output = await call('find_similar', { id: isNodeError, limit: 3 })
    const lines = output.split('\n')

    expect(lines.length).toBeLessThanOrEqual(3)
    expect(output).not.toContain(isNodeError)

    // The copy and the renamed copy lead; `isNodeErrorCode`, the one pair a fingerprint cannot
    // settle, does not. The ranking only ranks.
    expect(output).toContain(idOf('ts/archive.ts', 'isNodeError'))
    expect(output).toContain(idOf('ts/renamed.ts', 'hasErrorCode'))
  })

  it('only ranks helpers of the same language', async () => {
    const output = await call('find_similar', {
      id: idOf('python/store.py', 'is_missing'),
      limit: 20,
    })

    expect(output).not.toContain('.ts:')
    expect(output).not.toContain('.go:')
  })

  it('rejects an id it does not know', async () => {
    expect(await call('find_similar', { id: 'nope.ts:1' })).toContain('No helper has the id')
  })
})

describe('report_duplicate, and its guardrails', () => {
  it('records a duplicate of a helper in the file under review', async () => {
    const helperId = idOf('ts/reimplemented.ts', 'isNodeErrorCode')
    const twinId = idOf('ts/store.ts', 'isNodeError')

    const output = await call('report_duplicate', {
      helperId,
      reason: 'Both ask whether an error carries a filesystem error code.',
      twinId,
    })

    expect(output).toBe(`Recorded: ${helperId} duplicates ${twinId}.`)
    expect(findings).toHaveLength(1)
    expect(findings[0].helperId).toBe(helperId)
    expect(findings[0].twinId).toBe(twinId)
  })

  // `isNodeError` is a real helper; it just does not live in the file under review.
  it('refuses a helper that is not in the file under review', async () => {
    const output = await call('report_duplicate', {
      helperId: idOf('ts/store.ts', 'isNodeError'),
      reason: 'Same thing.',
      twinId: idOf('ts/archive.ts', 'isNodeError'),
    })

    expect(output).toContain('is not a helper of the file under review')
    expect(findings).toStrictEqual([])
  })

  it('refuses a twin it does not know', async () => {
    const output = await call('report_duplicate', {
      helperId: idOf('ts/reimplemented.ts', 'isNodeErrorCode'),
      reason: 'Same thing.',
      twinId: 'invented.ts:1',
    })

    expect(output).toContain('No helper has the id')
    expect(findings).toStrictEqual([])
  })

  it('refuses a helper reported against itself', async () => {
    const id = idOf('ts/reimplemented.ts', 'isNodeErrorCode')

    const output = await call('report_duplicate', {
      helperId: id,
      reason: 'Same thing.',
      twinId: id,
    })

    expect(output).toBe('A helper cannot duplicate itself. Pass the other helper as twin_id.')
    expect(findings).toStrictEqual([])
  })

  it('refuses a pair in two languages, because they cannot share a home', async () => {
    const output = await call('report_duplicate', {
      helperId: idOf('ts/reimplemented.ts', 'isNodeErrorCode'),
      reason: 'They both check for a missing file.',
      twinId: idOf('python/store.py', 'is_missing'),
    })

    expect(output).toContain('is typescript and')
    expect(output).toContain('is python')
    expect(findings).toStrictEqual([])
  })

  it('refuses a report with no reason', async () => {
    const output = await call('report_duplicate', {
      helperId: idOf('ts/reimplemented.ts', 'isNodeErrorCode'),
      reason: '   ',
      twinId: idOf('ts/store.ts', 'isNodeError'),
    })

    expect(output).toContain('reason is required')
    expect(findings).toStrictEqual([])
  })

  // A model asked for "one sentence" writes a paragraph, so the tool holds the limit the prompt cannot.
  it('refuses a reason too long to read at the end of a line', async () => {
    const output = await call('report_duplicate', {
      helperId: idOf('ts/reimplemented.ts', 'isNodeErrorCode'),
      reason: 'These helpers all read a file and turn a missing-file error into an empty result while panicking on any other read failure, so they are one family that should live together.',
      twinId: idOf('ts/store.ts', 'isNodeError'),
    })

    expect(output).toContain('Too long')
    expect(output).toContain('at most twelve words')
    expect(findings).toStrictEqual([])
  })

  it('records the same pair only once', async () => {
    const input = {
      helperId: idOf('ts/reimplemented.ts', 'isNodeErrorCode'),
      reason: 'Same question.',
      twinId: idOf('ts/store.ts', 'isNodeError'),
    }

    await call('report_duplicate', input)
    const second = await call('report_duplicate', input)

    expect(second).toContain('Already recorded')
    expect(findings).toHaveLength(1)
  })
})

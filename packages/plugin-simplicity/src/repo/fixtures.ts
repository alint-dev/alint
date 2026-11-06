import type { RuleContext, SourceRuntime } from '@alint-js/plugin'

import type { IndexedHelper, RepoIndex } from './index'

import { resolve } from 'node:path'

import languagesPlugin from '@alint-js/languages'

import { createSourceExtractor, createSourceRuntime } from '@alint-js/core'
import { defineConfig } from '@alint-js/plugin'

import { repoIndexFor } from './index'

/**
 * The fixture workspace: real files in four languages. Shared so rule tests and tool tests index
 * the same one, and outside `index.ts` so it never ships.
 */
export const FIXTURES_DIR = resolve(import.meta.dirname, '../../fixtures')

export function createFixtureContext(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    cwd: FIXTURES_DIR,
    id: 'simplicity/no-duplicated-helper',
    localId: 'no-duplicated-helper',
    logger: {
      debug: () => {},
    },
    metering: {
      recordUsage: () => {},
    },
    model: () => Promise.resolve({
      aliases: [],
      capabilities: ['tool-call'],
      id: 'test-model',
      name: 'test-model',
      params: {},
      provider: {
        endpoint: 'http://127.0.0.1:0/v1',
        headers: {},
        id: 'test-provider',
        type: 'openai-compatible',
      },
    }),
    options: [],
    report: () => {},
    settings: {},
    // A fresh runtime per context: the index is memoized on `src`, and one context is one run.
    src: createFixtureRuntime(),
    ...overrides,
  }
}

export async function createFixtureIndex(): Promise<RepoIndex> {
  return repoIndexFor(createFixtureContext(), {
    cwd: FIXTURES_DIR,
    ignores: ['alint.config.ts'],
    maxLines: 10,
    minTokens: 5,
  })
}

/**
 * The runtime a real run hands a rule, assembled the way `runAlint` assembles it.
 *
 * Built rather than stubbed, so these tests exercise the real config resolution and language
 * lookup. The config below mirrors what a user's own config needs: the fixtures include Go, Python
 * and Rust, which only resolve once `@alint-js/languages` is registered.
 */
export function createFixtureRuntime(): SourceRuntime {
  const config = defineConfig([
    {
      files: ['**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,rs,go,py}'],
      plugins: { languages: languagesPlugin },
    },
  ])

  // The extractor needs the runtime that is being built around it. Reading `src` through a getter
  // defers that until a rule extracts something, long after this has returned. `runAlint` does the
  // same.
  const src: SourceRuntime = createSourceRuntime({
    extract: createSourceExtractor(FIXTURES_DIR, config, () => src),
  })

  return src
}

/**
 * One fixture helper, by file and name. Tests must not spell out a `path:line` id: adding a comment
 * to a fixture moves the code under it and breaks every test that did.
 */
export function fixtureHelper(index: RepoIndex, relativePath: string, name: string): IndexedHelper {
  const helper = index.helpers.find(candidate => candidate.id.startsWith(`${relativePath}:`) && candidate.name === name)

  if (helper === undefined) {
    throw new Error(`no helper named "${name}" in ${relativePath}. The fixture or the index changed.`)
  }

  return helper
}

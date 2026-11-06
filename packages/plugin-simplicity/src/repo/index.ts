import type { CallSite, FunctionInfo, RuleContext, SourceTarget } from '@alint-js/plugin'

import { createHash } from 'node:crypto'
import { relative } from 'node:path'

import { DEFAULT_IGNORE_PATTERNS, listFiles } from '@alint-js/tools-fs'
import { errorMessageFrom } from '@moeru/std/error'
import { minimatch } from 'minimatch'

import { alphaFingerprint, exactFingerprint, normalizedBody, tokenize, tokenOverlap } from '../fingerprint'

export type { DecisionCache, JudgedHelper, ReviewCache } from './cache'
export { decisionCacheFor, reviewCacheFor } from './cache'

export interface IndexedHelper {
  alphaFingerprint: string
  /** Comments and formatting removed, names left alone, so `search_helper_bodies` searches real code. */
  body: string
  bodyIsSingleExpression: boolean
  /** Statements in the body, not counting comments. */
  bodyStatements: number
  exactFingerprint: string
  exported: boolean
  filePath: string
  /** `packages/cli/src/lint.ts:57`. Unique, and a model can quote it back. */
  id: string
  /** The id the language registered under: `typescript` and `go`, never `ts` or `golang`. */
  language: string
  line: number
  lines: number
  name: string
  text: string
  tokens: string[]
  /**
   * How often a function of this name is called across the workspace.
   *
   * Counted by NAME, not by binding, so two `isEmpty` helpers share a count and `x.isEmpty()` counts too.
   * Only ever handed to the judge as an approximate fact.
   */
  usageCount: number
}

export interface RepoIndex {
  byAlpha: Map<string, IndexedHelper[]>
  byExact: Map<string, IndexedHelper[]>
  byId: Map<string, IndexedHelper>
  /** Every helper in the workspace, in one hash. What a cached review is stamped with. */
  fingerprint: string
  helpers: IndexedHelper[]
}

export interface RepoIndexOptions {
  cwd: string
  ignores: readonly string[]
  maxLines: number
  minTokens: number
}

// A duplicate is a fact about the workspace, not about one file: the copy may live in a file this
// run never lints. Built once per run over every parseable file, which also keeps reports ordered.
const indexes = new WeakMap<RuleContext['src'], Promise<RepoIndex>>()

/** Helpers of one file, in source order. */
export function helpersIn(index: RepoIndex, filePath: string): IndexedHelper[] {
  return index.helpers.filter(helper => helper.filePath === filePath)
}

export async function repoIndexFor(ctx: RuleContext, options: RepoIndexOptions): Promise<RepoIndex> {
  const existing = indexes.get(ctx.src)

  if (existing !== undefined) {
    return existing
  }

  // The promise, not the result: files reach this in parallel, and the second must wait for the
  // first scan rather than start its own.
  const building = buildRepoIndex(ctx, options)
  indexes.set(ctx.src, building)

  return building
}

/** Closest first by token overlap, which ranks candidates and decides nothing; see `tokenOverlap`. */
export function similarTo(index: RepoIndex, helper: IndexedHelper, limit: number): IndexedHelper[] {
  return index.helpers
    .filter(other => other.id !== helper.id && other.language === helper.language)
    .map(other => ({
      other,
      score: tokenOverlap(helper.tokens, other.tokens),
    }))
    .filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(entry => entry.other)
}

/** Every other helper sharing a fingerprint. A helper is never its own twin. */
export function twinsOf(
  index: RepoIndex,
  helper: IndexedHelper,
  kind: 'alpha' | 'exact',
): IndexedHelper[] {
  const bucket = kind === 'exact'
    ? index.byExact
    : index.byAlpha
  const fingerprint = kind === 'exact'
    ? helper.exactFingerprint
    : helper.alphaFingerprint

  return (bucket.get(fingerprint) ?? []).filter(other => other.id !== helper.id)
}

async function buildRepoIndex(ctx: RuleContext, options: RepoIndexOptions): Promise<RepoIndex> {
  const index: RepoIndex = {
    byAlpha: new Map(),
    byExact: new Map(),
    byId: new Map(),
    fingerprint: '',
    helpers: [],
  }

  const paths = await listFiles(options.cwd, {
    ignore: [
      ...DEFAULT_IGNORE_PATTERNS,
      ...options.ignores,
    ],
    patterns: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,rs,go,py}'],
  })

  // Counted while each file is already parsed, rather than in a second pass.
  const calls = new Map<string, number>()

  for (const path of paths.sort()) {
    if (isIgnored(options.cwd, path, options.ignores)) {
      continue
    }

    for (const helper of await helpersOf(ctx, path, options, calls)) {
      index.helpers.push(helper)
      index.byId.set(helper.id, helper)
      push(index.byExact, helper.exactFingerprint, helper)
      push(index.byAlpha, helper.alphaFingerprint, helper)
    }
  }

  for (const helper of index.helpers) {
    helper.usageCount = calls.get(helper.name) ?? 0
  }

  // Keyed by position as well as content: a helper that only moved is reported at a new line, so a
  // cached review pointing at the old one is stale.
  index.fingerprint = createHash('sha256')
    .update(index.helpers.map(helper => `${helper.id}:${helper.exactFingerprint}`).join('\n'))
    .digest('hex')

  ctx.logger.debug(`simplicity: indexed ${index.helpers.length} helpers from ${paths.length} files`)

  return index
}

/**
 * Every call in the file, which a language reports on its file target.
 *
 * TypeScript knows `metadata` holds JSON values. It does not know `calls` holds call sites, so the
 * shape is checked here rather than cast. Bad data would quietly skew the usage counts, and
 * counting nothing is safer than counting the wrong thing.
 */
function callsOf(target: SourceTarget): CallSite[] {
  const calls = target.metadata?.calls

  if (!Array.isArray(calls)) {
    return []
  }

  return calls.filter((call): call is CallSite =>
    typeof call === 'object' && call !== null && typeof (call as CallSite).name === 'string')
}

/** Undefined unless this is a function target whose language filled in the info. See `callsOf`. */
function functionInfoOf(target: SourceTarget): FunctionInfo | undefined {
  if (target.kind !== 'function') {
    return undefined
  }

  const info = target.metadata?.function

  if (typeof info !== 'object' || info === null || !Array.isArray((info as FunctionInfo).declaredNames)) {
    return undefined
  }

  return info as FunctionInfo
}

async function helpersOf(
  ctx: RuleContext,
  filePath: string,
  options: RepoIndexOptions,
  calls: Map<string, number>,
): Promise<IndexedHelper[]> {
  let targets: SourceTarget[]

  try {
    targets = await ctx.src.extract(filePath)
  }
  catch (error) {
    // A file that cannot be parsed costs its own helpers, never the run.
    ctx.logger.debug(`simplicity: skipped ${filePath}: ${errorMessageFrom(error) ?? 'could not be parsed'}`)

    return []
  }

  for (const target of targets) {
    for (const call of callsOf(target)) {
      calls.set(call.name, (calls.get(call.name) ?? 0) + 1)
    }
  }

  const helpers: IndexedHelper[] = []

  for (const target of targets) {
    const info = functionInfoOf(target)

    // Not a function, unnamed, or missing its info. A helper needs all three to be fingerprinted
    // and reported, and the file target itself lands here too.
    if (info === undefined || target.name === undefined || target.loc === undefined) {
      continue
    }

    const lines = target.loc.end.line - target.loc.start.line + 1
    const tokens = tokenize(target.text, info.commentRanges, info.identifierRanges, info.declaredNames)

    if (lines > options.maxLines || tokens.length < options.minTokens) {
      continue
    }

    helpers.push({
      alphaFingerprint: alphaFingerprint(target.text, info.commentRanges, info.identifierRanges, info.declaredNames),
      body: normalizedBody(target.text, info.commentRanges),
      bodyIsSingleExpression: info.bodyIsSingleExpression,
      bodyStatements: info.bodyStatements,
      exactFingerprint: exactFingerprint(target.text, info.commentRanges),
      exported: info.exported,
      filePath,
      id: `${relative(options.cwd, filePath)}:${target.loc.start.line}`,
      language: target.language,
      line: target.loc.start.line,
      lines,
      name: target.name,
      text: target.text,
      tokens,
      // Filled in once every file has been counted.
      usageCount: 0,
    })
  }

  return helpers
}

function isIgnored(cwd: string, filePath: string, ignores: readonly string[]): boolean {
  const relativePath = relative(cwd, filePath)

  return ignores.some(pattern => minimatch(relativePath, pattern, { dot: true }))
}

function push(bucket: Map<string, IndexedHelper[]>, key: string, helper: IndexedHelper): void {
  bucket.set(key, [
    ...bucket.get(key) ?? [],
    helper,
  ])
}

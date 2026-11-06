import type { RuleContext } from '@alint-js/plugin'

import type { AgentFinding } from '../rules/no-duplicated-helper/tools'

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

import { errorMessageFrom } from '@moeru/std/error'

export interface DecisionCache {
  /** A decision is returned only to a run that would ask the identical question. */
  get: (filePath: string, key: string) => JudgedHelper[] | undefined
  set: (filePath: string, key: string, findings: JudgedHelper[]) => Promise<void>
}

export interface JudgedHelper {
  /** The ordinal it was shown under, not a line. Only tells two helpers of one name apart. */
  helper: number
  name: string
  reason: string
}

export interface ReviewCache {
  /** A review is returned only to a run whose `fingerprint` matches the one it was decided against. */
  get: (filePath: string) => AgentFinding[] | undefined
  set: (filePath: string, findings: AgentFinding[]) => Promise<void>
}

interface DecisionFile {
  decisions: Record<string, { findings: JudgedHelper[], key: string }>
  schemaVersion: typeof SCHEMA_VERSION
}

interface ReviewFile {
  /** The index the reviews were decided against. A run that hashes differently cannot use them. */
  fingerprint: string
  reviews: Record<string, AgentFinding[]>
  schemaVersion: typeof SCHEMA_VERSION
}

// 2: a judged helper is remembered by the ordinal it was shown under, not by its line.
const SCHEMA_VERSION = 2

// A duplicate decision depends on the whole workspace, so the cache carries one fingerprint of the
// index and a mismatch drops all of it. Coarse on purpose: the price of never replaying a stale one.
const reviewCaches = new WeakMap<RuleContext['src'], Promise<ReviewCache>>()

// `no-needless-helper` needs its own cache: its decision turns on the usage count, which the index
// fingerprint does not cover, and one cache per `src` would let two rules read each other's answers.
const decisionCaches = new WeakMap<RuleContext['src'], Promise<DecisionCache>>()

export function decisionCacheFor(
  ctx: RuleContext,
  options: { cwd: string, enabled: boolean },
): Promise<DecisionCache> {
  const existing = decisionCaches.get(ctx.src)

  if (existing !== undefined) {
    return existing
  }

  const loading = loadDecisions(ctx, options)
  decisionCaches.set(ctx.src, loading)

  return loading
}

export function reviewCacheFor(
  ctx: RuleContext,
  options: { cwd: string, enabled: boolean, fingerprint: string },
): Promise<ReviewCache> {
  const existing = reviewCaches.get(ctx.src)

  if (existing !== undefined) {
    return existing
  }

  const loading = loadReviews(ctx, options)
  reviewCaches.set(ctx.src, loading)

  return loading
}

async function loadDecisions(
  ctx: RuleContext,
  options: { cwd: string, enabled: boolean },
): Promise<DecisionCache> {
  if (!options.enabled) {
    return {
      get: () => undefined,
      set: async () => {},
    }
  }

  const location = join(options.cwd, '.alint', 'simplicity', 'decisions.json')
  const decisions = await rememberedDecisions(location)

  let writing: Promise<void> = Promise.resolve()

  return {
    get: (filePath, key) => {
      const remembered = decisions[relative(options.cwd, filePath)]

      // A stale entry is ignored, not dropped: the run about to ask again overwrites it.
      return remembered?.key === key
        ? remembered.findings
        : undefined
    },
    set: async (filePath, key, findings) => {
      decisions[relative(options.cwd, filePath)] = { findings, key }

      writing = writing.then(async () => write(ctx, location, {
        decisions,
        schemaVersion: SCHEMA_VERSION,
      }))

      return writing
    },
  }
}

async function loadReviews(
  ctx: RuleContext,
  options: { cwd: string, enabled: boolean, fingerprint: string },
): Promise<ReviewCache> {
  if (!options.enabled) {
    return {
      get: () => undefined,
      set: async () => {},
    }
  }

  const location = join(options.cwd, '.alint', 'simplicity', 'reviews.json')
  const reviews = await rememberedReviews(ctx, location, options.fingerprint)

  // No end-of-run hook, so every file writes back as it finishes. Chained, not concurrent.
  let writing: Promise<void> = Promise.resolve()

  return {
    get: filePath => reviews[relative(options.cwd, filePath)],
    set: async (filePath, findings) => {
      reviews[relative(options.cwd, filePath)] = findings

      writing = writing.then(async () => write(ctx, location, {
        fingerprint: options.fingerprint,
        reviews,
        schemaVersion: SCHEMA_VERSION,
      }))

      return writing
    },
  }
}

/** What was written last time. A missing or unreadable cache is never an error. */
async function read<File>(location: string): Promise<File | undefined> {
  try {
    return JSON.parse(await readFile(location, 'utf8')) as File
  }
  catch {
    return undefined
  }
}

/** Everything remembered, stale entries and all: each carries the question it answered, so `get` can tell them apart. */
async function rememberedDecisions(location: string): Promise<DecisionFile['decisions']> {
  const parsed = await read<DecisionFile>(location)

  if (parsed === undefined || parsed.schemaVersion !== SCHEMA_VERSION) {
    return {}
  }

  return parsed.decisions ?? {}
}

/** Reviews decided against this exact index, or nothing at all. */
async function rememberedReviews(
  ctx: RuleContext,
  location: string,
  fingerprint: string,
): Promise<Record<string, AgentFinding[]>> {
  const parsed = await read<ReviewFile>(location)

  if (parsed === undefined) {
    return {}
  }

  if (parsed.schemaVersion !== SCHEMA_VERSION || parsed.fingerprint !== fingerprint) {
    ctx.logger.debug('simplicity: the workspace changed since the last run; the review cache was dropped')

    return {}
  }

  return parsed.reviews ?? {}
}

async function write(ctx: RuleContext, location: string, file: DecisionFile | ReviewFile): Promise<void> {
  try {
    await mkdir(dirname(location), { recursive: true })

    // Written whole and renamed into place, so a run killed mid-write leaves the last good cache.
    const pending = `${location}.tmp`
    await writeFile(pending, JSON.stringify(file), 'utf8')
    await rename(pending, location)
  }
  catch (error) {
    // A cache that cannot be written costs the next run its tokens, and nothing else.
    ctx.logger.debug(`simplicity: could not write ${location}: ${errorMessageFrom(error) ?? 'unknown error'}`)
  }
}

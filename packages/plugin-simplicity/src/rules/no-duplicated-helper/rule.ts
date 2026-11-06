import type { RuleContext } from '@alint-js/plugin'

import type { IndexedHelper, RepoIndex } from '../../repo'
import type { AgentFinding } from './tools'

import { createHash } from 'node:crypto'

import { createApeiraAdapter } from '@alint-js/agent-apeira'
import { defineRule } from '@alint-js/plugin'
import { errorMessageFrom } from '@moeru/std/error'
import { minimatch } from 'minimatch'
import { relative } from 'pathe'

import { helpersIn, repoIndexFor, reviewCacheFor, similarTo, twinsOf } from '../../repo'
import { readSimplicitySettings } from '../shared/settings'
import { buildDuplicatedHelperPrompt, duplicatedHelperInstructions } from './prompt'
import { createDuplicateTools } from './tools'

/**
 * Reports a small helper already implemented somewhere else in the workspace.
 *
 * Identical bodies and renamed-only copies are settled by AST fingerprints, with no model. What
 * a fingerprint cannot settle goes to an agent holding the whole index as tools.
 */
export const duplicatedHelperRule = defineRule({
  // The core's per-target cache keys on the target's own text, but a twin appearing in another
  // file has to flip this file's result while this file has not changed.
  cache: false,
  create: (ctx) => {
    const settings = readSimplicitySettings(ctx)

    return {
      async onTargetFile(target) {
        if (isIgnored(ctx.cwd, target.file.path, settings.ignores)) {
          return
        }

        const index = await repoIndexFor(ctx, {
          cwd: ctx.cwd,
          ignores: settings.ignores,
          maxLines: settings.maxLines,
          minTokens: settings.minTokens,
        })

        const unsettled: IndexedHelper[] = []

        for (const helper of helpersIn(index, target.file.path)) {
          const exactTwins = twinsOf(index, helper, 'exact')

          if (exactTwins.length > 0) {
            reportFingerprinted(ctx, helper, exactTwins, 'exact')
            continue
          }

          const renamedTwins = twinsOf(index, helper, 'alpha')

          if (renamedTwins.length > 0) {
            reportFingerprinted(ctx, helper, renamedTwins, 'renamed')
            continue
          }

          unsettled.push(helper)
        }

        if (!settings.judge || unsettled.length === 0) {
          return
        }

        await review(ctx, index, unsettled, target.file.path, settings.cache)
      },
    }
  },
  /*
   * Every language except the `plaintext` fallback, rather than a list: nothing here reads syntax,
   * only the `FunctionInfo` a language reports, so a list would exclude any pack added later.
   *
   * This also replaces the extension check the rule used to run itself. A file no language claimed
   * is withheld, and the run reports `alint/unregistered-language` rather than the rule finding
   * nothing.
   */
  languages: 'any',
})

export function resolveDuplicatedHelperAgent(ctx: Pick<RuleContext, 'agent'>) {
  return ctx.agent ?? createApeiraAdapter({ maxSteps: 16 })
}

function isIgnored(cwd: string, filePath: string, ignores: readonly string[]): boolean {
  const relativePath = relative(cwd, filePath)

  return ignores.some(pattern => minimatch(relativePath, pattern, { dot: true }))
}

/**
 * Candidates pasted into the prompt so the agent does not have to search for them.
 * Three each: a token budget, not a shortlist. The tools still reach everything.
 */
function nearest(index: RepoIndex, helpers: readonly IndexedHelper[]): IndexedHelper[] {
  const seen = new Set(helpers.map(helper => helper.id))
  const nearby: IndexedHelper[] = []

  for (const helper of helpers) {
    for (const candidate of similarTo(index, helper, 3)) {
      if (seen.has(candidate.id)) {
        continue
      }

      seen.add(candidate.id)
      nearby.push(candidate)
    }
  }

  return nearby
}

function report(ctx: RuleContext, index: RepoIndex, findings: readonly AgentFinding[]): void {
  for (const finding of findings) {
    const helper = index.byId.get(finding.helperId)
    const twin = index.byId.get(finding.twinId)

    if (helper === undefined || twin === undefined) {
      continue
    }

    ctx.report({
      evidence: {
        match: 'reimplemented',
        reason: finding.reason,
        twins: [
          { filePath: twin.filePath, line: twin.line, name: twin.name },
        ],
      },
      filePath: helper.filePath,
      loc: {
        start: { column: 0, line: helper.line },
      },
      message: `Helper "${helper.name}" duplicates "${twin.name}" at ${twin.id}: ${finding.reason}`,
    })
  }
}

/** Both copies are reported, so either can be the one you delete, and neither depends on lint order. */
function reportFingerprinted(
  ctx: RuleContext,
  helper: IndexedHelper,
  twins: readonly IndexedHelper[],
  match: 'exact' | 'renamed',
): void {
  const where = twins.map(twin => twin.id).join(', ')

  ctx.report({
    evidence: {
      match,
      twins: twins.map(twin => ({ filePath: twin.filePath, line: twin.line, name: twin.name })),
    },
    filePath: helper.filePath,
    loc: {
      start: { column: 0, line: helper.line },
    },
    message: match === 'exact'
      ? `Helper "${helper.name}" is also defined at ${where}.`
      : `Helper "${helper.name}" is a renamed copy of ${twins.map(twin => `"${twin.name}"`).join(', ')} at ${where}; only the names it declares differ.`,
  })
}

/** Hands the file's unsettled helpers to the agent, unless a run already asked about them. */
async function review(
  ctx: RuleContext,
  index: RepoIndex,
  helpers: readonly IndexedHelper[],
  filePath: string,
  cacheEnabled: boolean,
): Promise<void> {
  const cache = await reviewCacheFor(ctx, {
    cwd: ctx.cwd,
    enabled: cacheEnabled,
    fingerprint: reviewFingerprint(index.fingerprint),
  })

  const remembered = cache.get(filePath)

  if (remembered !== undefined) {
    ctx.logger.debug(`no-duplicated-helper: ${filePath} was reviewed against this workspace already`)
    report(ctx, index, remembered)

    return
  }

  const findings: AgentFinding[] = []

  try {
    const agent = resolveDuplicatedHelperAgent(ctx)
    const model = await ctx.model()

    const result = await agent({
      instructions: duplicatedHelperInstructions,
      model,
      prompt: buildDuplicatedHelperPrompt({
        candidates: nearest(index, helpers),
        filePath,
        helpers,
      }),
      tools: createDuplicateTools({ findings, index, reviewing: helpers }),
    })

    // Metered even when it found nothing: an empty search was still paid for.
    if (result.usage) {
      ctx.metering.recordUsage({
        filePath,
        inputTokens: result.usage.inputTokens,
        metadata: { operation: 'no-duplicated-helper-review' },
        modelId: model.id,
        outputTokens: result.usage.outputTokens,
        providerId: model.provider.id,
        ruleId: ctx.id,
        totalTokens: result.usage.totalTokens,
      })
    }
  }
  catch (error) {
    // A failure is not a decision, so nothing is cached: the next run has to ask again.
    ctx.logger.debug(`no-duplicated-helper: agent review of ${filePath} failed: ${errorMessageFrom(error) ?? 'unknown error'}`)

    return
  }

  // Empty results are cached too: it is the answer most files give.
  await cache.set(filePath, findings)

  report(ctx, index, findings)
}

/**
 * Keys the cache on every helper in the workspace plus the instructions: change either and
 * a cached answer no longer answers the same question.
 */
function reviewFingerprint(indexFingerprint: string): string {
  return createHash('sha256')
    .update(`${indexFingerprint}\n${duplicatedHelperInstructions}`)
    .digest('hex')
}

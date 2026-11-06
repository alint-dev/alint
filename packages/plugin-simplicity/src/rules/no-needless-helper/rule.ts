import type { RuleContext } from '@alint-js/plugin'

import type { IndexedHelper, JudgedHelper } from '../../repo'

import { createHash } from 'node:crypto'

import { formatOutputLanguageInstruction, generateStructured } from '@alint-js/core/structured-output'
import { defineRule } from '@alint-js/plugin'
import { errorMessageFrom } from '@moeru/std/error'
import { minimatch } from 'minimatch'
import { relative } from 'pathe'
import { array, description, number, object, pipe, string } from 'valibot'

import { decisionCacheFor, helpersIn, repoIndexFor } from '../../repo'
import { readSimplicitySettings } from '../shared/settings'
import { buildNeedlessHelperPrompt, needlessHelperPrompt } from './prompt'

export type FindingResolution
  = | { helper: IndexedHelper, outcome: 'resolved' }
    | { outcome: 'ambiguous' }
    | { outcome: 'unknown' }

interface ResolvedFinding {
  helper: IndexedHelper
  reason: string
}

export const needlessHelperResponseSchema = object({
  findings: array(object({
    helper: pipe(number(), description('The number shown beside the helper, exactly as given.')),
    name: pipe(string(), description('The helper\'s name, exactly as shown.')),
    reason: pipe(string(), description('At most twelve words, naming what the body already says.')),
  })),
})

/**
 * Reports a helper whose interface is no simpler than its implementation.
 *
 * No AST approach is possible: a hash can prove a duplicate, but nothing can prove a helper
 * should not exist. The deterministic half only finds candidates and gathers facts (usage
 * count, exported), which are given to the model rather than applied as filters.
 */
export const needlessHelperRule = defineRule({
  // Not the core's per-target cache: a call added in another file moves the usage count and
  // flips the answer while this file is unchanged. The rule keeps its own store; see `judgeKey`.
  cache: false,
  create: (ctx) => {
    const settings = readSimplicitySettings(ctx)

    return {
      async onTargetFile(target) {
        if (!settings.judge || isIgnored(ctx.cwd, target.file.path, settings.ignores)) {
          return
        }

        const index = await repoIndexFor(ctx, {
          cwd: ctx.cwd,
          ignores: settings.ignores,
          maxLines: settings.maxLines,
          minTokens: settings.minTokens,
        })

        const candidates = helpersIn(index, target.file.path).filter(helper => helper.bodyIsSingleExpression)

        if (candidates.length === 0) {
          return
        }

        await judge(ctx, target.file.path, candidates, settings.cache)
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

/**
 * Everything the judge is told, so a cached answer is only replayed to an identical question.
 * The line is left out on purpose: a helper that only moved is the same helper.
 */
export function judgeKey(outputLanguage: string | undefined, candidates: readonly IndexedHelper[]): string {
  return createHash('sha256')
    .update([
      needlessHelperPrompt,
      outputLanguage ?? '',
      ...candidates.map(helper => [
        helper.name,
        helper.exported,
        helper.usageCount,
        helper.text,
      ].join('\n')),
    ].join('\n--\n'))
    .digest('hex')
}

/**
 * A name is not unique (a nested function is extracted on its own), so the ordinal the prompt
 * showed is the tiebreak. A finding that lands on no helper of that name is dropped: a diagnostic
 * on the wrong function is worse than none.
 */
export function resolveFinding(
  candidates: readonly IndexedHelper[],
  finding: { helper: number, name: string },
): FindingResolution {
  const named = candidates.filter(candidate => candidate.name === finding.name)

  if (named.length === 0) {
    return { outcome: 'unknown' }
  }

  if (named.length === 1) {
    return { helper: named[0], outcome: 'resolved' }
  }

  const claimed = candidates[finding.helper - 1]

  return claimed === undefined || claimed.name !== finding.name
    ? { outcome: 'ambiguous' }
    : { helper: claimed, outcome: 'resolved' }
}

function isIgnored(cwd: string, filePath: string, ignores: readonly string[]): boolean {
  const relativePath = relative(cwd, filePath)

  return ignores.some(pattern => minimatch(relativePath, pattern, { dot: true }))
}

async function judge(
  ctx: RuleContext,
  filePath: string,
  candidates: readonly IndexedHelper[],
  cacheEnabled: boolean,
): Promise<void> {
  const cache = await decisionCacheFor(ctx, { cwd: ctx.cwd, enabled: cacheEnabled })
  const key = judgeKey(ctx.outputLanguage, candidates)
  const remembered = cache.get(filePath, key)

  if (remembered !== undefined) {
    ctx.logger.debug(`no-needless-helper: ${filePath} was judged on these helpers already`)
    report(ctx, resolveFindings(ctx, candidates, remembered))

    return
  }

  let findings

  try {
    ({ findings } = await generateStructured({
      createMessages: retryFeedback => [
        {
          content: [
            needlessHelperPrompt,
            formatOutputLanguageInstruction(ctx.outputLanguage),
          ].filter(Boolean).join('\n\n'),
          role: 'system',
        },
        {
          content: buildNeedlessHelperPrompt(candidates),
          role: 'user',
        },
        ...(retryFeedback === undefined
          ? []
          : [
              { content: retryFeedback, role: 'user' as const },
            ]),
      ],
      logger: ctx.logger,
      metering: ctx.metering,
      model: await ctx.model(),
      operation: 'no-needless-helper-judge',
      schema: needlessHelperResponseSchema,
      signal: ctx.signal,
    }))
  }
  catch (error) {
    // A failure is not a decision: nothing is remembered, so the next run asks again.
    ctx.logger.debug(`no-needless-helper: could not judge ${filePath}: ${errorMessageFrom(error) ?? 'unknown error'}`)

    return
  }

  const resolved = resolveFindings(ctx, candidates, findings)

  // An empty answer is remembered too: most files are clean, and caching only findings would
  // leave every clean file paying full price.
  await cache.set(filePath, key, resolved.map(({ helper, reason }) => ({
    // The ordinal it was shown under; a replay can resolve it because the same key means the
    // same candidates in the same order.
    helper: candidates.indexOf(helper) + 1,
    name: helper.name,
    reason,
  })))

  report(ctx, resolved)
}

function report(ctx: RuleContext, findings: readonly ResolvedFinding[]): void {
  for (const { helper, reason } of findings) {
    ctx.report({
      evidence: {
        exported: helper.exported,
        reason,
        usageCount: helper.usageCount,
      },
      filePath: helper.filePath,
      loc: {
        start: { column: 0, line: helper.line },
      },
      message: `Helper "${helper.name}" does not earn its existence: ${reason}`,
    })
  }
}

/** Fresh and remembered findings carry the same fields, so both are pinned to where the helper stands now. */
function resolveFindings(
  ctx: RuleContext,
  candidates: readonly IndexedHelper[],
  findings: readonly JudgedHelper[],
): ResolvedFinding[] {
  const resolved: ResolvedFinding[] = []

  for (const finding of findings) {
    const resolution = resolveFinding(candidates, finding)

    if (resolution.outcome === 'unknown') {
      ctx.logger.debug(`no-needless-helper: ignored a finding for "${finding.name}", which was not one of the helpers under review`)
      continue
    }

    if (resolution.outcome === 'ambiguous') {
      ctx.logger.debug(`no-needless-helper: ignored a finding for "${finding.name}", which was ambiguous: several helpers under review share that name and helper ${finding.helper} is not one of them`)
      continue
    }

    resolved.push({ helper: resolution.helper, reason: finding.reason })
  }

  return resolved
}

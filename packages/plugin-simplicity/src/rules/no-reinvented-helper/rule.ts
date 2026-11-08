import type { RuleContext } from '@alint-js/plugin'
import type { InferOutput } from 'valibot'

import type { IndexedHelper } from '../../repo'

import { formatOutputLanguageInstruction, generateStructured } from '@alint-js/core/structured-output'
import { defineRule } from '@alint-js/plugin'
import { errorMessageFrom } from '@moeru/std/error'
import { minimatch } from 'minimatch'
import { relative } from 'pathe'
import { array, description, minLength, number, object, pipe, string } from 'valibot'

import { helpersIn, repoIndexFor } from '../../repo'
import { resolveFinding } from '../no-needless-helper/rule'
import { readSimplicitySettings } from '../shared/settings'
import { libraryExports } from './exports'
import { buildReinventedHelperPrompt, reinventedHelperPrompt } from './prompt'

export const reinventedHelperResponseSchema = object({
  findings: array(object({
    exportName: pipe(string(), description('The export name, exactly as listed.')),
    helper: pipe(number(), description('The number shown beside the helper, exactly as given.')),
    library: pipe(string(), description('The library, exactly as listed.')),
    name: pipe(string(), description('The helper\'s name, exactly as shown.')),
    reason: pipe(string(), description('One sentence. Why the export has the same behavior.')),
  })),
})

const optionsSchema = object({
  /** The utility libraries that the repository depends on, for example `['es-toolkit']`. */
  libraries: pipe(array(string()), minLength(1)),
})

export type ReinventedHelperOptions = InferOutput<typeof optionsSchema>

/**
 * Reports a small helper when a utility library that the repository already depends on exports
 * the same function.
 *
 * `no-duplicated-helper` finds a helper written twice in the workspace. This rule finds a helper
 * that the workspace did not need to write. It uses the same index of small helpers, so the same
 * `settings.simplicity` options apply.
 */
export const reinventedHelperRule = defineRule({
  /*
   * The verdict depends on the helpers of this file and on the library exports. The core cache
   * keys on the file and the options, so a library upgrade that adds an export reaches a cached
   * file only after the file changes.
   */
  cacheKey: reinventedHelperPrompt,
  create: (ctx) => {
    const settings = readSimplicitySettings(ctx)
    const [{ libraries }] = ctx.options

    return {
      async onTargetFile(target) {
        if (!settings.judge || settings.ignores.some(pattern => minimatch(relative(ctx.cwd, target.file.path), pattern, { dot: true }))) {
          return
        }

        const index = await repoIndexFor(ctx, {
          cwd: ctx.cwd,
          ignores: settings.ignores,
          maxLines: settings.maxLines,
          minTokens: settings.minTokens,
        })
        const candidates = helpersIn(index, target.file.path)

        if (candidates.length === 0) {
          return
        }

        const exports = new Map<string, string[]>()
        for (const library of libraries) {
          const names = await libraryExports(ctx, library)
          if (names !== undefined && names.length > 0)
            exports.set(library, names)
        }

        if (exports.size === 0) {
          return
        }

        await judge(ctx, candidates, exports)
      },
    }
  },
  // Nothing here reads syntax, only the helpers that the index extracts, as in `no-needless-helper`.
  languages: 'any',
  options: [optionsSchema],
})

async function judge(
  ctx: RuleContext<readonly [ReinventedHelperOptions]>,
  candidates: readonly IndexedHelper[],
  exports: ReadonlyMap<string, readonly string[]>,
): Promise<void> {
  let findings

  try {
    ({ findings } = await generateStructured({
      createMessages: retryFeedback => [
        {
          content: [
            reinventedHelperPrompt,
            formatOutputLanguageInstruction(ctx.outputLanguage),
          ].filter(Boolean).join('\n\n'),
          role: 'system',
        },
        {
          content: buildReinventedHelperPrompt(exports, candidates),
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
      operation: 'no-reinvented-helper-judge',
      schema: reinventedHelperResponseSchema,
      signal: ctx.signal,
    }))
  }
  catch (error) {
    ctx.logger.debug(`no-reinvented-helper: could not judge the helpers: ${errorMessageFrom(error) ?? 'unknown error'}`)

    return
  }

  for (const finding of findings) {
    const resolution = resolveFinding(candidates, finding)

    // The model can invent a helper, a library, or an export. Each must exist before a report.
    if (resolution.outcome !== 'resolved' || !exports.get(finding.library)?.includes(finding.exportName)) {
      ctx.logger.debug(`no-reinvented-helper: ignored a finding for "${finding.name}" (${finding.library}#${finding.exportName}), which names no helper under review or no listed export`)
      continue
    }

    const { helper } = resolution
    ctx.report({
      evidence: {
        export: finding.exportName,
        library: finding.library,
        reason: finding.reason,
      },
      filePath: helper.filePath,
      loc: {
        start: { column: 0, line: helper.line },
      },
      message: `Helper "${helper.name}" reimplements \`${finding.exportName}\` from \`${finding.library}\`. ${finding.reason}`,
    })
  }
}

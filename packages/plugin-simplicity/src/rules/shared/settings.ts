import type { RuleContext } from '@alint-js/plugin'
import type { InferOutput } from 'valibot'

import { array, boolean, getDotPath, integer, minValue, number, object, optional, pipe, safeParse, string } from 'valibot'

const settingsSchema = object({
  cache: optional(boolean(), true),
  /** Globs matched against the repository-relative file path. */
  ignores: optional(array(string()), []),
  /**
   * When false, no model is called: `no-duplicated-helper` still reports what a fingerprint settles,
   * `no-needless-helper` reports nothing.
   */
  judge: optional(boolean(), true),
  maxLines: optional(pipe(number(), integer(), minValue(1)), 10),
  /*
   * Content tokens, not parse-tree nodes: the same helper is 24 nodes in TypeScript's tree and
   * 15 in Python's, so a node floor silently skipped Python helpers. The 5 is measured on the
   * fixtures: an empty function is 3 tokens, the smallest real helper is a Python accessor at 6.
   */
  minTokens: optional(pipe(number(), integer(), minValue(1)), 5),
})

export type SimplicitySettings = InferOutput<typeof settingsSchema>

export function readSimplicitySettings(ctx: RuleContext): SimplicitySettings {
  const configured = ctx.settings.simplicity ?? {}

  // valibot's `object()` accepts an array, so `settings.simplicity: []` would pass and silently
  // mean "all defaults" rather than report a broken config.
  if (Array.isArray(configured)) {
    throw new TypeError(`${ctx.id}: invalid "settings.simplicity": expected an object, received an array.`)
  }

  const result = safeParse(settingsSchema, configured)

  if (!result.success) {
    const problems = result.issues
      .map((issue) => {
        const path = getDotPath(issue)

        return path === null
          ? issue.message
          : `"${path}": ${issue.message}`
      })
      .join('; ')

    throw new TypeError(`${ctx.id}: invalid "settings.simplicity": ${problems}`)
  }

  return result.output
}

import type { EnabledRule } from '../dsl/types'

import { minimatch } from 'minimatch'

const minimatchOptions = { dot: true }

/**
 * Whether one enabled rule survives a `--rule` filter.
 *
 * A pattern matches the configured rule id (`plugin/rule`) or the rule's own name
 * (`rule`), so `--rule docs/review-copy` narrows a run to a single rule while
 * `--rule 'docs/*'` keeps a plugin's rules. Patterns are matched with glob syntax.
 */
export function matchesRuleFilter(
  rule: Pick<EnabledRule, 'id' | 'localId'>,
  patterns: readonly string[],
): boolean {
  return patterns.some(pattern =>
    minimatch(rule.id, pattern, minimatchOptions)
    || minimatch(rule.localId, pattern, minimatchOptions),
  )
}

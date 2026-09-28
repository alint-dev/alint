/**
 * Reads `--rule` into the patterns the run filters rules with.
 *
 * The flag accepts one pattern, a comma-separated list, or repeated `--rule` flags, because a
 * debugging session usually narrows to one rule but sometimes compares a plugin's rules.
 */
export function resolveRuleFilter(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined
  }

  const patterns = (Array.isArray(value) ? value : [value])
    .flatMap(entry => entry.split(','))
    .map(entry => entry.trim())
    .filter(entry => entry !== '')

  if (patterns.length === 0) {
    throw new Error('--rule requires a rule id, a rule name, or a glob pattern.')
  }

  return [...new Set(patterns)]
}

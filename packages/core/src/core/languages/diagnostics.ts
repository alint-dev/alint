import type { Diagnostic } from '../types'

import { basename, extname } from 'pathe'

/*
 * The two language problems only a run can see, because both are about what the config assembled
 * rather than about any one file's contents. A plugin cannot report either for itself: a language
 * pack that is missing is not loaded to complain, and a rule cannot know which extensions the other
 * plugins claimed.
 *
 * Both are gathered while preparing files and rendered into the run's diagnostics.
 */

/** A rule named a language and nothing registered it. This is a builtin rule. Not a real rule. */
export const MISSING_LANGUAGE_RULE = 'alint/missing-language'

/** A linted file's extension belongs to no registered language. This is a builtin rule. Not a real rule either. */
export const UNREGISTERED_LANGUAGE_RULE = 'alint/unregistered-language'

export interface MissingLanguage {
  filePath: string
  ruleIds: Set<string>
}

export interface UnregisteredLanguage {
  count: number
  filePath: string
  severity: 'error' | 'warn'
}

/**
 * One diagnostic per missing language, always an error: a rule scoped to a language nothing provides
 * matches no file, so leaving it at a warning would let a run pass having silently checked nothing.
 */
export function missingLanguageDiagnostics(missing: ReadonlyMap<string, MissingLanguage>): Diagnostic[] {
  return [
    ...missing.entries(),
  ]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([languageId, entry]) => {
      const ruleIds = [...entry.ruleIds].sort()
      const subject = ruleIds.length === 1
        ? `Rule "${ruleIds[0]}" needs`
        : `Rules ${ruleIds.map(id => `"${id}"`).join(', ')} need`

      return {
        filePath: entry.filePath,
        message: `${subject} the "${languageId}" language, which no plugin registered. Add a plugin that provides "${languageId}", or turn the rule off.`,
        ruleId: MISSING_LANGUAGE_RULE,
        severity: 'error' as const,
      }
    })
}

/** Records one rule that named a language the config never registered, grouped by language id. */
export function recordMissingLanguage(
  into: Map<string, MissingLanguage>,
  languageId: string,
  ruleId: string,
  path: string,
): void {
  const existing = into.get(languageId)

  if (existing === undefined) {
    into.set(languageId, {
      filePath: path,
      ruleIds: new Set([ruleId]),
    })

    return
  }

  existing.ruleIds.add(ruleId)
  // Files prepare in list order; the smallest path keeps the anchor deterministic regardless.
  if (path < existing.filePath)
    existing.filePath = path
}

/**
 * Records one linted file no language claimed, grouped by extension so a missing pack is one
 * diagnostic, not one per file. `'off'` records nothing.
 */
export function recordUnregistered(
  into: Map<string, UnregisteredLanguage>,
  path: string,
  severity: 'error' | 'off' | 'warn',
): void {
  if (severity === 'off')
    return

  const key = extname(path) || basename(path)
  const existing = into.get(key)

  into.set(key, {
    count: (existing?.count ?? 0) + 1,
    // Files prepare in list order; the smallest path keeps the anchor deterministic regardless.
    filePath: existing !== undefined && existing.filePath < path
      ? existing.filePath
      : path,
    // Two config groups may set different severities for one extension; the stricter wins.
    severity: existing?.severity === 'error'
      ? 'error'
      : severity,
  })
}

/** One diagnostic per extension, sorted, for the run to prepend to its results. */
export function unregisteredLanguageDiagnostics(unregistered: ReadonlyMap<string, UnregisteredLanguage>): Diagnostic[] {
  return [
    ...unregistered.entries(),
  ]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([extension, entry]) => ({
      filePath: entry.filePath,
      message: `No language is registered for "${extension}": ${entry.count} ${entry.count === 1
        ? 'file was'
        : 'files were'} handled as plain text. Register one through a plugin's "languages", or pin \`language: 'plaintext'\` to accept plain text.`,
      ruleId: UNREGISTERED_LANGUAGE_RULE,
      severity: entry.severity,
    }))
}

export function unregisteredLanguageSeverity(linterOptions: Record<string, unknown>): 'error' | 'off' | 'warn' {
  const value = linterOptions.reportUnregisteredLanguages

  return value === 'error' || value === 'off'
    ? value
    : 'warn'
}

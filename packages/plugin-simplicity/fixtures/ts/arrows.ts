// The cases the `function` fixtures make, written the way a TypeScript codebase writes
// them. An arrow bound to a name is a declared helper, and it was invisible to both
// rules until the extractor captured the declarator that names it.

// A renamed match, in arrows: one helper written twice, with everything each copy
// declares renamed and nothing it calls. Two statements apiece, so neither is a
// `no-needless-helper` candidate.
// eslint-disable-next-line antfu/top-level-function
const trimLines = (text: string): string[] => {
  const lines = text.split('\n')

  return lines.map(line => line.trim()).filter(line => line !== '')
}

// eslint-disable-next-line antfu/top-level-function
const cleanRows = (raw: string): string[] => {
  const rows = raw.split('\n')

  return rows.map(row => row.trim()).filter(row => row !== '')
}

// Report. A pure forward: `String(value)` already says what `stringify(value)` says.
const stringify = (value: unknown): string => String(value)

// Stays silent, and this is the arrow a rule gets wrong. Inlining a type guard still
// runs the check, but the call site loses the type it narrowed to.
const isString = (value: unknown): value is string => typeof value === 'string'

// The consumer, so the judge is told each single-expression helper is called once. That
// makes `stringify` and `isString` alike in every fact the rule hands over, and the
// decisions still differ.
export function summarize(text: string, extra: string, value: unknown): string {
  const rows = [
    ...trimLines(text),
    ...cleanRows(extra),
  ]

  return `${rows.length}: ${isString(value)
    ? value
    : stringify(value)}`
}

import type { IndexedHelper } from '../../repo'

export const reinventedHelperPrompt = `
You review small local helpers. The repository already depends on the utility libraries listed below.
Find each helper that reimplements one export of these libraries.

Report a helper only when all of these are true:
- The helper is a general utility. It has no domain logic, and it does not read module state.
- One listed export has the same behavior for the inputs that the helper accepts.
- A caller can replace the helper with that export and keep the result.

Do not report a helper that adds a type guard, a default, an error message, or a domain rule that the export does not have.
Do not report a helper that already calls the export.
Use a library and an export name exactly as listed. If you are not sure that the export exists, do not report.
`.trim()

/** The libraries with their export names, then the helpers, each numbered so a finding can name the one it means. */
export function buildReinventedHelperPrompt(libraries: ReadonlyMap<string, readonly string[]>, candidates: readonly IndexedHelper[]): string {
  return [
    ...[...libraries].map(([library, names]) => `Exports of \`${library}\`:\n${names.join(', ')}`),
    ...candidates.map((helper, index) => `Helper ${index + 1}: \`${helper.name}\`\n${helper.text}`),
  ].join('\n\n')
}

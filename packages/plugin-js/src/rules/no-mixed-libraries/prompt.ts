export const mixedLibrariesPrompt = `
You review which external packages a repository imports.
Find groups of packages that solve the same problem, where the repository can standardize on one of them.

Report a group only when every member is a general-purpose library for the same job, and code that uses one member can use another member instead.
Typical jobs: schema validation, key-value storage, HTTP client, ID generation, mutex, dependency injection, color math, date formatting, archive handling, logging.

Do not report these cases:
- Packages that work together, such as a framework with its plugin, adapter, or type package.
- Packages that each serve a different runtime or a different product, when the package list shows that separation.
- Build tools, lint tools, test tools, and bundler plugins.
- Packages from one family that ship as separate modules, such as \`@xsai/*\` or \`@pixi/*\`.

For each group, name the canonical package. Prefer a package from the preferred list. If no member is preferred, prefer the member that most files import.
List each other member as an alternative, with one sentence that tells why the canonical package can replace it.
`.trim()

export function buildMixedLibrariesPrompt(preferred: readonly string[], usage: string): string {
  return [
    `Preferred packages: ${preferred.join(', ') || 'none'}`,
    `Packages, with the number of importing files and the packages that import them most:\n${usage}`,
  ].join('\n\n')
}

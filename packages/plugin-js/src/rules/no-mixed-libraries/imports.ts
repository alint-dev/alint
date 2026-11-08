import { isBuiltin } from 'node:module'

export interface PackageImport {
  /** One-based line of the import specifier. */
  line: number
  /** The package that owns the specifier, for example `@scope/name` for `@scope/name/sub`. */
  name: string
}

/*
 * A text scan rather than a parse: the rule needs only package names and lines, from every
 * JavaScript, TypeScript, and Vue file in the workspace, and a parser per language would cost
 * more than the whole review. It reads static imports, re-exports, side-effect imports, dynamic
 * imports, and `require` calls.
 */
const IMPORT_SPECIFIER = /\b(?:from|import|require)\s*(?:\(\s*)?(['"])([^'"\n]+)\1/g

/** Lists each external package that the source text imports, with the line of the import. */
export function extractPackageImports(text: string): PackageImport[] {
  const imports: PackageImport[] = []
  let line = 1
  let scanned = 0

  for (const match of text.matchAll(IMPORT_SPECIFIER)) {
    const name = packageNameFrom(match[2])
    if (name == null)
      continue

    for (; scanned < match.index; scanned++) {
      if (text[scanned] === '\n')
        line++
    }
    imports.push({ line, name })
  }

  return imports
}

/**
 * Normalizes an import specifier to the name of the external package that owns it.
 *
 * @example
 * packageNameFrom('@scope/package/subpath')
 * // => '@scope/package'
 * packageNameFrom('./local')
 * // => undefined
 */
export function packageNameFrom(specifier: string): string | undefined {
  // Relative paths, path aliases, and scheme imports such as `node:` or `virtual:` name no package.
  if (!/^(?:@[\w.-]+\/)?[a-z][\w.-]*(?:\/|$)/i.test(specifier) || isBuiltin(specifier))
    return undefined

  const segments = specifier.split('/')
  return specifier.startsWith('@')
    ? segments.slice(0, 2).join('/')
    : segments[0]
}

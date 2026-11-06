import type { CallSite, FunctionInfo, SourceTarget } from '../../source/types'

import { describe, expect, it } from 'vitest'

import { createSourceFile } from '../../source/runtime'
import { extractJsSourceTargets } from './extract'

/*
 * The info core attaches to a function target, which a rule reads instead of parsing for itself.
 *
 * tree-sitter produces the same contract for the languages core does not own, so the cases here are
 * the ones the two grammars are likeliest to disagree about; `plugin-simplicity`'s `parity.test.ts`
 * holds the two producers to the same answers over a whole corpus.
 */

function functionTargets(source: string): SourceTarget[] {
  return extractJsSourceTargets(createSourceFile('/project/src/demo.ts', source))
    .filter(target => target.kind === 'function')
}

function infoOf(source: string, name: string): FunctionInfo {
  const target = functionTargets(source).find(candidate => candidate.name === name)

  if (target === undefined) {
    throw new Error(`no function target named ${name}`)
  }

  return target.metadata?.function as FunctionInfo
}

/** The identifiers a copy may rename, read back as text. */
function renameableIn(source: string, name: string): string[] {
  const target = functionTargets(source).find(candidate => candidate.name === name)
  const info = target?.metadata?.function as FunctionInfo

  return info.identifierRanges.map(range => target?.text.slice(range.start, range.end) ?? '')
}

describe('function info', () => {
  it('names what the function declares, and nothing it calls', () => {
    const info = infoOf('function walkFiles(root: string): string[] {\n  const entries = readDir(root)\n  return entries\n}', 'walkFiles')

    expect(info.declaredNames).toContain('walkFiles')
    expect(info.declaredNames).toContain('root')
    expect(info.declaredNames).toContain('entries')
    expect(info.declaredNames).not.toContain('readDir')
  })

  // A parameter's `Identifier` node spans its type annotation, so a naive range would replace the
  // type along with the parameter name.
  it('keeps a type annotation out of a parameter identifier', () => {
    expect(renameableIn('function f(entry: Entry): string {\n  return entry.name\n}', 'f'))
      .toStrictEqual(['f', 'entry', 'entry'])
  })

  // Replace a property name and `entry.name` and `entry.size` hash alike, which is the mistake the
  // renameable set exists to avoid.
  it('never treats a property, a key or a type as renameable', () => {
    expect(renameableIn('function f(entry: Entry): unknown {\n  return read(entry.name, { key: 1 })\n}', 'f'))
      .toStrictEqual(['f', 'entry', 'read', 'entry'])
  })

  it('treats a computed member as the real identifier it is', () => {
    expect(renameableIn('function f(store: S, key: string): unknown {\n  return store[key]\n}', 'f'))
      .toStrictEqual(['f', 'store', 'key', 'store', 'key'])
  })

  // `error is NodeJS.ErrnoException` names the parameter, and a renamed copy renames it there too,
  // so the predicate's subject has to be replaced with the parameter or the copy stops matching.
  it('replaces the subject of a type predicate', () => {
    // `Error` is renameable-shaped and simply never renamed: it is not a name this function
    // declares, so it is not in `declaredNames` and survives the fingerprint verbatim.
    expect(renameableIn('function isNodeError(error: unknown): error is NodeJS.ErrnoException {\n  return error instanceof Error\n}', 'isNodeError'))
      .toStrictEqual([
        'isNodeError',
        'error',
        'error',
        'error',
        'Error',
      ])
  })

  // In `const { title } = doc` one token is both the property read and the local declared. Filing it
  // as a declared name replaces it, and then two accessors of different properties hash alike.
  it('treats a destructured property as neither a declared name nor renameable', () => {
    const source = 'function readTitle(doc: Doc): string {\n  const { title } = doc\n  return title\n}'

    expect(infoOf(source, 'readTitle').declaredNames).not.toContain('title')
    // The `title` here is the one `return title` reads. The token inside `{ title }` is absent, and
    // that is the point: it is the property read as much as the local, so it is left alone.
    expect(renameableIn(source, 'readTitle')).toStrictEqual(['readTitle', 'doc', 'doc', 'title'])
  })

  it('binds a renamed destructured property, which is a local a copy may rename', () => {
    expect(infoOf('function f(doc: Doc): string {\n  const { title: own } = doc\n  return own\n}', 'f').declaredNames)
      .toStrictEqual(['f', 'doc', 'own'])
  })

  it('counts body statements without counting comments', () => {
    const info = infoOf('function nameLength(entry: Entry): number {\n  // The name\'s length.\n  return entry.name.length\n}', 'nameLength')

    expect(info.bodyStatements).toBe(1)
    expect(info.bodyIsSingleExpression).toBe(true)
    expect(info.commentRanges).toHaveLength(1)
  })

  it('does not call a body holding a branch a single expression', () => {
    const info = infoOf('function f(v: unknown): string {\n  if (!v) {\n    return \'\'\n  }\n  return String(v)\n}', 'f')

    expect(info.bodyStatements).toBe(2)
    expect(info.bodyIsSingleExpression).toBe(false)
  })

  it('counts an arrow expression body as one expression', () => {
    const info = infoOf('const stringify = (value: unknown): string => String(value)', 'stringify')

    expect(info.bodyStatements).toBe(1)
    expect(info.bodyIsSingleExpression).toBe(true)
  })

  it('marks a function exported however the file spells it', () => {
    const source = [
      'export function inline() { return 1 }',
      'function listed() { return 2 }',
      'function aliased() { return 3 }',
      'function hidden() { return 4 }',
      'export { listed }',
      'export { aliased as renamed }',
    ].join('\n')

    expect(infoOf(source, 'inline').exported).toBe(true)
    expect(infoOf(source, 'listed').exported).toBe(true)
    // The alias is what the outside calls it; the local name is still reachable.
    expect(infoOf(source, 'aliased').exported).toBe(true)
    expect(infoOf(source, 'hidden').exported).toBe(false)
  })
})

describe('file info', () => {
  it('reports every call in the file by its last segment', () => {
    const targets = extractJsSourceTargets(createSourceFile('/project/src/demo.ts', [
      'readDir(root)',
      'function f() {',
      '  return entries.map(trim).filter(Boolean)',
      '}',
    ].join('\n')))
    const calls = targets[0].metadata?.calls as CallSite[]

    // Including `readDir`, which no function holds: a count of how often a name is used has to see
    // the calls made at the top level too.
    expect(calls.map(call => call.name)).toStrictEqual(['readDir', 'map', 'filter'])
  })
})

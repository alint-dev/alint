import type { CallSite, FunctionInfo, SourceFile, SourceRange, SourceTarget } from '@alint-js/core'

import type { LanguageId } from './grammar'

import Parser from 'web-tree-sitter'

import { sliceRange, targetIdentity, withStableIdentities } from '@alint-js/core'

import { grammarFor, isLanguageId } from './grammar'
import { QUERIES } from './queries'

const queries = new Map<LanguageId, Parser.Query>()

/**
 * One file target holding every call site, then one function target per function. Each function
 * target carries a `FunctionInfo`, so a consumer can fingerprint or classify it without parsing
 * anything itself.
 *
 * The language is read off the file rather than passed in as an argument. Every target carries that
 * same file, so an argument could only ever contradict it. Stamp the file with `withLanguage` first.
 */
export async function extractTargets(file: SourceFile): Promise<SourceTarget[]> {
  if (!isLanguageId(file.language)) {
    throw new Error(`Language "${file.language}" is not provided by @alint-js/languages.`)
  }

  const language = file.language
  const grammar = await grammarFor(language)

  const parser = new Parser()
  parser.setLanguage(grammar)
  const tree = parser.parse(file.text)

  let query = queries.get(language)
  if (query === undefined) {
    query = grammar.query(QUERIES[language])
    queries.set(language, query)
  }

  const calls: CallSite[] = []
  const comments: SourceRange[] = []
  const identifiers: SourceRange[] = []
  const anchored = new Set<number>()
  const binders: Parser.SyntaxNode[] = []
  const functionNodes: Parser.SyntaxNode[] = []

  for (const { name, node } of query.captures(tree.rootNode)) {
    switch (name) {
      case 'anchor':
        anchored.add(node.startIndex)
        break
      case 'binder':
        binders.push(node)
        break
      case 'call':
        calls.push({
          name: node.text,
          range: rangeOf(node),
        })
        break
      case 'comment':
        comments.push(rangeOf(node))
        break
      case 'function':
        functionNodes.push(node)
        break
      case 'identifier':
        identifiers.push(rangeOf(node))
        break
    }
  }

  const renameable = identifiers.filter(range => !anchored.has(range.start))
  const commentStarts = new Set(comments.map(range => range.start))

  const functionTargets = functionNodes.map(node =>
    functionTarget(node, file, language, comments, commentStarts, renameable, binders),
  )

  return [
    fileTarget(file, calls),
    ...withStableIdentities(functionTargets),
  ]
}

/**
 * The body's statements, comments left out.
 *
 * All three grammars make a comment a named child of the block it sits in, so comments have to be
 * filtered out here. Leave them in and adding a comment to a one-line function makes it look two
 * statements long.
 */
function bodyStatements(node: Parser.SyntaxNode, commentStarts: ReadonlySet<number>): Parser.SyntaxNode[] {
  const body = node.childForFieldName('body')

  if (body === null) {
    return []
  }

  const statements: Parser.SyntaxNode[] = []

  for (let index = 0; index < body.namedChildCount; index += 1) {
    const child = body.namedChild(index)

    if (child !== null && !commentStarts.has(child.startIndex)) {
      statements.push(child)
    }
  }

  return statements
}

function fileTarget(file: SourceFile, calls: readonly CallSite[]): SourceTarget {
  return {
    file,
    identity: 'file',
    kind: 'file',
    language: file.language,
    metadata: {
      calls,
    },
    origin: {
      physicalPath: file.path,
    },
    text: file.text,
  }
}

function functionTarget(
  node: Parser.SyntaxNode,
  file: SourceFile,
  language: LanguageId,
  comments: readonly SourceRange[],
  commentStarts: ReadonlySet<number>,
  identifiers: readonly SourceRange[],
  binders: readonly Parser.SyntaxNode[],
): SourceTarget {
  const range = rangeOf(node)
  const source = sliceRange(file, range)
  const nameNode = node.childForFieldName('name')
  const name = nameNode?.text
  const statements = bodyStatements(node, commentStarts)
  const exported = isExported(node, language, name ?? '')

  const info: FunctionInfo = {
    // Stricter than a one-statement body: a lone `if` with two returns is one statement, but it is
    // not one expression.
    bodyIsSingleExpression: statements.length === 1 && !holdsBlock(statements[0]),
    bodyStatements: statements.length,
    commentRanges: rangesInside(comments, range),
    declaredNames: [
      ...new Set([
        ...binders
          .filter(binder => binder.startIndex >= range.start && binder.endIndex <= range.end)
          .map(binder => binder.text),
        ...(name === undefined
          ? []
          : [name]),
      ]),
    ],
    exported,
    identifierRanges: withOwnName(rangesInside(identifiers, range), nameNode, range),
  }

  return {
    file,
    identity: targetIdentity('function', name, range),
    kind: 'function',
    language: file.language,
    loc: source.loc,
    metadata: {
      exported,
      function: info,
    },
    name,
    origin: {
      physicalPath: file.path,
      range,
    },
    range,
    text: source.text,
  }
}

/** Whether anything under this node is a block, which is how all three grammars write a branch or a loop. */
function holdsBlock(node: Parser.SyntaxNode): boolean {
  const pending = [...node.namedChildren]

  while (pending.length > 0) {
    const next = pending.pop()

    if (next === undefined) {
      continue
    }

    if (next.type === 'block') {
      return true
    }

    pending.push(...next.namedChildren)
  }

  return false
}

/** Reachable from outside its file: a capital in Go, no leading underscore in Python, `pub` in Rust. */
function isExported(node: Parser.SyntaxNode, language: LanguageId, name: string): boolean {
  switch (language) {
    case 'go':
      return /^[A-Z]/.test(name)
    case 'python':
      return !name.startsWith('_')
    case 'rust':
      return node.children.some(child => child.type === 'visibility_modifier')
  }
}

/** `web-tree-sitter` counts in JavaScript string indexes, not UTF-8 bytes, so `text.slice(start, end)` is correct. */
function rangeOf(node: Parser.SyntaxNode): SourceRange {
  return { end: node.endIndex, start: node.startIndex }
}

/** Turns absolute file offsets into offsets within the function's own `text`, as `FunctionInfo` documents. */
function rangesInside(ranges: readonly SourceRange[], outer: SourceRange): SourceRange[] {
  return ranges
    .filter(range => range.start >= outer.start && range.end <= outer.end)
    .map(range => ({ end: range.end - outer.start, start: range.start - outer.start }))
}

/**
 * Adds the function's own name to its renameable identifiers.
 *
 * In practice this only matters for Go methods, whose name is a `field_identifier`. The Go query
 * skips `field_identifier` on purpose: a consumer that replaces renameable names would otherwise
 * make `entry.name` and `entry.size` look identical. A method's own name is safe to replace. Every
 * other name the queries capture is already an `@identifier`, so the dedupe by start offset drops
 * the duplicate.
 */
function withOwnName(
  ranges: SourceRange[],
  nameNode: null | Parser.SyntaxNode,
  outer: SourceRange,
): SourceRange[] {
  if (nameNode === null) {
    return ranges
  }

  const name: SourceRange = {
    end: nameNode.endIndex - outer.start,
    start: nameNode.startIndex - outer.start,
  }

  if (ranges.some(range => range.start === name.start)) {
    return ranges
  }

  return [...ranges, name].sort((left, right) => left.start - right.start)
}

import type { CallSite, FunctionInfo, SourceRange } from '../../source/types'
import type { AstNode } from './ast'

import { asAstNode, childNodes, getRange, isAstNode } from './ast'

/**
 * Ranges are absolute into the file's text; `functionInfo` rebases them onto a target.
 *
 * Identifiers and declared names are keyed by start offset, which removes duplicates where the parser
 * reports one token twice: in `export { readName }` that single token is reported as both the
 * specifier's `local` and its `exported`.
 */
export interface SourceInfo {
  calls: CallSite[]
  commentRanges: SourceRange[]
  declaredNames: Map<number, string>
  identifierRanges: Map<number, SourceRange>
}

/*
 * This file builds `FunctionInfo` for JavaScript and TypeScript. Every identifier decision in it
 * follows one rule: a copy may rename the names a function declares, never the names it refers to.
 * Callees, globals, types and properties stay verbatim, because they are what tells two same-shaped
 * functions apart. `FunctionInfo.declaredNames` states it in full.
 *
 * `@alint-js/languages` builds the same type for Go, Python and Rust, parsing with tree-sitter
 * where this file uses oxc. The comments below compare the two parsers case by case, because a
 * field they fill in differently would mean two things depending on which one ran.
 */

/**
 * A `TS…` node is a type, and a type is never renameable, so the subtree is skipped — that drops
 * annotations, interfaces and type aliases under one rule. tree-sitter needs no such rule: its
 * grammar gives type names their own node type, `type_identifier`, separate from `identifier`.
 *
 * These few `TS…` nodes wrap real code, so they are walked at the named field and nowhere else.
 */
const TS_INNER_FIELD: Record<string, string> = {
  TSAsExpression: 'expression',
  TSInstantiationExpression: 'expression',
  TSNonNullExpression: 'expression',
  TSParameterProperty: 'parameter',
  TSSatisfiesExpression: 'expression',
  // Not code itself, but a type predicate hides under one and does name a parameter. Every other
  // type it wraps is a `TS…` node with no inner field, so it stops one step further down.
  TSTypeAnnotation: 'typeAnnotation',
  TSTypeAssertion: 'expression',
}

export function collectSourceInfo(program: AstNode, comments: readonly unknown[]): SourceInfo {
  const info: SourceInfo = {
    calls: [],
    commentRanges: [],
    declaredNames: new Map(),
    identifierRanges: new Map(),
  }

  for (const comment of comments) {
    const range = isAstNode(comment)
      ? getRange(comment)
      : undefined

    if (range) {
      info.commentRanges.push(range)
    }
  }

  walk(program, info)

  // Source order, because the walk reaches an outer call before the inner one it is chained onto:
  // `entries.map(trim).filter(Boolean)` is walked filter-first. tree-sitter reports its captures in
  // source order, and two producers of one contract should not hand back the same info differently.
  info.calls.sort((left, right) => left.range.start - right.range.start)

  return info
}

/**
 * `name` is resolved by the caller, because a function may be named by something outside itself:
 * `const trim = () => {}` names the arrow from its declarator.
 */
export function functionInfo(
  node: AstNode,
  range: SourceRange,
  name: string | undefined,
  exported: boolean,
  info: SourceInfo,
): FunctionInfo {
  const { arrowExpression, statements } = bodyOf(node)

  const declaredNames = new Set<string>(
    [...info.declaredNames]
      .filter(([start]) => start >= range.start && start < range.end)
      .sort(([left], [right]) => left - right)
      .map(([, name]) => name),
  )

  // A function's own name is renameable: a copy renames it and stays a copy. It may sit outside the
  // target's own text (an arrow's name lives on its declarator), and then it only matters when the
  // body mentions it — a recursive call.
  if (name !== undefined) {
    declaredNames.add(name)
  }

  return {
    bodyIsSingleExpression: arrowExpression || (statements.length === 1 && !holdsBlock(statements[0])),
    bodyStatements: statements.length,
    commentRanges: rangesInside(info.commentRanges, range),
    declaredNames: [...declaredNames],
    exported,
    identifierRanges: withOwnName(rangesInside([
      ...info.identifierRanges.values(),
    ], range), node, range),
  }
}

function asNodeList(value: unknown): AstNode[] {
  return Array.isArray(value)
    ? value.filter(isAstNode)
    : []
}

function bodyOf(node: AstNode): { arrowExpression: boolean, statements: AstNode[] } {
  // A method holds its parameters and body on the function expression under it, not on itself.
  const callable = (node.type === 'MethodDefinition'
    ? asAstNode(node.value)
    : undefined) ?? node
  const body = asAstNode(callable.body)

  if (!body) {
    return { arrowExpression: false, statements: [] }
  }

  // `=> String(value)` is a bare expression, and the whole helper is that expression.
  if (callable.type === 'ArrowFunctionExpression' && body.type !== 'BlockStatement') {
    return {
      arrowExpression: true,
      statements: [body],
    }
  }

  return {
    arrowExpression: false,
    statements: asNodeList(body.body),
  }
}

function callSiteOf(node: AstNode): CallSite | undefined {
  const callee = asAstNode(node.callee)

  if (!callee) {
    return undefined
  }

  if (callee.type === 'Identifier') {
    const range = nameRangeOf(callee)

    return range && callee.name !== undefined
      ? { name: callee.name, range }
      : undefined
  }

  // A computed call (`handlers[key]()`) names nothing a reader could count, and tree-sitter's query
  // does not capture one either.
  if (callee.type !== 'MemberExpression' || callee.computed === true) {
    return undefined
  }

  const property = asAstNode(callee.property)
  const range = property
    ? nameRangeOf(property)
    : undefined

  return range && property?.name !== undefined
    ? { name: property.name, range }
    : undefined
}

/** A nested block is how a branch or a loop is written, so it disqualifies a single-expression body. */
function holdsBlock(node: AstNode | undefined): boolean {
  if (!node) {
    return false
  }

  const pending = childNodes(node)

  while (pending.length > 0) {
    const next = pending.pop()

    if (next === undefined) {
      continue
    }

    if (next.type === 'BlockStatement') {
      return true
    }

    pending.push(...childNodes(next))
  }

  return false
}

/**
 * An identifier node spans its type annotation: `entry: Entry` is one `Identifier` whose `name` is
 * `entry`. The annotation has to be cut back off, or replacing the identifier would take the type
 * with it and a copy that renamed nothing but its parameter would stop matching.
 *
 * NOTICE: `name` is the DECODED identifier, so one written with a unicode escape measures shorter
 * than the token it came from and this range cuts inside it, where tree-sitter reports the whole
 * token — the two extractors disagree for such identifiers. Left as is because a correct fix needs
 * the parser to report the name's own span. Removal condition: oxc exposes that span.
 */
function nameRangeOf(node: AstNode): SourceRange | undefined {
  const range = getRange(node)

  if (!range || typeof node.name !== 'string') {
    return undefined
  }

  return {
    end: Math.min(range.end, range.start + node.name.length),
    start: range.start,
  }
}

/*
 * Sorted rather than left in the order the walk found them: the walk follows the parser's field
 * order, not source order, and tree-sitter reports its captures in source order. Fingerprinting
 * re-sorts anyway, so this is for the contract's sake, not the hash's.
 */
function rangesInside(ranges: readonly SourceRange[], outer: SourceRange): SourceRange[] {
  return ranges
    .filter(range => range.start >= outer.start && range.end <= outer.end)
    .map(range => ({ end: range.end - outer.start, start: range.start - outer.start }))
    .sort((left, right) => left.start - right.start)
}

function recordDeclared(node: AstNode, info: SourceInfo): void {
  const range = nameRangeOf(node)

  if (range && node.name !== undefined) {
    info.declaredNames.set(range.start, node.name)
  }
}

function recordIdentifier(node: AstNode, info: SourceInfo): void {
  const range = nameRangeOf(node)

  if (range) {
    info.identifierRanges.set(range.start, range)
  }
}

function recordPatternNames(node: AstNode | undefined, info: SourceInfo): void {
  if (!node) {
    return
  }

  switch (node.type) {
    case 'ArrayPattern':
      for (const element of asNodeList(node.elements)) {
        recordPatternNames(element, info)
      }

      break
    case 'AssignmentPattern':
      // `(a = 1)` declares `a`; the default is an expression and is walked as one.
      recordPatternNames(asAstNode(node.left), info)
      break
    case 'Identifier':
      recordDeclared(node, info)
      break
    case 'ObjectPattern':
      for (const property of asNodeList(node.properties)) {
        if (property.type === 'RestElement') {
          recordPatternNames(asAstNode(property.argument), info)
        }
        // PITFALL: a shorthand pattern is deliberately not a declared name. In `const { title } = entry`
        // that one token is both the property read and the local declared, so replacing it makes
        // `{ title }` and `{ author }` accessors fingerprint alike.
        else if (!property.shorthand) {
          recordPatternNames(asAstNode(property.value), info)
        }
      }

      break
    case 'RestElement':
      recordPatternNames(asAstNode(node.argument), info)
      break
  }
}

function walk(node: AstNode, info: SourceInfo): void {
  const type = node.type ?? ''

  // `value is string`: the predicate's subject is a plain identifier naming a parameter, and a
  // renamed copy renames it there too, so it is replaced with the parameter. tree-sitter agrees —
  // in its `type_predicate` the name is a plain `identifier`, not a `type_identifier`.
  if (type === 'TSTypePredicate') {
    const parameterName = asAstNode(node.parameterName)

    if (parameterName) {
      recordIdentifier(parameterName, info)
    }

    return
  }

  if (type.startsWith('TS')) {
    const inner = asAstNode(node[TS_INNER_FIELD[type] ?? ''])

    if (inner) {
      walk(inner, info)
    }

    return
  }

  switch (type) {
    case 'ArrowFunctionExpression':
    case 'FunctionDeclaration':
    case 'FunctionExpression':
      recordPatternNames(asAstNode(node.id), info)

      for (const parameter of asNodeList(node.params)) {
        recordPatternNames(parameter, info)
      }

      break
    case 'CallExpression': {
      const call = callSiteOf(node)

      if (call) {
        info.calls.push(call)
      }

      break
    }
    case 'CatchClause':
      recordPatternNames(asAstNode(node.param), info)
      break
    case 'Identifier':
      recordIdentifier(node, info)
      // An identifier's only child is its type annotation, which the `TS…` rule drops anyway.
      return
    case 'MemberExpression': {
      const object = asAstNode(node.object)

      if (object) {
        walk(object, info)
      }

      // `a.name` names a property, which is never renameable; `a[name]` reads a real identifier.
      if (node.computed === true) {
        const property = asAstNode(node.property)

        if (property) {
          walk(property, info)
        }
      }

      return
    }
    case 'MethodDefinition':
    case 'Property':
    case 'PropertyDefinition': {
      // A shorthand property is the destructuring pitfall above, seen from the other side: one
      // token acting as both the key and the value. tree-sitter gives it a node type of its own and
      // captures neither, so neither is recorded here.
      if (node.shorthand === true) {
        return
      }

      if (node.computed === true) {
        const key = asAstNode(node.key)

        if (key) {
          walk(key, info)
        }
      }

      const value = asAstNode(node.value)

      if (value) {
        walk(value, info)
      }

      return
    }
    case 'VariableDeclarator':
      recordPatternNames(asAstNode(node.id), info)
      break
  }

  for (const child of childNodes(node)) {
    walk(child, info)
  }
}

/**
 * A method's name is a key, which the walk keeps out of the identifier set, so it is put back here.
 * A declared function's name is already there, hence the dedupe by start offset.
 */
function withOwnName(ranges: SourceRange[], node: AstNode, outer: SourceRange): SourceRange[] {
  const nameNode = asAstNode(node.id) ?? (node.type === 'MethodDefinition'
    ? asAstNode(node.key)
    : undefined)
  const name = nameNode
    ? nameRangeOf(nameNode)
    : undefined

  if (!name || name.start < outer.start || name.end > outer.end) {
    return ranges
  }

  const rebased = { end: name.end - outer.start, start: name.start - outer.start }

  if (ranges.some(range => range.start === rebased.start)) {
    return ranges
  }

  return [...ranges, rebased].sort((left, right) => left.start - right.start)
}

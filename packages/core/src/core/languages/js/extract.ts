import type { SourceFile, SourceTarget } from '../../source/types'
import type { AstNode } from './ast'
import type { SourceInfo } from './info'

import { targetIdentity, withStableIdentities } from '../../source/identity'
import { sliceRange } from '../../source/runtime'
import { asAstNode, getRange, isAstNode } from './ast'
import { collectSourceInfo, functionInfo } from './info'
import { parseSync } from './parser'

interface VisitState {
  bindingNodes: Map<string, AstNode>
  exportedNodes: Set<AstNode>
  file: SourceFile
  inferredNames: Map<AstNode, string>
  info: SourceInfo
  seenClasses: Set<AstNode>
  seenFunctions: Set<AstNode>
  targets: SourceTarget[]
  visited: Set<AstNode>
}

export function extractJsSourceTargets(file: SourceFile): SourceTarget[] {
  const result = parseSync(file.path, file.text, {
    sourceType: 'module',
  })
  const program = result.program as unknown as AstNode
  const state: VisitState = {
    bindingNodes: new Map(),
    exportedNodes: new Set(),
    file,
    inferredNames: new Map(),
    info: collectSourceInfo(program, result.comments),
    seenClasses: new Set(),
    seenFunctions: new Set(),
    targets: [],
    visited: new Set(),
  }

  collectModuleBindings(program, state)
  collectExportedBindings(program, state)
  visit(program, state)

  const sortedTargets = [...state.targets].sort((left, right) => (left.range?.start ?? 0) - (right.range?.start ?? 0))

  return [
    createFileTarget(file, state.info),
    ...withStableIdentities(sortedTargets),
  ]
}

function addClassTarget(node: AstNode, state: VisitState): void {
  if (state.seenClasses.has(node)) {
    return
  }

  const target = createClassTarget(node, state)

  if (!target) {
    return
  }

  state.seenClasses.add(node)
  state.targets.push(target)
}

function addFunctionTarget(node: AstNode, state: VisitState): void {
  if (state.seenFunctions.has(node)) {
    return
  }

  const target = createFunctionTarget(node, state)

  if (!target) {
    return
  }

  state.seenFunctions.add(node)
  state.targets.push(target)
}

function collectDeclarationBindings(node: AstNode, state: VisitState): void {
  const name = getNodeName(node)

  if (name && (isClassNode(node) || isFunctionNode(node))) {
    state.bindingNodes.set(name, node)
    return
  }

  if (node.type !== 'VariableDeclaration' || !Array.isArray(node.declarations)) {
    return
  }

  for (const declarator of node.declarations) {
    if (!isAstNode(declarator)) {
      continue
    }

    const id = asAstNode(declarator.id)
    const initializer = asAstNode(declarator.init)

    if (typeof id?.name === 'string' && initializer && (isClassNode(initializer) || isFunctionNode(initializer))) {
      state.bindingNodes.set(id.name, initializer)
    }
  }
}

function collectExportedBindings(node: AstNode | AstNode[] | null | undefined, state: VisitState): void {
  if (!node) {
    return
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      collectExportedBindings(child, state)
    }

    return
  }

  if (node.type === 'ExportNamedDeclaration' && !node.source && Array.isArray(node.specifiers)) {
    for (const specifier of node.specifiers) {
      if (!isAstNode(specifier) || specifier.type !== 'ExportSpecifier') {
        continue
      }

      const local = asAstNode(specifier.local)

      if (typeof local?.name === 'string') {
        markExportedBinding(local.name, state)
      }
    }
  }
  else if (node.type === 'ExportDefaultDeclaration') {
    const declaration = asAstNode(node.declaration)

    if (typeof declaration?.name === 'string') {
      markExportedBinding(declaration.name, state)
    }
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      collectExportedBindings(value.filter(isAstNode), state)
    }
    else if (isAstNode(value)) {
      collectExportedBindings(value, state)
    }
  }
}

function collectModuleBindings(program: AstNode, state: VisitState): void {
  if (!Array.isArray(program.body)) {
    return
  }

  for (const statement of program.body) {
    if (!isAstNode(statement)) {
      continue
    }

    const declaration = isExportDeclaration(statement)
      ? asAstNode(statement.declaration)
      : statement

    if (declaration) {
      collectDeclarationBindings(declaration, state)
    }
  }
}

function createClassTarget(node: AstNode, state: VisitState): SourceTarget | undefined {
  const range = getRange(node)

  if (!range) {
    return undefined
  }

  const source = sliceRange(state.file, range)
  const name = getNodeName(node) ?? state.inferredNames.get(node)

  return {
    file: state.file,
    identity: targetIdentity('class', name, range),
    kind: 'class',
    language: state.file.language,
    loc: source.loc,
    metadata: {
      exported: isExportedTarget(node, state),
    },
    name,
    origin: {
      physicalPath: state.file.path,
      range,
    },
    range,
    text: source.text,
  }
}

function createFileTarget(file: SourceFile, info: SourceInfo): SourceTarget {
  return {
    file,
    identity: 'file',
    kind: 'file',
    language: file.language,
    metadata: {
      calls: info.calls,
    },
    origin: {
      physicalPath: file.path,
    },
    text: file.text,
  }
}

function createFunctionTarget(node: AstNode, state: VisitState): SourceTarget | undefined {
  const range = getRange(node)

  if (!range) {
    return undefined
  }

  const source = sliceRange(state.file, range)
  const functionNode = node.type === 'MethodDefinition'
    ? asAstNode(node.value)
    : node
  const name = getNodeName(node) ?? getNodeName(functionNode) ?? state.inferredNames.get(node)
  const exported = isExportedTarget(node, state)

  return {
    file: state.file,
    identity: targetIdentity('function', name, range),
    kind: 'function',
    language: state.file.language,
    loc: source.loc,
    metadata: {
      async: functionNode?.async === true,
      exported,
      function: functionInfo(node, range, name, exported, state.info),
    },
    name,
    origin: {
      physicalPath: state.file.path,
      range,
    },
    range,
    text: source.text,
  }
}

function getNodeName(node: AstNode | null | undefined): string | undefined {
  if (!node) {
    return undefined
  }

  if (typeof node.name === 'string') {
    return node.name
  }

  const id = asAstNode(node.id)

  if (typeof id?.name === 'string') {
    return id.name
  }

  const key = asAstNode(node.key)

  if (typeof key?.name === 'string') {
    return key.name
  }

  if (typeof key?.value === 'string' || typeof key?.value === 'number') {
    return String(key.value)
  }

  return undefined
}

function inferChildName(parent: AstNode, key: string, child: AstNode, state: VisitState): void {
  if (state.inferredNames.has(child)) {
    return
  }

  if (parent.type === 'VariableDeclarator' && key === 'init') {
    const id = asAstNode(parent.id)

    if (typeof id?.name === 'string') {
      state.inferredNames.set(child, id.name)
    }
  }

  if (parent.type === 'Property' && key === 'value') {
    const name = getNodeName(parent)

    if (name) {
      state.inferredNames.set(child, name)
    }
  }
}

function isClassNode(node: AstNode): boolean {
  return node.type === 'ClassDeclaration' || node.type === 'ClassExpression'
}

function isExportDeclaration(node: AstNode): boolean {
  return node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration'
}

function isExportedTarget(node: AstNode, state: VisitState): boolean {
  return state.exportedNodes.has(node)
}

function isFunctionNode(node: AstNode): boolean {
  return node.type === 'ArrowFunctionExpression'
    || node.type === 'FunctionDeclaration'
    || node.type === 'FunctionExpression'
}

function markExportedBinding(name: string, state: VisitState): void {
  const bindingNode = state.bindingNodes.get(name)

  if (bindingNode) {
    state.exportedNodes.add(bindingNode)
  }
}

function markExportedDeclaration(node: AstNode, state: VisitState): void {
  state.exportedNodes.add(node)

  if (node.type !== 'VariableDeclaration' || !Array.isArray(node.declarations)) {
    return
  }

  for (const declarator of node.declarations) {
    if (!isAstNode(declarator)) {
      continue
    }

    const initializer = asAstNode(declarator.init)

    if (initializer && (isClassNode(initializer) || isFunctionNode(initializer))) {
      state.exportedNodes.add(initializer)
    }
  }
}

function visit(node: AstNode | AstNode[] | null | undefined, state: VisitState): void {
  if (!node) {
    return
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      visit(child, state)
    }

    return
  }

  if (state.visited.has(node)) {
    return
  }

  state.visited.add(node)

  if (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration') {
    if (node.declaration) {
      markExportedDeclaration(node.declaration, state)
      visit(node.declaration, state)
    }

    visitChildren(node, state, new Set(['declaration']))
    return
  }

  if (isClassNode(node)) {
    addClassTarget(node, state)
  }
  else if (isFunctionNode(node) || node.type === 'MethodDefinition') {
    addFunctionTarget(node, state)

    const methodValue = node.type === 'MethodDefinition'
      ? asAstNode(node.value)
      : undefined

    if (methodValue) {
      state.seenFunctions.add(methodValue)
    }
  }

  visitChildren(node, state)
}

function visitChildren(node: AstNode, state: VisitState, skippedKeys = new Set<string>()): void {
  for (const [key, value] of Object.entries(node)) {
    if (skippedKeys.has(key) || key === 'type' || key === 'start' || key === 'end' || key === 'range') {
      continue
    }

    if (Array.isArray(value)) {
      for (const child of value) {
        if (isAstNode(child)) {
          inferChildName(node, key, child, state)
          visit(child, state)
        }
      }
    }
    else if (isAstNode(value)) {
      inferChildName(node, key, value, state)
      visit(value, state)
    }
  }
}

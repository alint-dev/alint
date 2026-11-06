import type { SourceRange } from '../../source/types'

/**
 * The shape of an oxc ESTree node, as much of it as this package reads.
 *
 * The parser hands back plain JSON, so every field is optional and narrowed on read rather than
 * typed up front: a node's real shape depends on its `type`, and modelling that union buys nothing
 * for the handful of fields the extractor touches.
 */
export interface AstNode {
  [key: string]: unknown
  async?: boolean
  computed?: boolean
  declaration?: AstNode | null
  end?: number
  id?: AstNode | null
  key?: AstNode | null
  name?: string
  range?: [number, number]
  shorthand?: boolean
  start?: number
  type?: string
}

export function asAstNode(value: unknown): AstNode | undefined {
  return isAstNode(value)
    ? value
    : undefined
}

export function childNodes(node: AstNode): AstNode[] {
  const children: AstNode[] = []

  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'range') {
      continue
    }

    if (Array.isArray(value)) {
      children.push(...value.filter(isAstNode))
    }
    else if (isAstNode(value)) {
      children.push(value)
    }
  }

  return children
}

export function getRange(node: AstNode): SourceRange | undefined {
  if (typeof node.start === 'number' && typeof node.end === 'number') {
    return {
      end: node.end,
      start: node.start,
    }
  }

  if (Array.isArray(node.range) && node.range.length === 2) {
    return {
      end: node.range[1],
      start: node.range[0],
    }
  }

  return undefined
}

export function isAstNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as AstNode).type === 'string'
}

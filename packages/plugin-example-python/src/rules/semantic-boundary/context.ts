import type { RuleContext } from '@alint-js/plugin'

import { readdir } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'

const maxContextSymbols = 18

export async function collectPythonSemanticBoundaryContext(
  ctx: RuleContext,
  filePath: string,
  source: string,
): Promise<string | undefined> {
  const symbols = extractPythonDeclarationSymbols(source).slice(0, maxContextSymbols)
  const packageFiles = await listNearbyPythonFiles(filePath)
  const sections: string[] = []

  if (packageFiles.length > 0) {
    sections.push([
      'Nearby Python files:',
      ...packageFiles.map(path => `- ${relative(ctx.cwd, path)}`),
    ].join('\n'))
  }

  if (symbols.length > 0) {
    sections.push([
      'Declarations to consider as responsibility owners:',
      symbols.map(symbol => `${symbol.name} on line ${symbol.line}`).join(', '),
    ].join('\n'))
  }

  return sections.length > 0
    ? sections.join('\n\n')
    : undefined
}

function declarationName(line: string): string | undefined {
  if (line.startsWith('class ')) {
    return readIdentifierAfterPrefix(line, 'class ')
  }

  if (line.startsWith('def ')) {
    return readIdentifierAfterPrefix(line, 'def ')
  }

  if (line.startsWith('async def ')) {
    return readIdentifierAfterPrefix(line, 'async def ')
  }

  return undefined
}

function extractPythonDeclarationSymbols(source: string): Array<{ line: number, name: string }> {
  const symbols: Array<{ line: number, name: string }> = []
  const seen = new Set<string>()

  for (const [index, line] of source.split('\n').entries()) {
    const trimmed = line.trimStart()
    const name = declarationName(trimmed)

    if (!name || seen.has(name)) {
      continue
    }

    seen.add(name)
    symbols.push({ line: index + 1, name })
  }

  return symbols
}

async function listNearbyPythonFiles(filePath: string): Promise<string[]> {
  const dir = dirname(filePath)

  try {
    const entries = await readdir(dir, { withFileTypes: true })

    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.py') && entry.name !== basename(filePath))
      .map(entry => resolve(dir, entry.name))
      .slice(0, 20)
  }
  catch {
    return []
  }
}

function readIdentifierAfterPrefix(line: string, prefix: string): string | undefined {
  const rest = line.slice(prefix.length).trimStart()
  let name = ''

  for (const char of rest) {
    if (char === '(' || char === ':' || char === '[' || char === ' ' || char === '\t') {
      break
    }

    name += char
  }

  return name || undefined
}

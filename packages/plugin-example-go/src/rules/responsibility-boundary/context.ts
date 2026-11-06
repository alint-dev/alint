import type { RuleContext } from '@alint-js/plugin'

import { readdir } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'

import { createApeiraAdapter } from '@alint-js/agent-apeira'
import { createTools } from '@alint-js/tools-fs'
import { errorMessageFrom } from '@moeru/std/error'

const maxContextSymbols = 16
const contextScoutAgent = createApeiraAdapter()

export async function collectResponsibilityBoundaryContext(
  ctx: RuleContext,
  filePath: string,
  source: string,
  model?: Awaited<ReturnType<RuleContext['model']>>,
): Promise<string | undefined> {
  const deterministicContext = await collectDeterministicContext(ctx, filePath, source)

  if (!model) {
    return deterministicContext
  }

  try {
    const agentContext = await collectAgentContext({
      ctx,
      deterministicContext,
      filePath,
      model,
      source,
    })

    if (!agentContext) {
      return deterministicContext
    }

    return [
      'Agent-selected project context:',
      agentContext,
      deterministicContext
        ? `Deterministic fallback context:\n\n${deterministicContext}`
        : undefined,
    ].filter(Boolean).join('\n\n')
  }
  catch (error) {
    ctx.logger.debug(`Go responsibility-boundary context scout failed: ${errorMessageFrom(error) ?? String(error)}`)
    return deterministicContext
  }
}

async function collectAgentContext(options: {
  ctx: RuleContext
  deterministicContext: string | undefined
  filePath: string
  model: Awaited<ReturnType<RuleContext['model']>>
  source: string
}): Promise<string | undefined> {
  const result = await contextScoutAgent({
    instructions: [
      'You are a repository context scout for a Go responsibility-boundary lint rule.',
      'Use the available tools to find only context that helps decide whether the reviewed file has cohesive ownership or an intentional framework wiring pattern.',
      'Return concise supplemental context, not diagnostics. Include file paths and short snippets. Do not suggest code changes.',
    ].join('\n'),
    model: options.model,
    prompt: [
      `Current working directory: ${options.ctx.cwd}`,
      `Reviewed file: ${relative(options.ctx.cwd, options.filePath)}`,
      '',
      options.deterministicContext
        ? `Deterministic hints already collected:\n\n${options.deterministicContext}`
        : undefined,
      '',
      `Reviewed Go source with line numbers:\n\n${formatSourceWithLineNumbers(options.source)}`,
    ].filter(Boolean).join('\n'),
    tools: createTools(options.ctx.cwd),
  })
  const answer = result?.answer.trim()

  return answer || undefined
}

async function collectDeterministicContext(ctx: RuleContext, filePath: string, source: string): Promise<string | undefined> {
  const symbols = extractGoDeclarationSymbols(source).slice(0, maxContextSymbols)
  const packageFiles = await listSamePackageGoFiles(filePath)
  const sections: string[] = []

  if (packageFiles.length > 0) {
    sections.push([
      'Same-package files:',
      ...packageFiles.map(path => `- ${relative(ctx.cwd, path)}`),
    ].join('\n'))
  }

  if (symbols.length > 0) {
    sections.push([
      'Declarations to check for callers/wiring:',
      symbols.map(symbol => symbol.name).join(', '),
    ].join('\n'))
  }

  return sections.length > 0
    ? sections.join('\n\n')
    : undefined
}

function extractGoDeclarationSymbols(source: string): Array<{ line: number, name: string }> {
  const symbols: Array<{ line: number, name: string }> = []
  const seen = new Set<string>()
  const declarationPattern = /^\s*(?:func\s+(?:\([^)]*\)\s*)?|type\s+|const\s+|var\s+)([A-Za-z_]\w*)/u

  for (const [index, line] of source.split('\n').entries()) {
    const match = declarationPattern.exec(line)
    const name = match?.[1]

    if (!name || seen.has(name)) {
      continue
    }

    seen.add(name)
    symbols.push({ line: index + 1, name })
  }

  return symbols
}

function formatSourceWithLineNumbers(source: string): string {
  return source
    .split('\n')
    .map((line, index) => `${index + 1} | ${line}`)
    .join('\n')
}

async function listSamePackageGoFiles(filePath: string): Promise<string[]> {
  const dir = dirname(filePath)

  try {
    const entries = await readdir(dir, { withFileTypes: true })

    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.go') && entry.name !== basename(filePath))
      .map(entry => resolve(dir, entry.name))
      .slice(0, 20)
  }
  catch {
    return []
  }
}

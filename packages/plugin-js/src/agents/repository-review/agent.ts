import type { AgentTool } from '@alint-js/core/agent'
import type { FileTarget, RuleContext } from '@alint-js/plugin'

import type { NonEmptyCategories, RepositoryFinding, RepositoryFindingWithRequiredEvidence } from './finding'

import { isAbsolute, normalize, relative, sep } from 'node:path'

import { requireAgent } from '@alint-js/core/agent'
import { formatOutputLanguageInstruction, formatSourceWithLineNumbers } from '@alint-js/core/structured-output'
import { createTools } from '@alint-js/tools-fs'

import { createSubmitReviewTool } from './finding'

const BASE_INSTRUCTIONS = [
  'Review only the requested repository question.',
  'Use list, search, and read tools to inspect relevant definitions, consumers, and package boundaries before reporting.',
  'Cite repository evidence with repo-relative path:line locations.',
  'Complete the review by calling submit_review exactly once; submit an empty findings array when the review is clean.',
].join('\n')

export interface RepositoryReviewOptions<Category extends string = string> {
  allowedCategories: NonEmptyCategories<Category>
  instructions: string
  operation: string
  prompt: string
  requireFutureFailure?: boolean
  requireRelatedLocations?: boolean
}

export class RepositoryReviewProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RepositoryReviewProtocolError'
  }
}

export function reviewRepository<Category extends string>(
  ctx: RuleContext,
  target: FileTarget,
  options: RepositoryReviewOptions<Category> & {
    requireFutureFailure: true
    requireRelatedLocations: true
  },
): Promise<RepositoryFindingWithRequiredEvidence<Category>[]>
export function reviewRepository<Category extends string>(
  ctx: RuleContext,
  target: FileTarget,
  options: RepositoryReviewOptions<Category>,
): Promise<RepositoryFinding<Category>[]>
export async function reviewRepository<Category extends string>(
  ctx: RuleContext,
  target: FileTarget,
  options: RepositoryReviewOptions<Category>,
): Promise<RepositoryFinding<Category>[]> {
  const agent = requireAgent(ctx)
  const model = await ctx.model()
  const file = await ctx.src.readFile(target.file)
  const submission = createSubmitReviewTool({
    allowedCategories: options.allowedCategories,
    lineCount: file.lines.length,
    requireFutureFailure: options.requireFutureFailure ?? false,
    requireRelatedLocations: options.requireRelatedLocations ?? false,
  })
  const result = await agent({
    instructions: [
      BASE_INSTRUCTIONS,
      formatOutputLanguageInstruction(ctx.outputLanguage),
      options.instructions,
    ].filter(instruction => instruction !== undefined).join('\n\n'),
    model,
    prompt: [
      options.prompt,
      JSON.stringify({
        path: repositoryRelativePath(ctx.cwd, target.file.path),
        source: formatSourceWithLineNumbers(file.text),
      }),
    ].join('\n\n'),
    tools: [
      ...withNumberedReads(createTools(ctx.cwd)),
      submission.tool,
    ],
  })

  if (result.usage) {
    ctx.metering.recordUsage({
      filePath: target.file.path,
      inputTokens: result.usage.inputTokens,
      metadata: { operation: options.operation },
      modelId: model.id,
      outputTokens: result.usage.outputTokens,
      providerId: model.provider.id,
      ruleId: ctx.id,
      totalTokens: result.usage.totalTokens,
    })
  }

  const findings = submission.getFindings()

  if (!findings) {
    throw new RepositoryReviewProtocolError('Repository review agent returned without calling submit_review.')
  }

  return deduplicateFindings(findings)
}

function deduplicateFindings<Category extends string>(
  findings: readonly RepositoryFinding<Category>[],
): RepositoryFinding<Category>[] {
  const seen = new Set<string>()

  return findings.filter((finding) => {
    const identity = `${finding.category}:${finding.line}`

    if (seen.has(identity)) {
      return false
    }

    seen.add(identity)
    return true
  })
}

function repositoryRelativePath(cwd: string, filePath: string): string {
  const relativePath = cwd && isAbsolute(filePath)
    ? relative(cwd, filePath)
    : filePath
  return normalize(relativePath).split(sep).join('/')
}

function withNumberedReads(tools: AgentTool[]): AgentTool[] {
  return tools.map(tool => tool.name === 'read_file'
    ? {
        ...tool,
        execute: async input => formatSourceWithLineNumbers(String(await tool.execute(input))),
      }
    : tool)
}

import type { RuleContext, RuleDefinition } from '@alint-js/core'

import type { DeclarativeFinding, DeclarativeRuleDefinition } from '../../plugins/declarative/types'

import { Buffer } from 'node:buffer'
import { open } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import { formatOutputLanguageInstruction, formatSourceWithLineNumbers, generateStructured } from '@alint-js/core/structured-output'
import { listFiles } from '@alint-js/tools-fs'

import { createDeclarativeCacheKey } from '../../plugins/declarative/cache-key'
import { isActionableFinding } from '../../plugins/declarative/findings'
import { createReportScope } from '../../plugins/declarative/scope'
import { declarativeFindingResponseSchema } from '../../plugins/declarative/types'

export interface CreateStructuredMessagesOptions {
  cwd: string
  includeFiles?: readonly string[]
  instruction: string
  logger?: RuleContext['logger']
  outputLanguage?: string
  retryFeedback?: string
  ruleFilePath: string
  sourceText: string
  supplementalFiles?: readonly SupplementalFile[]
  targetFilePath: string
}

export interface ReportDeclarativeFindingsOptions {
  ctx: Pick<RuleContext, 'cwd' | 'logger' | 'report'>
  excludeFiles: readonly string[]
  findings: readonly DeclarativeFinding[]
  includeFiles?: readonly string[]
  targetFilePath: string
}

const maxSupplementalFileBytes = 64 * 1024
const maxSupplementalFiles = 12

interface SupplementalFile {
  content: string
  filePath: string
}

export function createBasicStructuredRule(rule: DeclarativeRuleDefinition): RuleDefinition {
  return {
    cache: rule.includeFiles === undefined || rule.includeFiles.length === 0,
    cacheKey: createDeclarativeCacheKey(rule),
    create: ctx => ({
      /**
       * Runs one structured declarative review for a planned file.
       *
       * Triggering workflow:
       *
       * {@link createBasicStructuredRule}
       *   -> `RuleHandlers.onTargetFile`
       *     -> {@link generateStructured}
       *
       * Upstream:
       * - {@link createBasicStructuredRule}
       *
       * Downstream:
       * - {@link generateStructured}
       * - {@link reportDeclarativeFindings}
       */
      async onTargetFile(target) {
        const model = await ctx.model()
        const file = await ctx.src.readFile(target.file)
        const supplementalFiles = await collectSupplementalFiles({
          cwd: ctx.cwd,
          includeFiles: rule.includeFiles,
          logger: ctx.logger,
          targetFilePath: target.file.path,
        })

        const { findings } = await generateStructured({
          createMessages: retryFeedback => createStructuredMessagesSync({
            cwd: ctx.cwd,
            includeFiles: rule.includeFiles,
            instruction: rule.instruction,
            outputLanguage: ctx.outputLanguage,
            retryFeedback,
            ruleFilePath: rule.filePath,
            sourceText: file.text,
            supplementalFiles,
            targetFilePath: target.file.path,
          }),
          logger: ctx.logger,
          metering: ctx.metering,
          model,
          operation: `declarative-${rule.name}-structured`,
          schema: declarativeFindingResponseSchema,
          signal: ctx.signal,
        })

        reportDeclarativeFindings({
          ctx,
          excludeFiles: rule.excludeFiles,
          findings,
          includeFiles: rule.includeFiles,
          targetFilePath: target.file.path,
        })
      },
    }),
  }
}

export async function createStructuredMessages(options: CreateStructuredMessagesOptions) {
  const supplementalFiles = options.supplementalFiles ?? await collectSupplementalFiles({
    cwd: options.cwd,
    includeFiles: options.includeFiles,
    logger: options.logger,
    targetFilePath: options.targetFilePath,
  })

  return createStructuredMessagesSync({
    ...options,
    supplementalFiles,
  })
}

export function createStructuredMessagesSync(options: CreateStructuredMessagesOptions) {
  return [
    {
      content: options.instruction,
      role: 'system' as const,
    },
    ...(options.retryFeedback
      ? [
          {
            content: options.retryFeedback,
            role: 'user' as const,
          },
        ]
      : []),
    {
      content: [
        formatOutputLanguageInstruction(options.outputLanguage),
        `Rule file path: ${options.ruleFilePath}`,
        `Reviewed target file path: ${options.targetFilePath}`,
        formatSupplementalFiles(options.cwd, options.supplementalFiles ?? []),
        `Reviewed target source with line numbers:\n\n${formatSourceWithLineNumbers(options.sourceText)}`,
      ].filter(Boolean).join('\n\n'),
      role: 'user' as const,
    },
  ]
}

export function reportDeclarativeFindings(options: ReportDeclarativeFindingsOptions): void {
  const scope = createReportScope({
    cwd: options.ctx.cwd,
    excludeFiles: options.excludeFiles,
    includeFiles: options.includeFiles,
    targetFilePath: options.targetFilePath,
  })

  for (const finding of options.findings) {
    if (!isActionableFinding(finding)) {
      options.ctx.logger.debug('Ignoring declarative finding that reports no issue', {
        message: finding.message,
      })
      continue
    }

    const filePath = resolveFindingFilePath(options.ctx.cwd, options.targetFilePath, finding.filePath)

    if (!scope.canReport(filePath)) {
      options.ctx.logger.debug('Ignoring out-of-scope declarative finding', {
        filePath,
        message: finding.message,
      })
      continue
    }

    const evidence = createFindingEvidence(finding)

    options.ctx.report({
      ...(evidence ? { evidence } : {}),
      filePath,
      loc: {
        start: {
          column: 0,
          line: finding.line,
        },
      },
      message: finding.message,
    })
  }
}

async function collectSupplementalFiles(options: {
  cwd: string
  includeFiles?: readonly string[]
  logger?: RuleContext['logger']
  targetFilePath: string
}): Promise<SupplementalFile[]> {
  if (options.includeFiles === undefined || options.includeFiles.length === 0) {
    return []
  }

  const targetFilePath = resolve(options.targetFilePath)
  const filePaths = (await listFiles(options.cwd, { patterns: options.includeFiles }))
    .map(filePath => resolve(filePath))
    .filter(filePath => filePath !== targetFilePath)
    .sort()
    .slice(0, maxSupplementalFiles)

  const files: SupplementalFile[] = []

  for (const filePath of filePaths) {
    const content = await readSupplementalFile(filePath, options.logger)

    if (content === undefined) {
      continue
    }

    files.push({
      content,
      filePath,
    })
  }

  return files
}

function createFindingEvidence(finding: DeclarativeFinding): undefined | { confidence?: DeclarativeFinding['confidence'], suggestion?: string } {
  const evidence = {
    ...(finding.confidence ? { confidence: finding.confidence } : {}),
    ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
  }

  return Object.keys(evidence).length > 0 ? evidence : undefined
}

function formatSupplementalFiles(cwd: string, files: readonly SupplementalFile[]): string | undefined {
  if (files.length === 0) {
    return undefined
  }

  return [
    'Supplemental files:',
    ...files.map(file => [
      `File: ${relative(cwd, file.filePath)}`,
      file.content,
    ].join('\n\n')),
  ].join('\n\n')
}

async function readSupplementalFile(filePath: string, logger: RuleContext['logger'] | undefined): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined

  try {
    handle = await open(filePath, 'r')
    const buffer = Buffer.alloc(maxSupplementalFileBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)

    if (bytesRead > maxSupplementalFileBytes) {
      logger?.debug('Skipping oversized declarative supplemental file', {
        filePath,
        maxBytes: maxSupplementalFileBytes,
      })
      return undefined
    }

    return buffer.subarray(0, bytesRead).toString('utf8')
  }
  catch (error) {
    logger?.debug('Skipping unreadable declarative supplemental file', {
      error,
      filePath,
    })
    return undefined
  }
  finally {
    await handle?.close()
  }
}

function resolveFindingFilePath(cwd: string, targetFilePath: string, findingFilePath: string | undefined): string {
  if (findingFilePath === undefined || findingFilePath.length === 0) {
    return targetFilePath
  }

  return isAbsolute(findingFilePath)
    ? findingFilePath
    : resolve(cwd, findingFilePath)
}

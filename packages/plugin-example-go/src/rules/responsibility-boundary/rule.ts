import type { RuleContext } from '@alint-js/plugin'
import type { JsonSchema } from '@valibot/to-json-schema'
import type { InferOutput } from 'valibot'

import { formatOutputLanguageInstruction, formatSourceWithLineNumbers, generateStructured, toolParametersFromSchema } from '@alint-js/core/structured-output'
import { defineRule } from '@alint-js/plugin'
import { array, description, number, object, optional, picklist, pipe, string } from 'valibot'

import { collectResponsibilityBoundaryContext } from './context'
import { responsibilityBoundaryPrompt } from './prompt'

export const responsibilityBoundaryFindingSchema = pipe(
  object({
    category: pipe(
      picklist([
        'responsibility-boundary',
        'constructor-cohesion',
        'domain-placement',
        'testability',
      ]),
      description('Finding category. Use exactly one of responsibility-boundary, constructor-cohesion, domain-placement, or testability.'),
    ),
    confidence: pipe(
      picklist(['high', 'medium', 'low']),
      description('Confidence in this finding. Use exactly "low", "medium", or "high" without punctuation.'),
    ),
    line: pipe(
      number(),
      description([
        'Use the left-column line number from the numbered code block.',
        'Pick the first line of the function, type, import group, or declaration that best represents the finding.',
        'Do not point at a caller only because it mentions another helper; choose the declaration that owns the misplaced responsibility.',
      ].join(' ')),
    ),
    message: pipe(
      string(),
      description([
        'Describe the architectural problem in this Go file.',
        'Mention the concrete responsibility being mixed or split.',
        'Do not require an exact function name match.',
        'Keep the message short.',
      ].join(' ')),
    ),
    relatedDeclarations: optional(pipe(
      array(object({
        line: pipe(
          number(),
          description('Left-column line number for another declaration that participates in the same cohesive issue cluster.'),
        ),
        name: pipe(
          string(),
          description('Declaration name or short declaration label from the reviewed source.'),
        ),
        role: pipe(
          string(),
          description('Brief role this declaration plays in the same issue cluster, such as result type, script data, wrapper, helper, or owner operation.'),
        ),
      })),
      description('Related declarations that are evidence for the same cohesive issue cluster. Use an empty array when the finding is intentionally per-declaration.'),
    )),
    suggestion: pipe(
      string(),
      description([
        'Give one concrete design direction.',
        'Prefer focused Go files, cohesive owners, or moving domain policy near its owning package when they fit.',
        'Do not provide a code patch.',
        'Keep the suggestion under 45 words.',
      ].join(' ')),
    ),
  }),
  description('One warning-level report for a Go responsibility boundary or constructor cohesion design smell.'),
)

export const responsibilityBoundaryResponseSchema = pipe(
  object({
    findings: pipe(
      array(responsibilityBoundaryFindingSchema),
      description('All warning-level Go responsibility boundary findings. Return an empty array when the file is already focused and cohesive.'),
    ),
  }),
  description('Report Go responsibility-boundary findings for this file.'),
)

type ResponsibilityBoundaryFinding = InferOutput<typeof responsibilityBoundaryFindingSchema>

export const responsibilityBoundaryRule = defineRule({
  create: ctx => ({
    /**
     * Reviews one planned Go file for responsibility-boundary findings.
     *
     * Triggering workflow:
     *
     * {@link responsibilityBoundaryRule}
     *   -> `RuleHandlers.onTargetFile`
     *     -> {@link judgeResponsibilityBoundary}
     *
     * Upstream:
     * - {@link responsibilityBoundaryRule}
     *
     * Downstream:
     * - {@link judgeResponsibilityBoundary}
     * - {@link reportResponsibilityBoundaryFindings}
     */
    async onTargetFile(target) {
      if (!target.file.path.endsWith('.go')) {
        return
      }

      const file = await ctx.src.readFile(target.file)
      const findings = await judgeResponsibilityBoundary(ctx, file)

      reportResponsibilityBoundaryFindings(ctx, target.file.path, findings)
    },
  }),
})

export function createReportFindingsToolParameters(): JsonSchema {
  return toolParametersFromSchema(responsibilityBoundaryResponseSchema)
}

export function createResponsibilityBoundaryMessages(
  source: string,
  retryFeedback: string | undefined,
  outputLanguage?: string,
  context?: string,
) {
  return [
    {
      content: responsibilityBoundaryPrompt,
      role: 'system' as const,
    },
    ...(retryFeedback
      ? [
          {
            content: retryFeedback,
            role: 'user' as const,
          },
        ]
      : []),
    {
      content: [
        formatOutputLanguageInstruction(outputLanguage),
        context
          ? `Supplemental project context:\n\n${context}`
          : undefined,
        `Go code with line numbers:\n\n${formatSourceWithLineNumbers(source)}`,
      ].filter(Boolean).join('\n\n'),
      role: 'user' as const,
    },
  ]
}

export { collectResponsibilityBoundaryContext, responsibilityBoundaryPrompt }

export function reportResponsibilityBoundaryFindings(
  ctx: RuleContext,
  filePath: string,
  findings: readonly ResponsibilityBoundaryFinding[],
): void {
  for (const finding of findings) {
    const evidence = {
      category: finding.category,
      confidence: finding.confidence,
      ...(finding.relatedDeclarations
        ? { relatedDeclarations: finding.relatedDeclarations }
        : {}),
      suggestion: finding.suggestion,
    }

    ctx.report({
      evidence,
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

async function judgeResponsibilityBoundary(
  ctx: RuleContext,
  file: { path: string, text: string },
): Promise<ResponsibilityBoundaryFinding[]> {
  const model = await ctx.model()
  const context = await collectResponsibilityBoundaryContext(ctx, file.path, file.text, model)

  const { findings } = await generateStructured({
    createMessages: retryFeedback => createResponsibilityBoundaryMessages(file.text, retryFeedback, ctx.outputLanguage, context),
    logger: ctx.logger,
    metering: ctx.metering,
    model,
    operation: 'go-responsibility-boundary-judge',
    schema: responsibilityBoundaryResponseSchema,
    signal: ctx.signal,
  })

  return findings
}

import type { RuleContext } from '@alint-js/plugin'
import type { JsonSchema } from '@valibot/to-json-schema'
import type { InferOutput } from 'valibot'

import { formatOutputLanguageInstruction, formatSourceWithLineNumbers, generateStructured, toolParametersFromSchema } from '@alint-js/core/structured-output'
import { defineRule } from '@alint-js/plugin'
import { array, description, number, object, optional, picklist, pipe, string } from 'valibot'

import { collectPythonSemanticBoundaryContext } from './context'
import { pythonSemanticBoundaryPrompt } from './prompt'

export const pythonSemanticBoundaryFindingSchema = pipe(
  object({
    category: pipe(
      picklist([
        'semantic-boundary',
        'typed-boundary',
        'domain-model',
        'testability',
      ]),
      description('Finding category. Use exactly one of semantic-boundary, typed-boundary, domain-model, or testability.'),
    ),
    confidence: pipe(
      picklist(['high', 'medium', 'low']),
      description('Confidence in this finding. Use exactly "low", "medium", or "high" without punctuation.'),
    ),
    line: pipe(
      number(),
      description([
        'Use the left-column line number from the numbered code block.',
        'Pick the first line of the method, class, protocol, helper, or declaration that best represents the finding.',
        'Do not point at a caller only because it mentions another helper; choose the declaration that owns the misplaced responsibility.',
      ].join(' ')),
    ),
    message: pipe(
      string(),
      description([
        'Describe the Python semantic boundary problem.',
        'Mention the concrete responsibility being leaked, mixed, or missing.',
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
          description('Brief role this declaration plays in the same issue cluster, such as raw-shape helper, parser, formatter, protocol, coercion helper, or owner operation.'),
        ),
      })),
      description('Related declarations that are evidence for the same cohesive issue cluster. Use an empty array when the finding is intentionally per-declaration.'),
    )),
    suggestion: pipe(
      string(),
      description([
        'Give one concrete design direction.',
        'Prefer typed boundary objects, cohesive domain objects, focused adapters, or moving format ownership near the represented value when they fit.',
        'Do not provide a code patch.',
        'Keep the suggestion under 45 words.',
      ].join(' ')),
    ),
  }),
  description('One warning-level report for a Python semantic boundary, typed boundary, domain-model, or testability design smell.'),
)

export const pythonSemanticBoundaryResponseSchema = pipe(
  object({
    findings: pipe(
      array(pythonSemanticBoundaryFindingSchema),
      description('All warning-level Python semantic boundary findings. Return an empty array when the file is already focused and cohesive.'),
    ),
  }),
  description('Report Python semantic-boundary findings for this file.'),
)

type PythonSemanticBoundaryFinding = InferOutput<typeof pythonSemanticBoundaryFindingSchema>

export const pythonSemanticBoundaryRule = defineRule({
  create: ctx => ({
    /**
     * Reviews one planned Python file for semantic-boundary findings.
     *
     * Triggering workflow:
     *
     * {@link pythonSemanticBoundaryRule}
     *   -> `RuleHandlers.onTargetFile`
     *     -> {@link judgePythonSemanticBoundary}
     *
     * Upstream:
     * - {@link pythonSemanticBoundaryRule}
     *
     * Downstream:
     * - {@link judgePythonSemanticBoundary}
     * - {@link reportPythonSemanticBoundaryFindings}
     */
    async onTargetFile(target) {
      if (!target.file.path.endsWith('.py')) {
        return
      }

      const file = await ctx.src.readFile(target.file)
      const findings = await judgePythonSemanticBoundary(ctx, file)

      reportPythonSemanticBoundaryFindings(ctx, target.file.path, findings)
    },
  }),
})

export function createPythonSemanticBoundaryMessages(
  source: string,
  retryFeedback: string | undefined,
  outputLanguage?: string,
  context?: string,
) {
  return [
    {
      content: pythonSemanticBoundaryPrompt,
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
        `Python code with line numbers:\n\n${formatSourceWithLineNumbers(source)}`,
      ].filter(Boolean).join('\n\n'),
      role: 'user' as const,
    },
  ]
}

export function createReportFindingsToolParameters(): JsonSchema {
  return toolParametersFromSchema(pythonSemanticBoundaryResponseSchema)
}

export { collectPythonSemanticBoundaryContext, pythonSemanticBoundaryPrompt }

export function reportPythonSemanticBoundaryFindings(
  ctx: RuleContext,
  filePath: string,
  findings: readonly PythonSemanticBoundaryFinding[],
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

async function judgePythonSemanticBoundary(
  ctx: RuleContext,
  file: { path: string, text: string },
): Promise<PythonSemanticBoundaryFinding[]> {
  const model = await ctx.model()
  const context = await collectPythonSemanticBoundaryContext(ctx, file.path, file.text)

  const { findings } = await generateStructured({
    createMessages: retryFeedback => createPythonSemanticBoundaryMessages(file.text, retryFeedback, ctx.outputLanguage, context),
    logger: ctx.logger,
    metering: ctx.metering,
    model,
    operation: 'python-semantic-boundary-judge',
    schema: pythonSemanticBoundaryResponseSchema,
    signal: ctx.signal,
  })

  return findings
}

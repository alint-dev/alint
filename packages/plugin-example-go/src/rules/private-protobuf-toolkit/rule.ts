import type { RuleContext } from '@alint-js/plugin'
import type { InferOutput } from 'valibot'

import { formatOutputLanguageInstruction, formatSourceWithLineNumbers, generateStructured } from '@alint-js/core/structured-output'
import { defineRule } from '@alint-js/plugin'
import { array, description, number, object, picklist, pipe, string } from 'valibot'

import { privateProtobufToolkitPrompt } from './prompt'

export const privateProtobufToolkitFindingSchema = pipe(
  object({
    confidence: pipe(
      picklist(['high', 'medium', 'low']),
      description('Confidence in this finding. Use exactly "low", "medium", or "high" without punctuation.'),
    ),
    line: pipe(
      number(),
      description('Use the left-column line number for the first helper declaration in the private toolkit cluster.'),
    ),
    message: pipe(
      string(),
      description('Describe the private boundary-translation toolkit cluster and mention representative helpers.'),
    ),
    suggestion: pipe(
      string(),
      description('Give one concrete owner or boundary direction. Do not provide a patch. Keep under 45 words.'),
    ),
  }),
  description('One warning-level report for a Go private boundary-translation toolkit.'),
)

export const privateProtobufToolkitResponseSchema = pipe(
  object({
    findings: pipe(
      array(privateProtobufToolkitFindingSchema),
      description('All private boundary-translation toolkit findings. Return an empty array when there is no qualifying cluster.'),
    ),
  }),
  description('Report private boundary-translation toolkit findings for this Go file.'),
)

type PrivateProtobufToolkitFinding = InferOutput<typeof privateProtobufToolkitFindingSchema>

export const privateProtobufToolkitRule = defineRule({
  cacheKey: privateProtobufToolkitPrompt,
  create: ctx => ({
    /**
     * Reviews one Go file for private boundary-translation toolkit clusters.
     *
     * Triggering workflow:
     *
     * {@link defineRule}
     *   -> `PlannedSourceTarget.kind === "file"`
     *     -> `onTargetFile`
     *       -> {@link judgePrivateProtobufToolkit}
     *
     * Upstream:
     * - {@link defineRule}
     *
     * Downstream:
     * - {@link judgePrivateProtobufToolkit}
     * - `ctx.report`
     */
    async onTargetFile(target) {
      if (!target.file.path.endsWith('.go')) {
        return
      }

      const file = await ctx.src.readFile(target.file)
      const findings = await judgePrivateProtobufToolkit(ctx, file.text)

      for (const finding of findings) {
        ctx.report({
          evidence: {
            confidence: finding.confidence,
            suggestion: finding.suggestion,
          },
          filePath: target.file.path,
          loc: {
            start: { column: 0, line: finding.line },
          },
          message: finding.message,
        })
      }
    },
  }),
})

export function createPrivateProtobufToolkitMessages(
  source: string,
  retryFeedback: string | undefined,
  outputLanguage?: string,
) {
  return [
    {
      content: privateProtobufToolkitPrompt,
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
        `Go code with line numbers:\n\n${formatSourceWithLineNumbers(source)}`,
      ].filter(Boolean).join('\n\n'),
      role: 'user' as const,
    },
  ]
}

async function judgePrivateProtobufToolkit(
  ctx: RuleContext,
  source: string,
): Promise<PrivateProtobufToolkitFinding[]> {
  const model = await ctx.model()
  const { findings } = await generateStructured({
    createMessages: retryFeedback => createPrivateProtobufToolkitMessages(source, retryFeedback, ctx.outputLanguage),
    logger: ctx.logger,
    metering: ctx.metering,
    model,
    operation: 'go-private-boundary-toolkit-judge',
    schema: privateProtobufToolkitResponseSchema,
    signal: ctx.signal,
  })

  return findings
}

import { defineRule } from '@alint-js/plugin'

import { reviewRepository } from '../../agents/repository-review'
import { duplicatedConversionKnowledgeInstructions, duplicatedConversionKnowledgePrompt } from './prompt'

export const duplicatedConversionKnowledgeRule = defineRule({
  create: ctx => ({
    /**
     * Reviews one Go file for conversion policy duplicated elsewhere in the repository.
     *
     * Triggering workflow:
     *
     * {@link defineRule}
     *   -> `PlannedSourceTarget.kind === "file"`
     *     -> `onTargetFile`
     *       -> {@link reviewRepository}
     *
     * Upstream:
     * - {@link defineRule}
     *
     * Downstream:
     * - {@link reviewRepository}
     * - `ctx.report`
     */
    async onTargetFile(target) {
      if (!target.file.path.endsWith('.go')) {
        return
      }

      const findings = await reviewRepository(ctx, target, {
        allowedCategories: ['conversion-policy', 'conversion-mechanism'],
        instructions: duplicatedConversionKnowledgeInstructions,
        operation: 'go-duplicated-conversion-knowledge-review',
        prompt: duplicatedConversionKnowledgePrompt,
        requireFutureFailure: true,
        requireRelatedLocations: true,
      })

      for (const finding of findings) {
        ctx.report({
          evidence: {
            category: finding.category,
            futureFailure: finding.futureFailure,
            proof: finding.proof,
            relatedLocations: finding.relatedLocations,
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

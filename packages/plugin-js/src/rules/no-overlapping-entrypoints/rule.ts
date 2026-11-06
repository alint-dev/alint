import { defineRule } from '@alint-js/plugin'

import { reviewRepository } from '../../agents/repository-review'
import { overlappingEntrypointsInstructions, overlappingEntrypointsPrompt } from './prompt'

export const overlappingEntrypointsRule = defineRule({
  cache: false,
  create: ctx => ({
    async onTargetFile(target) {
      const findings = await reviewRepository(ctx, target, {
        allowedCategories: ['overlapping-entrypoints'],
        instructions: overlappingEntrypointsInstructions,
        operation: 'overlapping-entrypoints-review',
        prompt: overlappingEntrypointsPrompt,
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

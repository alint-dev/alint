import { defineRule } from '@alint-js/plugin'

import { reviewRepository } from '../../agents/repository-review'
import { redundantCatchInstructions, redundantCatchPrompt } from './prompt'

export const redundantCatchRule = defineRule({
  cache: false,
  create: ctx => ({
    async onTargetFile(target) {
      const findings = await reviewRepository(ctx, target, {
        allowedCategories: ['redundant-catch'],
        instructions: redundantCatchInstructions,
        operation: 'redundant-catch-review',
        prompt: redundantCatchPrompt,
        requireRelatedLocations: true,
      })

      for (const finding of findings) {
        ctx.report({
          evidence: {
            category: finding.category,
            ...(finding.futureFailure
              ? { futureFailure: finding.futureFailure }
              : {}),
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

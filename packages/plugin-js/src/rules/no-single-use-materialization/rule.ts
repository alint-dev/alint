import { defineRule } from '@alint-js/plugin'

import { reviewRepository } from '../../agents/repository-review'
import { singleUseMaterializationInstructions, singleUseMaterializationPrompt } from './prompt'

export const singleUseMaterializationRule = defineRule({
  cache: false,
  create: ctx => ({
    async onTargetFile(target) {
      const findings = await reviewRepository(ctx, target, {
        allowedCategories: ['single-use-materialization'],
        instructions: singleUseMaterializationInstructions,
        operation: 'single-use-materialization-review',
        prompt: singleUseMaterializationPrompt,
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

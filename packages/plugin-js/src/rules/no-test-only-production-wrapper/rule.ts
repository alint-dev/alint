import { defineRule } from '@alint-js/plugin'

import { reviewRepository } from '../../agents/repository-review'
import { testOnlyProductionWrapperInstructions, testOnlyProductionWrapperPrompt } from './prompt'

const TEST_ONLY_PRODUCTION_WRAPPER_CATEGORIES = ['test-only-production-wrapper'] as const

export const testOnlyProductionWrapperRule = defineRule({
  cache: false,
  create: ctx => ({
    async onTargetFile(target) {
      const findings = await reviewRepository(ctx, target, {
        allowedCategories: TEST_ONLY_PRODUCTION_WRAPPER_CATEGORIES,
        instructions: testOnlyProductionWrapperInstructions,
        operation: 'test-only-production-wrapper-review',
        prompt: testOnlyProductionWrapperPrompt,
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

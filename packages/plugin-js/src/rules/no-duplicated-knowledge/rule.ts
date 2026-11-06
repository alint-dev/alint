import { defineRule } from '@alint-js/plugin'

import { reviewRepository } from '../../agents/repository-review'
import { duplicatedKnowledgeInstructions, duplicatedKnowledgePrompt } from './prompt'

export const duplicatedKnowledgeRule = defineRule({
  cache: false,
  create: ctx => ({
    async onTargetFile(target) {
      const findings = await reviewRepository(ctx, target, {
        allowedCategories: ['policy', 'mechanism'],
        instructions: duplicatedKnowledgeInstructions,
        operation: 'duplicated-knowledge-review',
        prompt: duplicatedKnowledgePrompt,
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

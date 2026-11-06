import { defineRule } from '@alint-js/plugin'

import { reviewRepository } from '../../agents/repository-review'
import { noRawSqlBypassingEntInstructions, noRawSqlBypassingEntPrompt } from './prompt'

export const noRawSqlBypassingEntRule = defineRule({
  create: ctx => ({
    /**
     * Reviews one Go file for raw SQL paths that bypass generated Ent storage ownership.
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
        allowedCategories: ['escape-hatch', 'schema-bypass'],
        instructions: noRawSqlBypassingEntInstructions,
        operation: 'go-no-raw-sql-bypassing-ent-review',
        prompt: noRawSqlBypassingEntPrompt,
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

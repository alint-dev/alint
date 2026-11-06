import type { ReinventedHelperFinding } from './tools'

import { requireAgent } from '@alint-js/core/agent'
import { defineRule } from '@alint-js/plugin'

import { buildReinventedHelperPrompt, reinventedHelperInstructions } from './prompt'
import { createReinventedHelperTools } from './tools'

export const reinventedHelperRule = defineRule({
  // Agentic rules read other files and are nondeterministic, so their output is not cacheable.
  cache: false,
  create: ctx => ({
    /**
     * Reviews one planned TypeScript file for a reinvented helper.
     *
     * Triggering workflow:
     *
     * {@link reinventedHelperRule}
     *   -> `RuleHandlers.onTargetFile`
     *     -> {@link buildReinventedHelperPrompt}
     *
     * Upstream:
     * - {@link reinventedHelperRule}
     *
     * Downstream:
     * - {@link buildReinventedHelperPrompt}
     * - `RuleContext.report`
     */
    async onTargetFile(target) {
      if (!target.file.path.endsWith('.ts')) {
        return
      }

      const findings: ReinventedHelperFinding[] = []
      const tools = createReinventedHelperTools(ctx.src, ctx.cwd, findings)
      const model = await ctx.model()
      const agent = requireAgent(ctx)
      const file = await ctx.src.readFile(target.file)

      await agent({
        instructions: reinventedHelperInstructions,
        model,
        prompt: buildReinventedHelperPrompt(target.file.path, file.text),
        tools,
      })

      for (const finding of findings) {
        ctx.report({
          evidence: { suggestion: finding.suggestion },
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

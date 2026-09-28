import { defineRule } from '@alint-js/plugin'

import { judgeSource } from '../../agents/judge/agent'
import { configFileTestsPrompt } from './prompt'

/*
 * Only test files can carry this smell, so everything else is skipped before the model call: a broad
 * `files:` glob would otherwise pay for every source file in the repository.
 *
 * The path is inspected rather than the language's extracted targets because the rule reads the test
 * as text, and a configuration test is a file-level question rather than a symbol-level one.
 */
const TEST_FILE_SUFFIX = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const TEST_DIRECTORY = /(?:^|\/)(?:__tests__|__test__)\//

export const configFileTestsRule = defineRule({
  cacheKey: configFileTestsPrompt,
  create: ctx => ({
    /**
     * Reviews one test file target for a standalone test of configuration content.
     *
     * Triggering workflow:
     *
     * {@link defineRule}
     *   -> `PlannedSourceTarget.kind === "file"`
     *     -> `onTargetFile`
     *       -> {@link judgeSource}
     *
     * Upstream:
     * - {@link defineRule}
     *
     * Downstream:
     * - {@link judgeSource}
     * - `ctx.report`
     */
    async onTargetFile(target) {
      if (!isTestFile(target.file.path)) {
        return
      }

      const model = await ctx.model()
      const file = await ctx.src.readFile(target.file)
      const findings = await judgeSource({
        logger: ctx.logger,
        metering: ctx.metering,
        model,
        operation: 'config-file-tests-judge',
        outputLanguage: ctx.outputLanguage,
        prompt: configFileTestsPrompt,
        signal: ctx.signal,
        source: file.text,
      })

      for (const finding of findings) {
        ctx.report({
          evidence: {
            confidence: finding.confidence,
            suggestion: finding.suggestion,
          },
          filePath: target.file.path,
          loc: {
            start: {
              column: 0,
              line: finding.line,
            },
          },
          message: finding.message,
        })
      }
    },
  }),
  languages: ['javascript', 'typescript'],
})

function isTestFile(filePath: string): boolean {
  // A Windows path would hide the `__tests__` segment from the directory pattern.
  const normalized = filePath.replace(/\\/g, '/')

  return TEST_FILE_SUFFIX.test(normalized) || TEST_DIRECTORY.test(normalized)
}

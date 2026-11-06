import type { RuleJob, RuleRuntime, RuleTargetExecution } from '../execution/types'
import type { PreparedDirectoryInput } from '../preparation'

import { stableHash } from '../hash'

export function createDirectoryJobs(input: PreparedDirectoryInput, runtimes: RuleRuntime[]): RuleJob[] {
  const target = input.target
  return runtimes.flatMap((runtime): RuleJob[] => {
    const execution = directoryExecution(runtime)
    if (!execution)
      return []
    const ruleId = runtime.enabledRule.id
    return [
      {
        execution,
        jobRef: {
          id: stableHash({
            directoryIndex: input.directoryIndex,
            input: target.path,
            ruleId,
            targetIdentity: target.path,
          }),
          index: 0,
          inputPath: target.path,
          ruleId,
          target: { identity: target.path, kind: 'directory' },
        },
        orderKey: {
          inputIndex: input.directoryIndex,
          ruleIndex: runtime.ruleIndex,
          scope: 'directory',
          targetIndex: 0,
        },
        target: {
          activeFilePath: target.path,
          cacheTargetHash: stableHash(target),
          configHash: input.configHash,
          descriptor: target,
          identity: target.path,
          kind: 'directory',
        },
      },
    ]
  })
}

function directoryExecution(runtime: RuleRuntime): RuleTargetExecution | undefined {
  if (runtime.handlers.onTargetWith)
    return { handler: 'with', runtime }
  if (runtime.handlers.onTargetDirectory)
    return { handler: 'directory', runtime }
  return undefined
}

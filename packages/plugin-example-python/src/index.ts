import type { AgentTool } from '@alint-js/core/agent'

import { definePlugin } from '@alint-js/plugin'
import { createTools as createFsTools, DEFAULT_IGNORE_PATTERNS } from '@alint-js/tools-fs'

import { pythonSemanticBoundaryRule } from './rules/semantic-boundary'
import { pythonTypedArtifactBoundaryRule } from './rules/typed-artifact-boundary'

export {
  collectPythonSemanticBoundaryContext,
  createPythonSemanticBoundaryMessages,
  createReportFindingsToolParameters,
  pythonSemanticBoundaryFindingSchema,
  pythonSemanticBoundaryPrompt,
  pythonSemanticBoundaryResponseSchema,
  reportPythonSemanticBoundaryFindings,
} from './rules/semantic-boundary'
export {
  createPythonTypedArtifactBoundaryMessages,
  pythonTypedArtifactBoundaryFindingSchema,
  pythonTypedArtifactBoundaryPrompt,
  pythonTypedArtifactBoundaryResponseSchema,
  reportPythonTypedArtifactBoundaryFindings,
} from './rules/typed-artifact-boundary'
export function createPythonPlugin() {
  return definePlugin({
    configs: {
      example: [
        {
          files: ['**/*.py'],
          language: 'plaintext',
          rules: {
            'python/semantic-boundary': 'warn',
            'python/typed-artifact-boundary': 'warn',
          },
        },
      ],
    },
    rules: {
      'semantic-boundary': pythonSemanticBoundaryRule,
      'typed-artifact-boundary': pythonTypedArtifactBoundaryRule,
    },
  })
}

export function createTools(cwd: string): AgentTool[] {
  return createFsTools(cwd, {
    ignore: [...DEFAULT_IGNORE_PATTERNS, '**/.venv/**', '**/__pycache__/**'],
  })
}

export const pythonPlugin = createPythonPlugin()

export default pythonPlugin

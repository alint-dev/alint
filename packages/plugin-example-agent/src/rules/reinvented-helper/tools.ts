import type { AgentTool } from '@alint-js/core/agent'
import type { SourceRuntime } from '@alint-js/plugin'

import { resolve } from 'node:path'

import { defineTool } from '@alint-js/core/agent'
import { errorMessageFrom } from '@moeru/std/error'

export interface ReinventedHelperFinding {
  line: number
  message: string
  suggestion: string
}

export function createReadFileTool(src: Pick<SourceRuntime, 'readFile'>, cwd: string): AgentTool {
  return defineTool({
    description: 'Read a source file by its path (relative to the project root) and return its full text.',
    execute: async (input) => {
      const { path } = input as { path: string }

      try {
        const file = await src.readFile(resolve(cwd, path))

        return file.text
      }
      catch (error) {
        return `Could not read "${path}": ${errorMessageFrom(error) ?? String(error)}`
      }
    },
    name: 'read_file',
    parameters: {
      additionalProperties: false,
      properties: {
        path: { description: 'Path of the file to read, relative to the project root.', type: 'string' },
      },
      required: ['path'],
      type: 'object',
    },
  })
}

export function createReinventedHelperTools(
  src: Pick<SourceRuntime, 'readFile'>,
  cwd: string,
  findings: ReinventedHelperFinding[],
): AgentTool[] {
  return [
    createReadFileTool(src, cwd),
    createReportFindingTool(findings),
  ]
}

export function createReportFindingTool(findings: ReinventedHelperFinding[]): AgentTool {
  return defineTool({
    description: 'Report one helper function that duplicates a utility already available in the repo or a dependency. Call once per finding.',
    execute: (input) => {
      const finding = input as ReinventedHelperFinding

      // Idempotency guard
      if (findings.some(existing => existing.line === finding.line)) {
        return `Already recorded a finding for line ${finding.line}.`
      }

      findings.push({
        line: finding.line,
        message: finding.message,
        suggestion: finding.suggestion,
      })

      return 'recorded'
    },
    name: 'report_finding',
    parameters: {
      additionalProperties: false,
      properties: {
        line: { description: 'Declaration line of the duplicated helper in the target file.', type: 'number' },
        message: { description: 'What the helper duplicates and why it is redundant. Keep it short.', type: 'string' },
        suggestion: { description: 'One concrete direction to remove the duplication.', type: 'string' },
      },
      required: ['line', 'message', 'suggestion'],
      type: 'object',
    },
  })
}

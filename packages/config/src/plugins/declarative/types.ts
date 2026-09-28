import { array, description, number, object, optional, picklist, pipe, string } from 'valibot'

export const builtInAgentNames = ['basic-structured', 'basic-coding-agent'] as const
export const declarativeRuleFilePattern = '**/rule.alint.{toml,yaml,yml,json,jsonc,json5}'

export type BuiltInAgentName = typeof builtInAgentNames[number]

export interface DeclarativeFinding {
  confidence?: 'high' | 'low' | 'medium'
  filePath?: string
  line: number
  message: string
  suggestion?: string
}

export interface DeclarativeFindingResponse {
  findings: DeclarativeFinding[]
}

export const declarativeFindingSchema = pipe(
  object({
    confidence: optional(pipe(
      picklist(['high', 'medium', 'low']),
      description('Confidence in this finding. Use exactly "high", "medium", or "low" when confidence is known.'),
    )),
    filePath: optional(pipe(
      string(),
      description('Path to the file that owns this finding. Omit when the finding belongs to the reviewed target file.'),
    )),
    line: pipe(
      number(),
      description('Use the left-column line number from the numbered source block.'),
    ),
    message: pipe(
      string(),
      description('Human-readable diagnostic message describing the problem the target must fix. Never describe the absence of a problem.'),
    ),
    suggestion: optional(pipe(
      string(),
      description('Concrete remediation direction for the finding.'),
    )),
  }),
  description('One declarative rule finding. Report only a change the reviewed target must make.'),
)

export const declarativeFindingResponseSchema = pipe(
  object({
    findings: pipe(
      array(declarativeFindingSchema),
      description('All findings for the declarative rule. Return an empty array when there are no issues, and never add a finding that only states the target is already correct.'),
    ),
  }),
  description('Structured declarative rule findings.'),
)

export interface DeclarativeRuleDefinition {
  builtInAgent: BuiltInAgentName
  excludeFiles: string[]
  filePath: string
  includeFiles?: string[]
  instruction: string
  name: string
}

export function isBuiltInAgentName(value: unknown): value is BuiltInAgentName {
  return builtInAgentNames.includes(value as BuiltInAgentName)
}

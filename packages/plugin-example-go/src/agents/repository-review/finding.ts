import type { AgentTool } from '@alint-js/core/agent'

import { defineTool } from '@alint-js/core/agent'
import { toolParametersFromSchema } from '@alint-js/core/structured-output'
import {
  array,
  description,
  integer,
  maxValue,
  minLength,
  minValue,
  nullable,
  number,
  picklist,
  pipe,
  safeParse,
  strictObject,
  string,
} from 'valibot'

export type NonEmptyCategories<Category extends string> = readonly [Category, ...Category[]]

export interface RepositoryFinding<Category extends string = string> {
  category: Category
  futureFailure?: string
  line: number
  message: string
  proof: string
  relatedLocations: string[]
  suggestion: string
}

export type RepositoryFindingWithRequiredEvidence<Category extends string = string> = Omit<
  RepositoryFinding<Category>,
  'futureFailure' | 'relatedLocations'
> & {
  futureFailure: string
  relatedLocations: [string, ...string[]]
}

export interface SubmitReviewController<Category extends string> {
  getFindings: () => RepositoryFinding<Category>[] | undefined
  tool: AgentTool
}

interface SubmitReviewOptions<Category extends string> {
  allowedCategories: NonEmptyCategories<Category>
  lineCount: number
  requireFutureFailure: boolean
  requireRelatedLocations: boolean
}

export function createSubmitReviewTool<Category extends string>(
  options: SubmitReviewOptions<Category>,
): SubmitReviewController<Category> {
  const schema = createSubmissionSchema(options)
  let submitted: RepositoryFinding<Category>[] | undefined

  return {
    getFindings: () => submitted,
    tool: defineTool({
      description: 'Submit all repository findings, or an empty array when the review is clean.',
      execute: async (input) => {
        if (submitted) {
          return 'review rejected: submit_review was already called'
        }

        const result = safeParse(schema, input)

        if (!result.success) {
          return `review rejected: ${result.issues[0]?.message ?? 'invalid findings'}`
        }

        submitted = result.output.findings.map(finding => ({
          category: finding.category,
          ...(finding.futureFailure
            ? {
                futureFailure: finding.futureFailure.trim(),
              }
            : {}),
          line: finding.line,
          message: finding.message.trim(),
          proof: finding.proof.trim(),
          relatedLocations: finding.relatedLocations.map(location => location.trim()),
          suggestion: finding.suggestion.trim(),
        }))

        return 'review submitted'
      },
      name: 'submit_review',
      parameters: {
        ...toolParametersFromSchema(schema),
      },
    }),
  }
}

function createSubmissionSchema<Category extends string>(options: SubmitReviewOptions<Category>) {
  const text = (label: string) => pipe(string(), minLength(1, `${label} must not be empty.`))
  const relatedLocations = options.requireRelatedLocations
    ? pipe(
        array(text('relatedLocations entry')),
        minLength(1, 'relatedLocations must contain repository evidence.'),
      )
    : array(text('relatedLocations entry'))
  const futureFailure = options.requireFutureFailure
    ? text('futureFailure')
    : nullable(text('futureFailure'))
  const finding = strictObject({
    category: picklist(options.allowedCategories),
    futureFailure,
    line: pipe(number(), integer(), minValue(1), maxValue(options.lineCount)),
    message: text('message'),
    proof: text('proof'),
    relatedLocations,
    suggestion: text('suggestion'),
  })

  return pipe(
    strictObject({
      findings: array(finding),
    }),
    description('The complete repository review. Use findings: [] when clean.'),
  )
}

import type { AgentTool } from '@alint-js/core/agent'

import type { IndexedHelper, RepoIndex } from '../../repo'

import { defineTool } from '@alint-js/core/agent'

import { similarTo } from '../../repo'

export interface AgentFinding {
  helperId: string
  reason: string
  twinId: string
}

export interface DuplicateToolsOptions {
  /** Mutated by `report_duplicate`; the caller reads it once the agent stops. */
  findings: AgentFinding[]
  index: RepoIndex
  /** Helpers of the file under review: the only ones the agent may report on. */
  reviewing: readonly IndexedHelper[]
}

/*
 * Tool output follows SWE-agent (https://arxiv.org/abs/2405.15793): searches return `id name`
 * lines and never the matched code, and empty or truncated lists say so in words.
 *
 * OpenAI's strict function calling needs every property listed in `required`, with the optional
 * ones typed nullable, or the request 400s. An omitted argument arrives as `null`.
 */

/** The most helpers any tool will list at once, so a broad filter cannot flood the loop. */
const LIST_LIMIT = 40

export function createDuplicateTools(options: DuplicateToolsOptions): AgentTool[] {
  return [
    createListHelpersTool(options.index),
    createGetHelperTool(options.index),
    createFindSimilarTool(options.index),
    createSearchHelperBodiesTool(options.index),
    createReportDuplicateTool(options),
  ]
}

function clamp(limit: null | number | undefined, fallback: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) {
    return fallback
  }

  return Math.min(Math.floor(limit), LIST_LIMIT)
}

function createFindSimilarTool(index: RepoIndex): AgentTool {
  return defineTool({
    description: [
      'Rank the helpers most textually similar to a given helper, closest first.',
      'The ranking is a crude token-overlap score: it is a hint about where to look, NOT evidence of duplication.',
      'Two helpers can score high and do entirely different things. Read them with get_helper before deciding.',
    ].join(' '),
    execute: (input) => {
      const { id, limit } = input as { id: string, limit?: null | number }
      const helper = index.byId.get(id)

      if (helper === undefined) {
        return unknownId(id)
      }

      const ranked = similarTo(index, helper, clamp(limit, 10))

      if (ranked.length === 0) {
        return `No other ${helper.language} helper shares any token with ${id}.`
      }

      return ranked.map(other => `${other.id}  ${other.name}  (${other.lines} lines)`).join('\n')
    },
    name: 'find_similar',
    parameters: {
      additionalProperties: false,
      properties: {
        id: { description: 'Helper id, as `path:line`.', type: 'string' },
        limit: {
          description: 'How many to return. Null for 10.',
          type: ['number', 'null'],
        },
      },
      required: ['id', 'limit'],
      type: 'object',
    },
  })
}

function createGetHelperTool(index: RepoIndex): AgentTool {
  return defineTool({
    description: 'Read one helper in full, by id. Use this before deciding anything about it.',
    execute: (input) => {
      const { id } = input as { id: string }
      const helper = index.byId.get(id)

      if (helper === undefined) {
        return unknownId(id)
      }

      return [`${helper.id} (${helper.language})`, '', helper.text].join('\n')
    },
    name: 'get_helper',
    parameters: {
      additionalProperties: false,
      properties: {
        id: { description: 'Helper id, as `path:line`.', type: 'string' },
      },
      required: ['id'],
      type: 'object',
    },
  })
}

function createListHelpersTool(index: RepoIndex): AgentTool {
  return defineTool({
    description: [
      'List the small helpers indexed across the whole workspace, as `id name` lines.',
      'Filter to keep the list short. Use get_helper to read any of them.',
    ].join(' '),
    execute: (input) => {
      const { directory, language, name_contains: nameContains } = input as {
        directory?: null | string
        language?: null | string
        name_contains?: null | string
      }

      const matched = index.helpers.filter(helper =>
        (!directory || helper.id.startsWith(directory))
        && (!language || helper.language === language)
        && (!nameContains || helper.name.toLowerCase().includes(nameContains.toLowerCase())),
      )

      if (matched.length === 0) {
        return 'No helper matched. Try a broader filter, or drop one.'
      }

      const shown = matched.slice(0, LIST_LIMIT)
      const lines = shown.map(helper => `${helper.id}  ${helper.name}  (${helper.lines} lines, ${helper.language})`)

      if (matched.length > shown.length) {
        lines.push(`… and ${matched.length - shown.length} more. Narrow the filter to see them.`)
      }

      return lines.join('\n')
    },
    name: 'list_helpers',
    parameters: {
      additionalProperties: false,
      properties: {
        directory: {
          description: 'Keep only helpers whose path starts with this, e.g. `packages/cli/`. Null for all.',
          type: ['string', 'null'],
        },
        language: {
          description: 'One of: go, javascript, python, rust, tsx, typescript. Null for all.',
          type: ['string', 'null'],
        },
        name_contains: {
          description: 'Keep only helpers whose name contains this, case-insensitively. Null for all.',
          type: ['string', 'null'],
        },
      },
      required: ['directory', 'language', 'name_contains'],
      type: 'object',
    },
  })
}

function createReportDuplicateTool(options: DuplicateToolsOptions): AgentTool {
  const { findings, index, reviewing } = options
  const reviewable = new Set(reviewing.map(helper => helper.id))

  return defineTool({
    description: [
      'Report that a helper in the file under review duplicates another helper elsewhere.',
      'Call once per duplicated helper. Identical and renamed copies are already reported without you — do not report those.',
    ].join(' '),
    execute: (input) => {
      const finding = input as AgentFinding

      // These checks live in the tool, not the instructions: a tool can refuse and say what to
      // do instead, so a provably wrong pair is corrected here rather than becoming a diagnostic.
      if (!reviewable.has(finding.helperId)) {
        return `"${finding.helperId}" is not a helper of the file under review. Report only the helpers listed in the task, and pass the OTHER helper as twin_id.`
      }

      const twin = index.byId.get(finding.twinId)

      if (twin === undefined) {
        return unknownId(finding.twinId)
      }

      if (finding.twinId === finding.helperId) {
        return 'A helper cannot duplicate itself. Pass the other helper as twin_id.'
      }

      const helper = index.byId.get(finding.helperId)

      if (helper && twin.language !== helper.language) {
        return `${finding.helperId} is ${helper.language} and ${finding.twinId} is ${twin.language}. A helper in one language cannot share a home with one in another, so this is not reportable.`
      }

      if (typeof finding.reason !== 'string' || finding.reason.trim() === '') {
        return 'reason is required: name the shared responsibility in at most twelve words.'
      }

      // The reason is read at the end of a diagnostic line, so a long one is skipped, not read.
      if (finding.reason.trim().split(/\s+/).length > 14) {
        return `Too long (${finding.reason.trim().split(/\s+/).length} words). Name only the responsibility the two share, in at most twelve words. Not what each one does, and not what should be done about it.`
      }

      if (findings.some(existing => existing.helperId === finding.helperId && existing.twinId === finding.twinId)) {
        return `Already recorded ${finding.helperId} against ${finding.twinId}.`
      }

      findings.push({
        helperId: finding.helperId,
        reason: finding.reason.trim(),
        twinId: finding.twinId,
      })

      return `Recorded: ${finding.helperId} duplicates ${finding.twinId}.`
    },
    name: 'report_duplicate',
    parameters: {
      additionalProperties: false,
      properties: {
        helperId: { description: 'Id of the helper in the file under review.', type: 'string' },
        reason: { description: 'The responsibility both helpers carry, in at most twelve words. e.g. "Both ask whether an error is a missing-file error."', type: 'string' },
        twinId: { description: 'Id of the helper it duplicates.', type: 'string' },
      },
      required: ['helperId', 'reason', 'twinId'],
      type: 'object',
    },
  })
}

function createSearchHelperBodiesTool(index: RepoIndex): AgentTool {
  return defineTool({
    description: [
      'Search helper BODIES for a literal substring, and get back the helpers that contain it, as `id name` lines.',
      'This is how you find a helper that does the same thing under a different name: search what it DOES.',
      'Bodies are searched with comments and formatting removed, so search for code, e.g. `instanceof Error` or `.trim()`.',
    ].join(' '),
    execute: (input) => {
      const { language, query } = input as { language?: null | string, query: string }

      if (typeof query !== 'string' || query.trim() === '') {
        return 'query is required: a literal substring of the code you are looking for.'
      }

      const needle = query.toLowerCase()
      const matched = index.helpers.filter(helper =>
        (!language || helper.language === language)
        && helper.body.toLowerCase().includes(needle),
      )

      if (matched.length === 0) {
        return `No helper body contains "${query}". Try a shorter or more distinctive fragment.`
      }

      const shown = matched.slice(0, LIST_LIMIT)
      const lines = shown.map(helper => `${helper.id}  ${helper.name}  (${helper.lines} lines, ${helper.language})`)

      if (matched.length > shown.length) {
        lines.push(`… and ${matched.length - shown.length} more. Use a longer fragment to narrow it.`)
      }

      return lines.join('\n')
    },
    name: 'search_helper_bodies',
    parameters: {
      additionalProperties: false,
      properties: {
        language: {
          description: 'One of: go, javascript, python, rust, tsx, typescript. Null for all.',
          type: ['string', 'null'],
        },
        query: { description: 'A literal fragment of code to look for inside helper bodies.', type: 'string' },
      },
      required: ['language', 'query'],
      type: 'object',
    },
  })
}

function unknownId(id: string): string {
  return `No helper has the id "${id}". Ids look like \`packages/cli/src/lint.ts:57\`. Use list_helpers or search_helper_bodies to find one.`
}

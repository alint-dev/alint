import type { AgentTool } from '@alint-js/core/agent'

import type { SearchOptions } from './search'

import { relative, resolve } from 'node:path'

import { DEFAULT_IGNORE_PATTERNS, listFiles, toStringArray } from './list'
import { readFile } from './read'
import { searchFiles, searchInFiles } from './search'

export type { ListFilesOptions } from './list'
export type { SearchOptions } from './search'
export { DEFAULT_IGNORE_PATTERNS, listFiles, readFile, searchFiles, searchInFiles, toStringArray }

export interface CreateToolsOptions {
  ignore?: readonly string[] | string
}

export function createTools(cwd: string, options: CreateToolsOptions = {}): AgentTool[] {
  const baseIgnore = options.ignore === undefined
    ? DEFAULT_IGNORE_PATTERNS
    : toStringArray(options.ignore)

  return [
    {
      description: 'Read a UTF-8 text file. The path may be relative to the project root or absolute.',
      execute: input => readFile(cwd, getStringProperty(input, 'path')),
      name: 'read_file',
      parameters: {
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
        type: 'object',
      },
    },
    {
      description: 'List files under a directory with optional glob patterns and ignore patterns.',
      execute: async (input) => {
        const listOptions = getListOptions(input, baseIgnore)
        const dir = resolve(cwd, listOptions.directory ?? '.')
        const files = await listFiles(dir, listOptions)

        return files.map(path => relative(cwd, path)).join('\n')
      },
      name: 'list_files',
      parameters: fileSearchParameters(false),
    },
    {
      description: 'Search listed file paths by substring. Use search_in_files to search file contents.',
      execute: input => searchFiles(cwd, getRequiredStringProperty(input, 'query'), getListOptions(input, baseIgnore)),
      name: 'search_files',
      parameters: fileSearchParameters(true),
    },
    {
      description: 'Search file contents by literal substring and return path:line snippets.',
      execute: input => searchInFiles(cwd, getRequiredStringProperty(input, 'query'), getListOptions(input, baseIgnore)),
      name: 'search_in_files',
      parameters: fileSearchParameters(true),
    },
  ]
}

function fileSearchParameters(requiresQuery: boolean): Record<string, unknown> {
  const properties = {
    directory: nullableStringSchema(),
    ignore: stringOrStringArraySchema(),
    patterns: stringOrStringArraySchema(),
    ...(requiresQuery
      ? {
          query: { type: 'string' },
        }
      : {}),
  }

  return {
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
    type: 'object',
  }
}

function getListOptions(input: unknown, baseIgnore: readonly string[]): SearchOptions {
  return {
    directory: getStringProperty(input, 'directory'),
    ignore: [
      ...baseIgnore,
      ...toStringArray(getStringOrStringArrayProperty(input, 'ignore')),
    ],
    patterns: getStringOrStringArrayProperty(input, 'patterns'),
  }
}

function getRequiredStringProperty(input: unknown, key: string): string {
  const value = getStringProperty(input, key)

  if (value === undefined) {
    throw new TypeError(`Expected tool input property "${key}" to be a string`)
  }

  return value
}

function getStringOrStringArrayProperty(input: unknown, key: string): readonly string[] | string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined
  }

  const value = (input as Record<string, unknown>)[key]

  if (typeof value === 'string') {
    return value
  }

  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value
    : undefined
}

function getStringProperty(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined
  }

  const value = (input as Record<string, unknown>)[key]

  return typeof value === 'string'
    ? value
    : undefined
}

function nullableStringSchema(): Record<string, unknown> {
  return {
    anyOf: [
      { type: 'string' },
      { type: 'null' },
    ],
  }
}

function stringOrStringArraySchema(): Record<string, unknown> {
  return {
    anyOf: [
      { type: 'string' },
      {
        items: { type: 'string' },
        type: 'array',
      },
      { type: 'null' },
    ],
  }
}

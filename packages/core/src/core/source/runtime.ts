import type { BaseSourceFile, LineRange, SourceFile, SourcePosition, SourceRange, SourceRuntime, SourceText } from './types'

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

import { clamp } from 'es-toolkit'

import { hashText } from '../hash'

export interface SourceRuntimeOptions {
  /**
   * Extraction for arbitrary files, injected by the run.
   *
   * The runtime cannot do this itself: extraction resolves the file's own config, and importing
   * config resolution here would point the source module back at the layers built on top of it.
   * `runAlint` has the config in scope before it builds the runtime, so it passes the closure down.
   */
  extract?: SourceRuntime['extract']
  /**
   * Replaces the complete source read operation, including descriptor validation. The other
   * members need no override: `getText` and the slicers are pure functions over whatever
   * `readFile` returned, and `extract` already defaults to a throwing stub outside a run.
   */
  readFile?: SourceRuntime['readFile']
}

export class SourceChangedError extends Error {
  constructor(
    readonly path: string,
    readonly expectedHash: string,
    readonly actualHash: string,
  ) {
    super(`Source changed after planning: "${path}" (expected ${expectedHash}, read ${actualHash}).`)
    this.name = 'SourceChangedError'
  }
}

export function createSourceFile(path: string, text: string): SourceFile {
  return {
    contentHash: hashText(text),
    language: inferLanguage(path),
    lines: text.split(/\r?\n/),
    path,
    text,
  }
}

export function createSourceRuntime(options: SourceRuntimeOptions = {}): SourceRuntime {
  return {
    extract: options.extract ?? extractThrowUndefined,
    getText,
    readFile: options.readFile ?? readSourceFile,
    sliceLines,
    sliceRange,
  }
}

export function getText(file: SourceFile): string {
  return file.text
}

export function sliceLines(file: SourceFile, range: LineRange): SourceText {
  const startLine = clampLine(range.startLine, file.lines.length)
  const endLine = clampLine(range.endLine, file.lines.length)
  const orderedStartLine = Math.min(startLine, endLine)
  const orderedEndLine = Math.max(startLine, endLine)
  const text = file.lines.slice(orderedStartLine - 1, orderedEndLine).join('\n')

  return {
    filePath: file.path,
    loc: {
      end: {
        column: file.lines[orderedEndLine - 1]?.length ?? 0,
        line: orderedEndLine,
      },
      start: {
        column: 0,
        line: orderedStartLine,
      },
    },
    text,
  }
}

export function sliceRange(file: SourceFile, range: SourceRange): SourceText {
  const start = clampOffset(range.start, file.text.length)
  const end = clampOffset(range.end, file.text.length)
  const orderedStart = Math.min(start, end)
  const orderedEnd = Math.max(start, end)

  return {
    filePath: file.path,
    loc: {
      end: getPosition(file.text, orderedEnd),
      start: getPosition(file.text, orderedStart),
    },
    text: file.text.slice(orderedStart, orderedEnd),
  }
}

export function withLanguage(file: SourceFile, language: string): SourceFile {
  if (file.language === language) {
    return file
  }

  return { ...file, language }
}

function clampLine(line: number, lineCount: number): number {
  if (lineCount === 0) {
    return 1
  }

  return clamp(Math.trunc(line), 1, lineCount)
}

function clampOffset(offset: number, textLength: number): number {
  return clamp(Math.trunc(offset), 0, textLength)
}

/** Throws a TypeError indicating that the extractor is not defined. */
function extractThrowUndefined(filePath: string): ReturnType<SourceRuntime['extract']> {
  return Promise.reject(new TypeError(
    `Cannot extract "${filePath}": this source runtime was created without an extractor, so there is no config to resolve the file's language against. Only the runtime a run hands to rules (ctx.src) can extract.`,
  ))
}

function getPosition(text: string, offset: number): SourcePosition {
  let line = 1
  let column = 0
  let index = 0

  while (index < offset) {
    const character = text[index]

    if (character === '\r') {
      if (text[index + 1] === '\n' && index + 1 < offset) {
        index += 1
      }

      line += 1
      column = 0
    }
    else if (character === '\n') {
      line += 1
      column = 0
    }
    else {
      column += 1
    }

    index += 1
  }

  return { column, line }
}

function inferLanguage(path: string): SourceFile['language'] {
  switch (extname(path)) {
    case '.cjs':
    case '.js':
    case '.jsx':
    case '.mjs':
      return 'javascript'
    case '.cts':
    case '.mts':
    case '.ts':
    case '.tsx':
      return 'typescript'
    default:
      return 'unknown'
  }
}

async function readSourceFile(input: BaseSourceFile | string): Promise<SourceFile> {
  const path = typeof input === 'string'
    ? input
    : input.path
  const file = createSourceFile(path, await readFile(path, 'utf8'))
  if (typeof input !== 'string') {
    if (file.contentHash !== input.contentHash)
      throw new SourceChangedError(input.path, input.contentHash, file.contentHash)
  }
  return file
}

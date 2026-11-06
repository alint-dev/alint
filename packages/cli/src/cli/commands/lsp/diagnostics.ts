import type { Diagnostic } from '@alint-js/core'
import type { Diagnostic as LspDiagnostic, Range as LspRange } from 'vscode-languageserver'

/**
 * End column for a whole-line range.
 *
 * NOTICE: LSP clamps a character above the line length back to the line length, so the server can
 * mark a whole line without reading the file. Reading every file would cost a second pass over the
 * workspace. The value must stay inside `uinteger` (0..2^31-1), so it is not `MAX_SAFE_INTEGER`.
 * https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#position
 */
export const WHOLE_LINE = 2147483647

/** alint reports 1-based lines and 0-based columns. LSP uses 0-based for both. */
export function toLspDiagnostic(diagnostic: Diagnostic): LspDiagnostic {
  return {
    code: diagnostic.ruleId,
    message: diagnostic.message,
    range: toRange(diagnostic),
    severity: diagnostic.severity === 'error'
      ? 1
      : 2,
    source: 'alint',
  }
}

function toLineIndex(line: number): number {
  return Math.max(line - 1, 0)
}

function toRange(diagnostic: Diagnostic): LspRange {
  const { loc } = diagnostic

  // A file-level diagnostic has no position. Any other line would point at unrelated code.
  if (!loc) {
    return {
      end: { character: 0, line: 0 },
      start: { character: 0, line: 0 },
    }
  }

  const line = toLineIndex(loc.start.line)

  // Rules often report a start with no end. An editor shows nothing for a zero-width range.
  if (!loc.end) {
    return {
      end: { character: WHOLE_LINE, line },
      start: { character: 0, line },
    }
  }

  return {
    end: {
      character: loc.end.column,
      line: toLineIndex(loc.end.line),
    },
    start: { character: loc.start.column, line },
  }
}

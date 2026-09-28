import type { DeclarativeFinding } from './types'

import { describe, expect, it } from 'vitest'

import { filterActionableFindings, isActionableFinding } from './findings'

function createFinding(message: string, suggestion?: string): DeclarativeFinding {
  return {
    line: 1,
    message,
    ...(suggestion === undefined ? {} : { suggestion }),
  }
}

describe('isActionableFinding', () => {
  it.each([
    'No violations found.',
    'No security issues were detected in this file.',
    'No changes needed.',
    'No action required for this target.',
    'Nothing to fix.',
    'Nothing needs to change.',
    'The module is compliant with the rule.',
    'This target appears compliant.',
    'The helper complies with the layering rule.',
    'Everything looks good.',
    'LGTM',
    '无需修改',
    '没有违规',
    '未发现问题',
    '符合规范要求',
    '无需改动',
  ])('drops the compliance statement %j', (message) => {
    expect(isActionableFinding(createFinding(message))).toBe(false)
  })

  it.each([
    'Missing guard clause before the loop.',
    'No guard clause guards the empty input.',
    'This helper is not compliant with the layering rule.',
    'The module does not comply with the naming convention.',
    'This helper is not compliant, it re-implements the caller retry logic.',
    'The parser silently drops trailing tokens.',
    'Handler duplicates the retry logic from the caller.',
    '应该给这个分支补一个 guard。',
  ])('keeps the real finding %j', (message) => {
    expect(isActionableFinding(createFinding(message))).toBe(true)
  })

  it('keeps a real violation even when its suggestion says nothing else is needed', () => {
    expect(isActionableFinding(createFinding(
      'The helper is never awaited.',
      'No changes needed beyond adding the await.',
    ))).toBe(true)
  })
})

describe('filterActionableFindings', () => {
  it('keeps only the findings the target can act on', () => {
    expect(filterActionableFindings([
      createFinding('No violations found.'),
      createFinding('The helper duplicates the caller retry logic.'),
      createFinding('无需修改'),
    ])).toEqual([
      createFinding('The helper duplicates the caller retry logic.'),
    ])
  })
})

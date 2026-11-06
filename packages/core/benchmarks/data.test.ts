import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { createLargeFile, createManyFiles } from './data'

describe('benchmark fixtures', () => {
  it('creates exact deterministic shapes', () => {
    const expected = [
      {
        path: 'src/file-0.ts',
        text: [
          'export function value_0_0() { return 0 }',
          'export function value_0_1() { return 1 }',
          'export function value_0_2() { return 2 }',
        ].join('\n'),
      },
      {
        path: 'src/file-1.ts',
        text: [
          'export function value_1_0() { return 0 }',
          'export function value_1_1() { return 1 }',
          'export function value_1_2() { return 2 }',
        ].join('\n'),
      },
    ]

    expect(createManyFiles(2, 3)).toEqual(expected)
    expect(createManyFiles(2, 3)).toEqual(createManyFiles(2, 3))
  })

  it('pads large files without truncating TypeScript tokens', () => {
    const line = 'export const value = 1\n'
    const lineBytes = Buffer.byteLength(line)
    const equivalent20MiBRemainder = 2 * lineBytes + (20 * 1024 * 1024) % lineBytes

    for (const bytes of [
      0,
      5,
      lineBytes,
      1024,
      equivalent20MiBRemainder,
    ]) {
      const fixture = createLargeFile(bytes)
      const fullLines = Math.floor(bytes / lineBytes)
      const padding = bytes % lineBytes

      expect(fixture).toEqual({
        path: 'src/large.ts',
        text: `${line.repeat(fullLines)}${' '.repeat(padding)}`,
      })
      expect(Buffer.byteLength(fixture.text)).toBe(bytes)
      expect(fixture.text).toMatch(/^(?:export const value = 1\n)* *$/)
      expect(createLargeFile(bytes)).toEqual(fixture)
    }
  })
})

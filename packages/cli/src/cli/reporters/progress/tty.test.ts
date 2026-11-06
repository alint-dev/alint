import { describe, expect, it } from 'vitest'

import { createTtyProgressRenderer } from './tty'

const clearCurrentLine = '\r\x1B[K'
const clearPreviousLine = '\r\x1B[1A\x1B[K'

describe('createTtyProgressRenderer', () => {
  it('starts an un-reffed timer and renders the first frame', () => {
    const writes: string[] = []
    const interval = {
      unref() {
        this.unrefCalled = true
      },
      unrefCalled: false,
    }
    let intervalCallback: (() => void) | undefined
    let intervalMs: number | undefined

    const renderer = createTtyProgressRenderer({
      clearInterval: () => {},
      createInterval: (callback, ms) => {
        intervalCallback = callback
        intervalMs = ms

        return interval
      },
      getRows: () => ['first', 'second'],
      intervalMs: 120,
      write: chunk => writes.push(chunk),
    })

    renderer.start()

    expect(intervalCallback).toBeTypeOf('function')
    expect(intervalMs).toBe(120)
    expect(interval.unrefCalled).toBe(true)
    expect(writes).toEqual(['first\nsecond'])
  })

  it('clears the previous frame before redrawing rows', () => {
    const writes: string[] = []
    let rows = ['first', 'second']

    const renderer = createTtyProgressRenderer({
      clearInterval: () => {},
      createInterval: () => ({}),
      getRows: () => rows,
      intervalMs: 120,
      write: chunk => writes.push(chunk),
    })

    renderer.render()
    rows = ['third', 'fourth']
    renderer.render()

    expect(writes).toEqual([
      'first\nsecond',
      `${clearCurrentLine}${clearPreviousLine}`,
      'third\nfourth',
    ])
  })

  it('clears the interval and visible frame on finish', () => {
    const writes: string[] = []
    const interval = {}
    const cleared: unknown[] = []

    const renderer = createTtyProgressRenderer({
      clearInterval: handle => cleared.push(handle),
      createInterval: () => interval,
      getRows: () => ['first', 'second', 'third'],
      intervalMs: 120,
      write: chunk => writes.push(chunk),
    })

    renderer.start()
    renderer.finish()

    expect(cleared).toEqual([interval])
    expect(writes).toEqual([
      'first\nsecond\nthird',
      `${clearCurrentLine}${clearPreviousLine}${clearPreviousLine}`,
    ])
  })

  it('clears and redraws around external writes while active', () => {
    const writes: string[] = []

    const renderer = createTtyProgressRenderer({
      clearInterval: () => {},
      createInterval: () => ({}),
      getRows: () => ['first', 'second'],
      intervalMs: 120,
      write: chunk => writes.push(chunk),
    })

    renderer.start()
    renderer.write('noise\n')

    expect(writes).toEqual([
      'first\nsecond',
      `${clearCurrentLine}${clearPreviousLine}`,
      'noise\n',
      'first\nsecond',
    ])
  })

  it('clears the live window before writing after finish', () => {
    const chunks: string[] = []
    const renderer = createTtyProgressRenderer({
      clearInterval: () => {},
      createInterval: () => ({
        unref: () => {},
      }),
      getRows: () => ['live row', 'footer row'],
      intervalMs: 120,
      write: chunk => chunks.push(chunk),
    })

    renderer.start()
    renderer.finish()
    renderer.write('final failure\n')

    expect(chunks).toEqual([
      'live row\nfooter row',
      `${clearCurrentLine}${clearPreviousLine}`,
      'final failure\n',
    ])
    expect(chunks.join('').endsWith('final failure\n')).toBe(true)
    expect(chunks.join('')).not.toContain('final failure\nlive row\nfooter row')
  })
})

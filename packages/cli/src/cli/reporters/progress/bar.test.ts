import { describe, expect, it } from 'vitest'

import { formatMiniBar } from './bar'

describe('formatMiniBar', () => {
  it('renders an adaptive bar with a leading sweep highlight', () => {
    expect(formatMiniBar({
      completed: 5,
      planned: 10,
      tick: 0,
      width: 10,
    })).toBe('[▓█████░░░░]')
    expect(formatMiniBar({
      completed: 5,
      planned: 10,
      tick: 1,
      width: 10,
    })).toBe('[█▓░███░░░░]')
    expect(formatMiniBar({
      completed: 5,
      planned: 10,
      tick: 2,
      width: 10,
    })).toBe('[██▓░██░░░░]')
    expect(formatMiniBar({
      completed: 5,
      planned: 10,
      tick: 3,
      width: 10,
    })).toBe('[███▓░█░░░░]')
    expect(formatMiniBar({
      completed: 5,
      planned: 10,
      tick: 4,
      width: 10,
    })).toBe('[████▓░░░░░]')
    expect(formatMiniBar({
      completed: 5,
      planned: 10,
      tick: 5,
      width: 10,
    })).toBe('[█████▓░░░░]')
    expect(formatMiniBar({
      completed: 5,
      planned: 10,
      tick: 6,
      width: 10,
    })).toBe('[▓█████░░░░]')
    expect(formatMiniBar({
      completed: 5,
      planned: 10,
      tick: 7,
      width: 10,
    })).toBe('[█▓░███░░░░]')
  })

  it('loops immediately after the highlight reaches the progress frontier', () => {
    expect(formatMiniBar({
      completed: 4,
      planned: 10,
      tick: 4,
      width: 10,
    })).toBe('[████▓░░░░░]')
    expect(formatMiniBar({
      completed: 4,
      planned: 10,
      tick: 5,
      width: 10,
    })).toBe('[▓████░░░░░]')
  })

  it('keeps low progress static until the animation threshold', () => {
    expect(formatMiniBar({
      completed: 3,
      planned: 10,
      tick: 0,
      width: 10,
    })).toBe('[███░░░░░░░]')
    expect(formatMiniBar({
      completed: 3,
      planned: 10,
      tick: 1,
      width: 10,
    })).toBe('[███░░░░░░░]')
    expect(formatMiniBar({
      completed: 4,
      planned: 10,
      tick: 0,
      width: 10,
    })).toBe('[▓████░░░░░]')
  })

  it('clamps bar width and omits impossible bars', () => {
    expect(formatMiniBar({
      completed: 1,
      planned: 4,
      tick: 0,
      width: 3,
    })).toBe('')
    expect(formatMiniBar({
      completed: 1,
      planned: 4,
      tick: 0,
      width: 4,
    })).toBe('[█░░░]')
    expect(formatMiniBar({
      completed: 100,
      planned: 100,
      tick: 0,
      width: 20,
    })).toBe('[████████████████]')
  })

  it('returns an empty bar when planned work is zero', () => {
    expect(formatMiniBar({
      completed: 0,
      planned: 0,
      tick: 0,
      width: 10,
    })).toBe('')
  })
})

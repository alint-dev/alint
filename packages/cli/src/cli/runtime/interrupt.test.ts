import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import { bindInterruptSignal } from './interrupt'

describe('bindInterruptSignal', () => {
  it('aborts on the first SIGINT and removes remaining listeners on dispose', () => {
    const source = new EventEmitter()
    const interrupt = bindInterruptSignal(source)

    expect(interrupt.signal.aborted).toBe(false)
    expect(source.listenerCount('SIGINT')).toBe(1)
    expect(source.listenerCount('SIGTERM')).toBe(1)

    source.emit('SIGINT')

    expect(interrupt.signal.aborted).toBe(true)
    expect(source.listenerCount('SIGINT')).toBe(0)
    expect(source.listenerCount('SIGTERM')).toBe(1)

    interrupt.dispose()

    expect(source.listenerCount('SIGINT')).toBe(0)
    expect(source.listenerCount('SIGTERM')).toBe(0)
  })
})

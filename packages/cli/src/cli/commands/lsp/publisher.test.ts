import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createPublisher } from './publisher'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createPublisher', () => {
  it('coalesces repeated queues for one file into a single publish', async () => {
    // An LSP publish contains a whole document, so one publish per diagnostic sends it many times.
    const publish = vi.fn()
    const publisher = createPublisher({ flushMs: 200, publish })

    publisher.queue('file:///a.ts')
    publisher.queue('file:///a.ts')
    publisher.queue('file:///a.ts')
    await vi.advanceTimersByTimeAsync(200)

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith('file:///a.ts')
  })

  it('publishes open files before closed ones in the same flush', async () => {
    // The user is looking at the open document. It must not wait for the rest of the workspace.
    const order: string[] = []
    const publisher = createPublisher({
      flushMs: 200,
      publish: uri => order.push(uri),
    })

    publisher.setOpen('file:///open.ts', true)
    publisher.queue('file:///closed.ts')
    publisher.queue('file:///open.ts')
    await vi.advanceTimersByTimeAsync(200)

    expect(order).toEqual(['file:///open.ts', 'file:///closed.ts'])
  })

  it('publishes nothing before the flush window elapses', async () => {
    const publish = vi.fn()
    const publisher = createPublisher({ flushMs: 200, publish })

    publisher.queue('file:///a.ts')
    await vi.advanceTimersByTimeAsync(199)

    expect(publish).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)

    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('starts a new window for a file queued after its flush', async () => {
    const publish = vi.fn()
    const publisher = createPublisher({ flushMs: 200, publish })

    publisher.queue('file:///a.ts')
    await vi.advanceTimersByTimeAsync(200)
    publisher.queue('file:///a.ts')
    await vi.advanceTimersByTimeAsync(200)

    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('drops a pending flush when disposed', async () => {
    // Disposal happens on shutdown. A later timer writes to a closed connection.
    const publish = vi.fn()
    const publisher = createPublisher({ flushMs: 200, publish })

    publisher.queue('file:///a.ts')
    publisher.dispose()
    await vi.advanceTimersByTimeAsync(200)

    expect(publish).not.toHaveBeenCalled()
  })

  it('tracks open state so a closed file loses its priority', async () => {
    const order: string[] = []
    const publisher = createPublisher({
      flushMs: 200,
      publish: uri => order.push(uri),
    })

    publisher.setOpen('file:///a.ts', true)
    publisher.setOpen('file:///a.ts', false)

    expect(publisher.isOpen('file:///a.ts')).toBe(false)

    publisher.queue('file:///b.ts')
    publisher.queue('file:///a.ts')
    await vi.advanceTimersByTimeAsync(200)

    expect(order).toEqual(['file:///b.ts', 'file:///a.ts'])
  })
})

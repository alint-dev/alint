import type { AgentAdapter, AgentRequest } from './types'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { isRetryableAgentError, RetryableAgentError } from './index'
import { withAgentRetry } from './retry'

const request: AgentRequest = {
  instructions: 'Follow the rule.',
  model: {
    aliases: [],
    capabilities: [],
    id: 'test-model',
    name: 'Test Model',
    params: {},
    provider: {
      endpoint: 'https://example.com/v1',
      headers: {},
      id: 'test-provider',
      type: 'openai-compatible',
    },
  },
  prompt: 'Inspect this source.',
  tools: [],
}

afterEach(() => {
  vi.useRealTimers()
})

describe('retryableAgentError', () => {
  it('preserves its message and cause while identifying retryable errors', () => {
    const cause = new Error('upstream failed')
    const error = new RetryableAgentError('retry the invocation', { cause })

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('RetryableAgentError')
    expect(error.message).toBe('retry the invocation')
    expect(error.cause).toBe(cause)
    expect(isRetryableAgentError(error)).toBe(true)
    expect(isRetryableAgentError(new Error('ordinary'))).toBe(false)
  })
})

describe('withAgentRetry', () => {
  it('reports each retry attempt before replaying a retryable invocation', async () => {
    vi.useFakeTimers()
    const retryEvents: Array<{ attempt: number, maxAttempts: number }> = []
    let calls = 0
    const adapter: AgentAdapter = async () => {
      calls += 1
      if (calls < 3)
        throw new RetryableAgentError(`attempt ${calls}`)
      return { answer: 'ok' }
    }

    const result = withAgentRetry(adapter, 2, {
      onRetry: payload => retryEvents.push({
        attempt: payload.attempt,
        maxAttempts: payload.maxAttempts,
      }),
    })(request)

    expect(retryEvents).toEqual([])
    await vi.advanceTimersByTimeAsync(500)
    expect(retryEvents).toEqual([
      { attempt: 1, maxAttempts: 3 },
    ])
    await vi.advanceTimersByTimeAsync(1000)
    await expect(result).resolves.toEqual({ answer: 'ok' })
    expect(retryEvents).toEqual([
      { attempt: 1, maxAttempts: 3 },
      { attempt: 2, maxAttempts: 3 },
    ])
  })

  it('retries a whole invocation twice by default with exponential backoff until it succeeds', async () => {
    vi.useFakeTimers()
    let calls = 0
    const adapter: AgentAdapter = async () => {
      calls += 1
      if (calls < 3)
        throw new RetryableAgentError(`attempt ${calls}`)
      return { answer: 'ok' }
    }

    const result = withAgentRetry(adapter)(request)

    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(499)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(999)
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    await expect(result).resolves.toEqual({ answer: 'ok' })
    expect(calls).toBe(3)
  })

  it('fails ordinary errors immediately without changing their identity', async () => {
    const error = new Error('not replayable')
    let calls = 0
    const adapter: AgentAdapter = async () => {
      calls += 1
      throw error
    }

    await expect(withAgentRetry(adapter, 2)(request)).rejects.toBe(error)
    expect(calls).toBe(1)
  })

  it('does not retry when the retry count is zero', async () => {
    const error = new RetryableAgentError('only attempt')
    const adapter = vi.fn<AgentAdapter>(async () => {
      throw error
    })

    await expect(withAgentRetry(adapter, 0)(request)).rejects.toBe(error)
    expect(adapter).toHaveBeenCalledOnce()
  })

  it('throws the final retryable error unchanged after exhausting retries', async () => {
    vi.useFakeTimers()
    const errors = [
      new RetryableAgentError('first'),
      new RetryableAgentError('second'),
      new RetryableAgentError('last'),
    ]
    let calls = 0
    const adapter: AgentAdapter = async () => {
      const error = errors[calls]
      calls += 1
      throw error
    }

    const result = withAgentRetry(adapter, 2)(request)
    const rejection = expect(result).rejects.toBe(errors[2])
    await vi.runAllTimersAsync()

    await rejection
    expect(calls).toBe(3)
  })

  it('does not call the adapter for a pre-aborted request', async () => {
    const controller = new AbortController()
    const reason = new Error('already aborted')
    controller.abort(reason)
    const adapter = vi.fn<AgentAdapter>(async () => ({ answer: 'unreachable' }))

    await expect(withAgentRetry(adapter, 2)({ ...request, signal: controller.signal }))
      .rejects
      .toBe(reason)
    expect(adapter).not.toHaveBeenCalled()
  })

  it('preserves a null abort reason when the active adapter rejects', async () => {
    const controller = new AbortController()
    const adapterError = new Error('adapter failed after abort')
    let calls = 0
    let rejectAdapter!: (reason?: unknown) => void
    const adapter: AgentAdapter = async () => {
      calls += 1
      return new Promise((_, reject) => {
        rejectAdapter = reject
      })
    }

    const result = withAgentRetry(adapter, 2)({ ...request, signal: controller.signal })
    const rejection = expect(result).rejects.toBeNull()
    controller.abort(null)
    rejectAdapter(adapterError)

    await rejection
    expect(calls).toBe(1)
  })

  it('stops before another adapter call when aborted during backoff', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const reason = new Error('aborted during backoff')
    let calls = 0
    const adapter: AgentAdapter = async () => {
      calls += 1
      throw new RetryableAgentError('retry later')
    }

    const result = withAgentRetry(adapter, 2)({ ...request, signal: controller.signal })
    let settled = false
    void result.finally(() => {
      settled = true
    }).catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(reason)

    await vi.advanceTimersByTimeAsync(499)
    expect(settled).toBe(false)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(result).rejects.toBe(reason)
    expect(calls).toBe(1)
  })
})

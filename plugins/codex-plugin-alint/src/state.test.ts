import { randomUUID } from 'node:crypto'
import { mkdir, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createStateStore, emptyState } from './state'

describe('stop gate plugin state', () => {
  it('stores one state document per session in the plugin data directory', async () => {
    const directory = join(tmpdir(), `alint-plugin-state-${randomUUID()}`)
    const store = createStateStore(directory)
    const state = {
      ...emptyState(),
      lintRounds: 3,
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    await store.save('session-1', state)

    expect(await store.load('session-1')).toEqual(state)
  })

  it('stores the opaque findings fingerprint with the latest summary', async () => {
    const directory = join(tmpdir(), `alint-plugin-state-${randomUUID()}`)
    const store = createStateStore(directory)
    const state = {
      ...emptyState(),
      lastFindings: {
        errorCount: 1,
        findingsHash: 'a'.repeat(64),
        reportPath: '/tmp/report.json',
        status: 'errors' as const,
        warningCount: 0,
      },
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    await store.save('session-findings', state)

    expect(await store.load('session-findings')).toEqual(state)
  })

  it('does not load state from an older schema directory', async () => {
    const directory = join(tmpdir(), `alint-plugin-state-${randomUUID()}`)
    const legacySessions = join(directory, 'stop-gate', 'sessions')
    await mkdir(legacySessions, { recursive: true })
    await writeFile(join(legacySessions, 'session-1.json'), JSON.stringify({
      lintRounds: 8,
      runtimeFailures: 0,
      schemaVersion: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
    }), 'utf8')

    expect(await createStateStore(directory).load('session-1')).toEqual(emptyState())
  })

  it('removes session states older than 365 days whenever it writes', async () => {
    const directory = join(tmpdir(), `alint-plugin-state-${randomUUID()}`)
    const sessions = join(directory, 'stop-gate', 'sessions')
    const expired = join(sessions, 'expired.json')
    const now = new Date('2026-08-03T00:00:00.000Z')
    await mkdir(sessions, { recursive: true })
    await writeFile(expired, `${JSON.stringify(emptyState())}\n`, 'utf8')
    await utimes(expired, new Date('2025-08-02T00:00:00.000Z'), new Date('2025-08-02T00:00:00.000Z'))

    await createStateStore(directory, () => now).save('current', {
      ...emptyState(),
      updatedAt: now.toISOString(),
    })

    await expect(stat(expired)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(directory, 'stop-gate', 'sessions-v2', 'current.json'))).resolves.toBeDefined()
  })

  it('rejects unsafe session ids', async () => {
    const store = createStateStore(tmpdir())

    await expect(store.load('../escape')).rejects.toThrow('Invalid Stop hook session id.')
  })
})

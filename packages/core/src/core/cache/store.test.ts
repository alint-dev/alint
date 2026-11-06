import type { LockOptions } from 'proper-lockfile'

import type { CacheStoreOptions } from './store'
import type { CacheEntry, CacheSlotIdentity } from './types'

import { access, appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createCacheStore,
  createTargetIdentityResolver,
  normalizeCachePath,
  normalizeRunnerCacheConfig,
  readCacheBody,
  resolveCacheLocation,
} from './store'

const slot: CacheSlotIdentity = {
  ruleId: 'demo/rule',
  scope: 'file',
  targetIdentity: 'file:demo.ts',
}

const createRoot = (): Promise<string> => mkdtemp(join(tmpdir(), 'alint-cache-store-'))

function entry(targetHash: string): CacheEntry {
  return {
    diagnostics: [],
    fingerprint: {
      configHash: 'config',
      modelHash: 'model',
      ruleHash: 'rule',
      targetHash,
    },
    target: { hash: targetHash, identity: 'file:demo.ts', kind: 'file' },
    usage: [],
  }
}

const immediateLock: NonNullable<CacheStoreOptions['lock']> = {
  acquire: async () => async () => {},
}

function lockError(code: string, message = code): Error {
  const error = new Error(message)
  Object.assign(error, { code })
  return error
}

describe('cache helpers', () => {
  it('normalizes paths relative to cwd', () => {
    expect(normalizeCachePath('/repo', '/repo/src/demo.ts')).toBe('src/demo.ts')
    expect(normalizeCachePath('/repo', 'src/demo.ts')).toBe('src/demo.ts')
    expect(normalizeCachePath('/repo', '/repo')).toBe('.')
  })

  it('normalizes disabled and object runner cache config', () => {
    expect(normalizeRunnerCacheConfig(false, '/repo')).toEqual({
      enabled: false,
      location: join('/repo', '.alintcache'),
    })
    expect(normalizeRunnerCacheConfig({ location: 'cache/alint.json' }, '/repo')).toEqual({
      enabled: true,
      location: join('/repo', 'cache/alint.json'),
    })
  })

  it('resolves default, file, and directory cache locations', async () => {
    const root = await createRoot()
    expect(resolveCacheLocation('/repo')).toBe(join('/repo', '.alintcache'))
    expect(resolveCacheLocation('/repo', root)).toBe(join(root, '.alintcache'))
    expect(resolveCacheLocation('/repo', `${root}/`)).toBe(join(root, '.alintcache'))
    expect(resolveCacheLocation('/repo', 'cache/alint.json')).toBe(join('/repo', 'cache/alint.json'))
  })

  it('adds ranges only to duplicate target identities', () => {
    const resolveIdentity = createTargetIdentityResolver([
      {
        kind: 'function',
        name: 'handler',
        range: { end: 20, start: 10 },
      },
      {
        kind: 'function',
        name: 'handler',
        range: { end: 40, start: 30 },
      },
      {
        identity: 'same-range',
        kind: 'function',
        range: { end: 20, start: 10 },
      },
      {
        identity: 'same-range',
        kind: 'function',
        range: { end: 20, start: 10 },
      },
    ])
    expect(resolveIdentity({
      kind: 'function',
      name: 'handler',
      range: { end: 20, start: 10 },
    }, 0)).toBe('function:handler:10:20')
    expect(resolveIdentity({
      kind: 'function',
      name: 'handler',
      range: { end: 40, start: 30 },
    }, 1)).toBe('function:handler:30:40')
    expect(resolveIdentity({
      identity: 'same-range',
      kind: 'function',
      range: { end: 20, start: 10 },
    }, 2)).toBe('function:same-range:10:20:2')
  })
})

describe('jsonl cache store', () => {
  it('writes metadata first and appends checkpoint put plus final replace-owner events', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const sourcePath = join(root, 'demo.ts')
    await writeFile(sourcePath, 'demo')
    const store = await createCacheStore({
      alintVersion: '1.0.0',
      cwd: root,
      enabled: true,
      location: cachePath,
    })
    const owner = store.beginOwner({ kind: 'file', path: sourcePath }, { contentHash: 'content' })
    owner.put(slot, entry('checkpoint'))
    await owner.checkpoint()
    owner.commit()
    await store.reconcile()

    const lines = (await readFile(cachePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(lines[0]).toMatchObject({
      alintVersion: '1.0.0',
      magic: 'ALINT_CACHE',
      schemaVersion: 2,
      type: 'metadata',
    })
    expect(lines.slice(1).map(line => line.type)).toEqual(['put', 'replace-owner'])
    expect(Object.values((await readCacheBody(cachePath)).entries)[0]?.fingerprint.targetHash).toBe('checkpoint')
  })

  it('keeps one owner slot while newer fingerprints overwrite older values', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const sourcePath = join(root, 'demo.ts')
    await writeFile(sourcePath, 'demo')
    const store = await createCacheStore({
      alintVersion: '1.0.0',
      cwd: root,
      enabled: true,
      location: cachePath,
    })
    const owner = store.beginOwner({ kind: 'file', path: sourcePath })
    owner.put(slot, entry('first'))
    await owner.checkpoint()
    owner.put(slot, entry('second'))
    await owner.checkpoint()
    owner.commit()
    await store.reconcile()

    const body = await readCacheBody(cachePath)
    expect(Object.keys(body.owners)).toHaveLength(1)
    expect(Object.keys(body.entries)).toHaveLength(1)
    expect(Object.values(body.entries)[0]?.fingerprint.targetHash).toBe('second')
  })

  it('loads past malformed ordinary lines and startup trim physically removes them', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const sourcePath = join(root, 'demo.ts')
    await writeFile(sourcePath, 'demo')
    const initial = await createCacheStore({
      alintVersion: '1.0.0',
      cwd: root,
      enabled: true,
      location: cachePath,
    })
    const owner = initial.beginOwner({ kind: 'file', path: sourcePath })
    owner.put(slot, entry('valid'))
    owner.commit()
    await initial.reconcile()
    await appendFile(cachePath, '{broken ordinary event\n')

    const reopened = await createCacheStore({
      alintVersion: '1.0.0',
      cwd: root,
      enabled: true,
      location: cachePath,
    })
    expect(reopened.beginOwner({ kind: 'file', path: sourcePath }).lookup(slot, entry('valid').fingerprint)).toBeDefined()
    expect(await readFile(cachePath, 'utf8')).not.toContain('{broken ordinary event')
  })

  it('preserves new events after a torn final line when startup trim is busy', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const sourcePath = join(root, 'demo.ts')
    await writeFile(sourcePath, 'demo')
    const initial = await createCacheStore({
      alintVersion: '1.0.0',
      cwd: root,
      enabled: true,
      location: cachePath,
    })
    await initial.reconcile()
    await appendFile(cachePath, '{"type":"put"')
    let lockAttempts = 0
    const reopened = await createCacheStore({
      alintVersion: '1.0.0',
      cwd: root,
      enabled: true,
      location: cachePath,
      lock: {
        acquire: async () => {
          lockAttempts += 1
          if (lockAttempts === 1)
            throw lockError('ELOCKED')
          return async () => {}
        },
      },
    })
    const owner = reopened.beginOwner({ kind: 'file', path: sourcePath })
    owner.put(slot, entry('after-torn-line'))
    owner.commit()
    await reopened.reconcile()

    expect(Object.values((await readCacheBody(cachePath)).entries)[0]?.fingerprint.targetHash).toBe('after-torn-line')
  })

  it('replaces incompatible metadata before appending when startup trim is busy', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const sourcePath = join(root, 'demo.ts')
    const incompatible = {
      alintVersion: '0.0.0',
      createdAt: '2000-01-01T00:00:00.000Z',
      magic: 'ALINT_CACHE',
      schemaVersion: 2,
      type: 'metadata',
    }
    await writeFile(sourcePath, 'demo')
    await writeFile(cachePath, `${JSON.stringify(incompatible)}\n`)
    let lockAttempts = 0
    const store = await createCacheStore({
      alintVersion: '1.0.0',
      cwd: root,
      enabled: true,
      location: cachePath,
      lock: {
        acquire: async () => {
          lockAttempts += 1
          if (lockAttempts === 1)
            throw lockError('ELOCKED')
          return async () => {}
        },
      },
    })
    const owner = store.beginOwner({ kind: 'file', path: sourcePath })
    owner.put(slot, entry('compatible'))
    owner.commit()
    await store.reconcile()

    const metadata = JSON.parse((await readFile(cachePath, 'utf8')).split('\n')[0]!)
    expect(metadata).toMatchObject({ alintVersion: '1.0.0', type: 'metadata' })
    expect(Object.values((await readCacheBody(cachePath)).entries)[0]?.fingerprint.targetHash).toBe('compatible')
  })

  it.each([
    ['damaged metadata', '{broken metadata\n'],
    ['incompatible metadata', `${JSON.stringify({
      alintVersion: '0.0.0',
      createdAt: '2000-01-01T00:00:00.000Z',
      magic: 'ALINT_CACHE',
      schemaVersion: 2,
      type: 'metadata',
    })}\n`],
  ])('rebuilds %s as an empty compatible cache', async (_, original) => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    await writeFile(cachePath, original)
    await createCacheStore({
      alintVersion: '1.0.0',
      cwd: root,
      enabled: true,
      location: cachePath,
    })
    const lines = (await readFile(cachePath, 'utf8')).trim().split('\n')
    expect(JSON.parse(lines[0]!)).toMatchObject({ alintVersion: '1.0.0', type: 'metadata' })
    expect(lines).toHaveLength(1)
  })

  it('does not trim or rewrite read-only cache bytes', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const original = '{broken metadata\nold bytes\n'
    await writeFile(cachePath, original)
    const store = await createCacheStore({
      alintVersion: '1.0.0',
      cwd: root,
      enabled: true,
      location: cachePath,
      readOnly: true,
    })
    await store.reconcile()
    expect(await readFile(cachePath, 'utf8')).toBe(original)
  })

  it('tries startup trim once and skips immediately when the lease is busy', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const optionsSeen: LockOptions[] = []
    const store = await createCacheStore({
      alintVersion: '1.0.0',
      cwd: root,
      enabled: true,
      location: cachePath,
      lock: {
        acquire: async (_path, options) => {
          optionsSeen.push(options)
          throw lockError('ELOCKED')
        },
      },
    })
    expect(optionsSeen).toHaveLength(1)
    expect(optionsSeen[0]).toMatchObject({
      realpath: false,
      retries: 0,
      stale: 20_000,
      update: 3_000,
    })
    await expect(access(cachePath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(store.location).toBe(cachePath)
  })

  it('uses the full append retry policy and retains ordered backlog after failure', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const sourcePath = join(root, 'demo.ts')
    const optionsSeen: LockOptions[] = []
    let appendAttempts = 0
    await writeFile(sourcePath, 'demo')
    const store = await createCacheStore({
      alintVersion: '1.0.0',
      cwd: root,
      enabled: true,
      location: cachePath,
      lock: {
        acquire: async (_path, options) => {
          optionsSeen.push(options)
          if (options.retries === 0)
            return async () => {}
          appendAttempts += 1
          if (appendAttempts === 1)
            throw lockError('ELOCKED')
          return async () => {}
        },
      },
    })
    const owner = store.beginOwner({ kind: 'file', path: sourcePath })
    owner.put(slot, entry('first'))
    await owner.checkpoint()
    owner.put({ ...slot, ruleId: 'demo/second' }, entry('second'))
    owner.commit()
    await store.reconcile()

    expect(optionsSeen[1]).toMatchObject({
      realpath: false,
      retries: {
        factor: 2,
        maxTimeout: 16_000,
        minTimeout: 2_000,
        retries: 4,
      },
      stale: 20_000,
      update: 3_000,
    })
    const body = await readCacheBody(cachePath)
    expect(Object.values(body.entries).map(value => value.fingerprint.targetHash).sort()).toEqual(['first', 'second'])
  })

  it('surfaces only the final reconcile failure after checkpoint failures were tolerated', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const sourcePath = join(root, 'demo.ts')
    const persistenceError = lockError('ELOCKED', 'cache lease unavailable')
    await writeFile(sourcePath, 'demo')
    const store = await createCacheStore({
      alintVersion: '1.0.0',
      cwd: root,
      enabled: true,
      location: cachePath,
      lock: {
        acquire: async (_path, options) => {
          if (options.retries === 0)
            return async () => {}
          throw persistenceError
        },
      },
    })
    const owner = store.beginOwner({ kind: 'file', path: sourcePath })
    owner.put(slot, entry('pending'))
    await expect(owner.checkpoint()).resolves.toBeUndefined()
    owner.commit()
    await expect(store.reconcile()).rejects.toBe(persistenceError)
  })

  it('treats a compromised lease as a failed persistence attempt', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const sourcePath = join(root, 'demo.ts')
    const compromised = new Error('lease compromised')
    await writeFile(sourcePath, 'demo')
    let appendLease = false
    const store = await createCacheStore({
      alintVersion: '1.0.0',
      cwd: root,
      enabled: true,
      location: cachePath,
      lock: {
        acquire: async (_path, options) => {
          if (appendLease)
            options.onCompromised?.(compromised)
          appendLease = true
          return async () => {}
        },
      },
    })
    const owner = store.beginOwner({ kind: 'file', path: sourcePath })
    owner.put(slot, entry('pending'))
    owner.commit()
    await expect(store.reconcile()).rejects.toBe(compromised)
  })

  it('appends remove-owner during reconcile for deleted files', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const sourcePath = join(root, 'demo.ts')
    await writeFile(sourcePath, 'demo')
    const initial = await createCacheStore({
      alintVersion: '1.0.0',
      cwd: root,
      enabled: true,
      location: cachePath,
    })
    const owner = initial.beginOwner({ kind: 'file', path: sourcePath })
    owner.put(slot, entry('present'))
    owner.commit()
    await initial.reconcile()
    await rm(sourcePath)

    const reopened = await createCacheStore({
      alintVersion: '1.0.0',
      cwd: root,
      enabled: true,
      location: cachePath,
    })
    await reopened.reconcile()
    expect((await readFile(cachePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line).type)).toContain('remove-owner')
    expect(Object.keys((await readCacheBody(cachePath)).owners)).toHaveLength(0)
  })

  it('validates only newly appended events rather than scanning old log lines', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const sourcePath = join(root, 'demo.ts')
    await writeFile(sourcePath, 'demo')
    const metadata = {
      alintVersion: '1.0.0',
      createdAt: '2000-01-01T00:00:00.000Z',
      magic: 'ALINT_CACHE',
      schemaVersion: 2,
      type: 'metadata',
    }
    await writeFile(cachePath, `${JSON.stringify(metadata)}\n{"type":"put","bad":true}\n`)
    const store = await createCacheStore({
      alintVersion: '1.0.0',
      cwd: root,
      enabled: true,
      location: cachePath,
      lock: immediateLock,
    })
    const owner = store.beginOwner({ kind: 'file', path: sourcePath })
    owner.put(slot, entry('new'))
    owner.commit()
    await store.reconcile()
    expect(Object.values((await readCacheBody(cachePath)).entries)[0]?.fingerprint.targetHash).toBe('new')
  })

  it('keeps events queued while an append is in progress', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const sourcePath = join(root, 'demo.ts')
    let releaseAppend!: () => void
    let signalAppend!: () => void
    let appendCalls = 0
    const appendCanFinish = new Promise<void>((resolve) => {
      releaseAppend = resolve
    })
    const appendStarted = new Promise<void>((resolve) => {
      signalAppend = resolve
    })
    const delayedAppend: typeof appendFile = async (path, data, options) => {
      appendCalls += 1
      if (appendCalls === 1) {
        signalAppend()
        await appendCanFinish
      }
      await appendFile(path, data, options)
    }
    await writeFile(sourcePath, 'demo')
    const store = await createCacheStore({
      alintVersion: '1.0.0',
      appendFile: delayedAppend,
      cwd: root,
      enabled: true,
      location: cachePath,
      lock: immediateLock,
    })
    const owner = store.beginOwner({ kind: 'file', path: sourcePath })
    owner.put(slot, entry('first'))
    owner.commit()
    const firstFlush = store.flush()
    await appendStarted

    owner.put({ ...slot, ruleId: 'demo/second' }, entry('second'))
    owner.commit({ mode: 'merge' })
    const secondFlush = store.flush()
    releaseAppend()
    await firstFlush
    await secondFlush

    expect(appendCalls).toBe(2)
    expect(Object.values((await readCacheBody(cachePath)).entries).map(value => value.fingerprint.targetHash).sort()).toEqual(['first', 'second'])
  })

  it('treats an oversized metadata line as incompatible without scanning the log', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const sourcePath = join(root, 'demo.ts')
    await writeFile(sourcePath, 'demo')
    await writeFile(cachePath, `${'x'.repeat(8_192)}\nold-event\n`)
    let lockAttempts = 0
    const store = await createCacheStore({
      alintVersion: '1.0.0',
      cwd: root,
      enabled: true,
      location: cachePath,
      lock: {
        acquire: async () => {
          lockAttempts += 1
          if (lockAttempts === 1)
            throw lockError('ELOCKED')
          return async () => {}
        },
      },
    })
    const owner = store.beginOwner({ kind: 'file', path: sourcePath })
    owner.put(slot, entry('new'))
    owner.commit()
    await store.reconcile()

    const text = await readFile(cachePath, 'utf8')
    expect(text).not.toContain('old-event')
    expect(JSON.parse(text.split('\n')[0]!)).toMatchObject({ alintVersion: '1.0.0', type: 'metadata' })
    expect(Object.values((await readCacheBody(cachePath)).entries)[0]?.fingerprint.targetHash).toBe('new')
  })

  it('preserves owner invariants across overlapping replace and merge transactions', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const sourcePath = join(root, 'demo.ts')
    await writeFile(sourcePath, 'demo')
    const store = await createCacheStore({
      alintVersion: '1.0.0',
      cwd: root,
      enabled: true,
      location: cachePath,
    })
    const replaced = store.beginOwner({ kind: 'file', path: sourcePath })
    const merged = store.beginOwner({ kind: 'file', path: sourcePath })
    replaced.put(slot, entry('replaced'))
    merged.put({ ...slot, ruleId: 'demo/merged' }, entry('merged'))
    replaced.commit()
    merged.commit({ mode: 'merge' })
    await store.reconcile()

    const body = await readCacheBody(cachePath)
    const owner = Object.values(body.owners)[0]
    expect(owner?.slots).toHaveLength(2)
    expect(Object.keys(body.entries).sort()).toEqual(owner?.slots)
    expect(Object.values(body.entries).map(value => value.fingerprint.targetHash).sort()).toEqual(['merged', 'replaced'])
  })

  it.each(['non-JSON', 'cyclic', 'accessor'] as const)('rejects %s values without invoking accessors', async (kind) => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const sourcePath = join(root, 'demo.ts')
    let getterCalls = 0
    let evidence: unknown = () => 'not JSON'
    if (kind === 'cyclic') {
      const cyclic: Record<string, unknown> = {}
      cyclic.self = cyclic
      evidence = cyclic
    }
    if (kind === 'accessor') {
      evidence = {}
      Object.defineProperty(evidence, 'computed', {
        enumerable: true,
        get: () => {
          getterCalls += 1
          return 'computed'
        },
      })
    }
    await writeFile(sourcePath, 'demo')
    const malformed = entry('invalid')
    malformed.diagnostics = [
      {
        evidence,
        filePath: sourcePath,
        message: 'bad',
        ruleId: 'demo/rule',
        severity: 'warn',
      },
    ]
    const store = await createCacheStore({
      alintVersion: '1.0.0',
      cwd: root,
      enabled: true,
      location: cachePath,
    })
    const owner = store.beginOwner({ kind: 'file', path: sourcePath })
    owner.put(slot, malformed)
    owner.commit()

    await expect(store.reconcile()).rejects.toThrow()
    expect(getterCalls).toBe(0)
  })

  it('propagates cache read errors instead of rebuilding from an unreadable location', async () => {
    const root = await createRoot()
    const cachePath = join(root, 'x'.repeat(5_000))

    await expect(createCacheStore({
      alintVersion: '1.0.0',
      cwd: root,
      enabled: true,
      location: cachePath,
      readOnly: true,
    })).rejects.toMatchObject({ code: 'ENAMETOOLONG' })
  })

  it('remains a no-op when disabled', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const store = await createCacheStore({ cwd: root, enabled: false, location: cachePath })
    const owner = store.beginOwner({
      kind: 'file',
      path: join(root, 'demo.ts'),
    })
    owner.put(slot, entry('ignored'))
    owner.commit()
    await store.reconcile()
    await expect(access(cachePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

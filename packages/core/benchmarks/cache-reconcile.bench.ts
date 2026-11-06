import type { CacheEntry, CacheFingerprint, CacheOwnerTransaction, CacheSlotIdentity, CacheStore } from '../src/core/cache'

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, bench } from 'vitest'

import { createCacheStore, readCacheBody } from '../src/core/cache'

const ownerCount = 100
const slotsPerOwner = 20
const gcPoolSize = 11
const fingerprint: CacheFingerprint = {
  configHash: 'config',
  modelHash: 'model',
  ruleHash: 'rule',
  targetHash: 'target',
}

interface PreparedFixture {
  cachePath: string
  root: string
  store: CacheStore
}

let gcFixtureIndex = 0
const gcFixtures: PreparedFixture[] = []
let lookupFixture: PreparedFixture
let lookupOwner: CacheOwnerTransaction
let replaceFixture: PreparedFixture
let root: string
let serializeFixture: PreparedFixture

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'alint-cache-reconcile-bench-'))

  lookupFixture = await createFixture('lookup', false)
  const readOnlyLookupStore = await createCacheStore({
    cwd: lookupFixture.root,
    enabled: true,
    location: lookupFixture.cachePath,
    readOnly: true,
  })
  lookupOwner = readOnlyLookupStore.beginOwner({
    kind: 'file',
    path: join(lookupFixture.root, 'src', 'file-0.ts'),
  })
  assertCount('lookup smoke', lookupAll(lookupOwner, 0), slotsPerOwner)

  replaceFixture = await createFixture('replace', false)
  assertCount('replace smoke', replaceOwner(replaceFixture.store, sourcePath(replaceFixture, 0), 10_000), slotsPerOwner)
  assertCount('repeat replace smoke', replaceOwner(replaceFixture.store, sourcePath(replaceFixture, 0), 10_000), slotsPerOwner)
  await replaceFixture.store.reconcile()
  await assertCardinality(replaceFixture.cachePath, ownerCount, ownerCount * slotsPerOwner)

  serializeFixture = await createFixture('serialize', false)
  await serializeFixture.store.reconcile()
  await serializeFixture.store.reconcile()
  await assertCardinality(serializeFixture.cachePath, ownerCount, ownerCount * slotsPerOwner)

  const gcSmoke = await createFixture('gc-smoke', true)
  await gcSmoke.store.reconcile()
  await assertCardinality(gcSmoke.cachePath, ownerCount / 2, ownerCount * slotsPerOwner / 2)

  // Tinybench 2.9 invokes an async fixed 10-sample task 11 times: one warmup and ten samples.
  // Every fixture is prepared before timing and consumed exactly once, so GC never sees old state.
  for (let index = 0; index < gcPoolSize; index += 1)
    gcFixtures.push(await createFixture(`gc-${index}`, true))
})

afterAll(async () => {
  try {
    assertCount('GC fixture consumption', gcFixtureIndex, gcPoolSize)
    for (const fixture of gcFixtures)
      await assertCardinality(fixture.cachePath, ownerCount / 2, ownerCount * slotsPerOwner / 2)
    await replaceFixture.store.reconcile()
    await assertCardinality(replaceFixture.cachePath, ownerCount, ownerCount * slotsPerOwner)
    await assertCardinality(serializeFixture.cachePath, ownerCount, ownerCount * slotsPerOwner)
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})

bench('looks up live slots', () => {
  assertCount('lookup benchmark', lookupAll(lookupOwner, 0), slotsPerOwner)
})

bench('replaces one owner', () => {
  assertCount('replace benchmark', replaceOwner(replaceFixture.store, sourcePath(replaceFixture, 0), 10_000), slotsPerOwner)
})

bench('garbage collects missing owners', async () => {
  const fixture = gcFixtures[gcFixtureIndex]
  if (!fixture)
    throw new Error(`GC benchmark exceeded its ${gcPoolSize}-fixture invocation budget.`)
  gcFixtureIndex += 1
  await fixture.store.reconcile()
}, {
  iterations: 10,
  time: 0,
  warmupIterations: 1,
  warmupTime: 0,
})

bench('flushes an empty event backlog', async () => {
  await serializeFixture.store.reconcile()
})

async function assertCardinality(cachePath: string, owners: number, entries: number): Promise<void> {
  const body = await readCacheBody(cachePath)
  assertCount(`${cachePath} owners`, Object.keys(body.owners).length, owners)
  assertCount(`${cachePath} entries`, Object.keys(body.entries).length, entries)
}

function assertCount(label: string, actual: number, expected: number): void {
  if (actual !== expected)
    throw new Error(`${label}: expected ${expected}, received ${actual}.`)
}

function cacheEntry(targetIndex: number): CacheEntry {
  return {
    diagnostics: [],
    fingerprint: { ...fingerprint, targetHash: `target-${targetIndex}` },
    target: {
      hash: `target-${targetIndex}`,
      identity: `function:${targetIndex}`,
      kind: 'function',
    },
    usage: [],
  }
}

function cacheSlot(targetIndex: number): CacheSlotIdentity {
  return {
    ruleId: 'benchmark/noop',
    scope: 'function',
    targetIdentity: `function:${targetIndex}`,
  }
}

async function createFixture(name: string, missingOwners: boolean): Promise<PreparedFixture> {
  const fixtureRoot = join(root, name)
  const cachePath = join(fixtureRoot, '.alintcache')
  await mkdir(join(fixtureRoot, 'src'), { recursive: true })
  const store = await createCacheStore({ cwd: fixtureRoot, enabled: true, location: cachePath })

  for (let ownerIndex = 0; ownerIndex < ownerCount; ownerIndex += 1) {
    await writeFile(join(fixtureRoot, 'src', `file-${ownerIndex}.ts`), 'live')
    replaceOwner(store, join(fixtureRoot, 'src', `file-${ownerIndex}.ts`), ownerIndex)
  }
  await store.reconcile()
  if (missingOwners) {
    await Promise.all(Array.from({ length: ownerCount / 2 }, (_, index) =>
      rm(join(fixtureRoot, 'src', `file-${index * 2 + 1}.ts`), { force: true })))
  }

  return {
    cachePath,
    root: fixtureRoot,
    store: await createCacheStore({ cwd: fixtureRoot, enabled: true, location: cachePath }),
  }
}

function lookupAll(owner: CacheOwnerTransaction, ownerIndex: number): number {
  let found = 0
  for (let targetIndex = 0; targetIndex < slotsPerOwner; targetIndex += 1) {
    const index = ownerIndex * slotsPerOwner + targetIndex
    if (owner.lookup(cacheSlot(index), cacheEntry(index).fingerprint))
      found += 1
  }
  return found
}

function replaceOwner(cacheStore: CacheStore, path: string, ownerIndex: number): number {
  const owner = cacheStore.beginOwner({ kind: 'file', path })
  let replacements = 0
  for (let targetIndex = 0; targetIndex < slotsPerOwner; targetIndex += 1) {
    const index = ownerIndex * slotsPerOwner + targetIndex
    owner.put(cacheSlot(index), cacheEntry(index))
    replacements += 1
  }
  owner.commit({ contentHash: `content-${ownerIndex}`, mode: 'replace' })
  return replacements
}

function sourcePath(fixture: PreparedFixture, ownerIndex: number): string {
  return join(fixture.root, 'src', `file-${ownerIndex}.ts`)
}

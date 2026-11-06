import type { LockOptions } from 'proper-lockfile'

import type { RunnerConfig } from '../../config/types'
import type { ProgressTargetKind } from '../types'
import type {
  CachedOwner,
  CacheEntry,
  CacheFileBody,
  CacheFingerprint,
  CacheOwnerIdentity,
  CacheOwnerMetadata,
  CacheOwnerTransaction,
  CacheSlotIdentity,
  CacheStore,
} from './types'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { access, appendFile, mkdir, open, readFile, rename, rm, writeFile as writeFileToDisk } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import lockfile from 'proper-lockfile'

import { isNodeErrorCode } from '@alint-js/utils/node'
import {
  array,
  boolean,
  check,
  custom,
  finite,
  literal,
  number,
  object,
  optional,
  parse,
  pipe,
  record,
  string,
  union,
  unknown,
} from 'valibot'

import packageJson from '../../../package.json'

import { stableHash } from '../hash'
import { CACHE_MAGIC, CACHE_SCHEMA_VERSION } from './types'

const DEFAULT_CACHE_FILE_NAME = '.alintcache'
const LOCK_STALE_MS = 20_000
const LOCK_UPDATE_MS = 3_000
const METADATA_READ_LIMIT = 4_096

export interface CacheStoreOptions {
  alintVersion?: string
  appendFile?: typeof appendFile
  cwd: string
  enabled: boolean
  fileExists?: (path: string) => Promise<boolean>
  location?: string
  lock?: CacheLockDependencies
  readOnly?: boolean
  writeFile?: typeof writeFileToDisk
}

export interface NormalizedRunnerCacheConfig {
  enabled: boolean
  location: string
}

export interface TargetIdentityInput {
  filePath?: string
  identity?: string
  kind: ProgressTargetKind
  name?: string
  range?: {
    end: number
    start: number
  }
}

type CacheEvent = PutEvent | RemoveOwnerEvent | ReplaceOwnerEvent

interface CacheLockDependencies {
  acquire: (path: string, options: LockOptions) => Promise<() => Promise<void>>
}

interface CacheMetadata {
  alintVersion: string
  createdAt: string
  magic: typeof CACHE_MAGIC
  schemaVersion: typeof CACHE_SCHEMA_VERSION
  type: 'metadata'
}

type JsonValue = boolean | JsonValue[] | null | number | string | { [key: string]: JsonValue }

interface PutEvent {
  at: string
  entry: CacheEntry
  owner: CachedOwner
  ownerKey: string
  slotKey: string
  type: 'put'
}

interface RemoveOwnerEvent {
  at: string
  ownerKey: string
  type: 'remove-owner'
}

interface ReplaceOwnerEntry {
  entry: CacheEntry
  slotKey: string
}

interface ReplaceOwnerEvent {
  at: string
  entries: ReplaceOwnerEntry[]
  mode: 'merge' | 'replace'
  owner: CachedOwner
  ownerKey: string
  type: 'replace-owner'
}

const FiniteNumberSchema = pipe(number(), finite())
const PositionSchema = object({ column: FiniteNumberSchema, line: FiniteNumberSchema })
const SourceLocationSchema = object({ end: PositionSchema, start: PositionSchema })
const DiagnosticLocationSchema = object({
  end: optional(PositionSchema),
  start: PositionSchema,
})
const SourceRangeSchema = object({ end: FiniteNumberSchema, start: FiniteNumberSchema })
const DiagnosticSchema = object({
  cached: optional(boolean()),
  evidence: optional(custom<JsonValue>(isJsonValue)),
  filePath: string(),
  loc: optional(DiagnosticLocationSchema),
  message: string(),
  model: optional(object({
    providerId: string(),
    requested: optional(string()),
    resolvedId: string(),
  })),
  ruleId: string(),
  severity: union([
    literal('error'),
    literal('warn'),
  ]),
})
const UsageSchema = object({
  filePath: optional(string()),
  inputTokens: optional(FiniteNumberSchema),
  metadata: optional(custom<JsonValue>(isJsonValue)),
  modelId: string(),
  outputTokens: optional(FiniteNumberSchema),
  providerId: string(),
  ruleId: string(),
  totalTokens: optional(FiniteNumberSchema),
})
const CacheEntrySchema = object({
  diagnostics: array(DiagnosticSchema),
  fingerprint: object({
    configHash: string(),
    modelHash: string(),
    ruleHash: string(),
    targetHash: string(),
  }),
  target: object({
    hash: string(),
    identity: string(),
    kind: string(),
    loc: optional(SourceLocationSchema),
    name: optional(string()),
    range: optional(SourceRangeSchema),
  }),
  usage: array(UsageSchema),
})
const CachedOwnerSchema = object({
  contentHash: optional(string()),
  kind: union([
    literal('file'),
    literal('project'),
  ]),
  path: string(),
  slots: array(string()),
})

function objectRecord<ValueSchema extends Parameters<typeof record>[1]>(value: ValueSchema) {
  return pipe(
    unknown(),
    check(input => typeof input === 'object' && input !== null && !Array.isArray(input)),
    record(string(), value),
  )
}

const CacheFileBodySchema = pipe(
  object({
    createdAt: string(),
    entries: objectRecord(CacheEntrySchema),
    owners: objectRecord(CachedOwnerSchema),
    updatedAt: string(),
  }),
  check((body) => {
    const entryKeys = Object.keys(body.entries)
    const referencedSlots = Object.values(body.owners).flatMap(owner => owner.slots)
    const uniqueSlots = new Set(referencedSlots)
    return uniqueSlots.size === referencedSlots.length
      && uniqueSlots.size === entryKeys.length
      && entryKeys.every(key => uniqueSlots.has(key))
  }),
)
const CacheMetadataSchema = object({
  alintVersion: string(),
  createdAt: string(),
  magic: literal(CACHE_MAGIC),
  schemaVersion: literal(CACHE_SCHEMA_VERSION),
  type: literal('metadata'),
})
const PutEventSchema = object({
  at: string(),
  entry: CacheEntrySchema,
  owner: CachedOwnerSchema,
  ownerKey: string(),
  slotKey: string(),
  type: literal('put'),
})
const ReplaceOwnerEventSchema = object({
  at: string(),
  entries: array(object({
    entry: CacheEntrySchema,
    slotKey: string(),
  })),
  mode: union([
    literal('merge'),
    literal('replace'),
  ]),
  owner: CachedOwnerSchema,
  ownerKey: string(),
  type: literal('replace-owner'),
})
const RemoveOwnerEventSchema = object({
  at: string(),
  ownerKey: string(),
  type: literal('remove-owner'),
})
const CacheEventSchema = union([PutEventSchema, ReplaceOwnerEventSchema, RemoveOwnerEventSchema])

interface EventWriter {
  enqueue: (event: CacheEvent) => void
  flush: (finalAttempt: boolean) => Promise<void>
}

interface LoadedCacheLog {
  body: CacheFileBody
  metadata: CacheMetadata
}

export async function createCacheStore(options: CacheStoreOptions): Promise<CacheStore> {
  const location = resolveCacheLocation(options.cwd, options.location)
  if (!options.enabled)
    return createNoopCacheStore(location)

  const alintVersion = options.alintVersion ?? packageJson.version
  const initial = await loadCacheLog(location, alintVersion)
  if (options.readOnly)
    return createReadOnlyCacheStore(location, initial.body, options.cwd)

  const dependencies = {
    append: options.appendFile ?? appendFile,
    lock: options.lock ?? { acquire: lockfile.lock },
    write: options.writeFile ?? writeFileToDisk,
  }
  const trimmed = await trimOnce(location, alintVersion, initial, dependencies)
  const writer = createEventWriter(location, trimmed.metadata, dependencies)
  const fileExists = options.fileExists ?? defaultFileExists

  return {
    beginOwner: (owner, metadata) => beginOwner(trimmed.body, owner, options.cwd, writer, metadata),
    flush: () => writer.flush(false),
    location,
    reconcile: async () => {
      const removedOwners = await collectMissingFileOwners(trimmed.body, options.cwd, fileExists)
      for (const ownerKey of removedOwners) {
        writer.enqueue({
          at: new Date().toISOString(),
          ownerKey,
          type: 'remove-owner',
        })
      }
      await writer.flush(true)
    },
  }
}

export function createTargetIdentityResolver(targets: TargetIdentityInput[]) {
  const baseCounts = new Map<string, number>()
  const duplicateCandidateCounts = new Map<string, number>()
  for (const target of targets) {
    const base = createBaseTargetIdentity(target)
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1)
  }
  for (const target of targets) {
    const base = createBaseTargetIdentity(target)
    if ((baseCounts.get(base) ?? 0) <= 1)
      continue
    const candidate = target.range
      ? `${base}:${target.range.start}:${target.range.end}`
      : base
    duplicateCandidateCounts.set(candidate, (duplicateCandidateCounts.get(candidate) ?? 0) + 1)
  }

  return (target: TargetIdentityInput, targetIndex: number): string => {
    const base = createBaseTargetIdentity(target)
    if ((baseCounts.get(base) ?? 0) <= 1)
      return base
    const candidate = target.range
      ? `${base}:${target.range.start}:${target.range.end}`
      : base
    if ((duplicateCandidateCounts.get(candidate) ?? 0) <= 1)
      return candidate
    return `${candidate}:${targetIndex}`
  }
}

export function normalizeCachePath(cwd: string, filePath: string): string {
  const resolvedPath = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(cwd, filePath)
  return relative(cwd, resolvedPath).split(sep).join('/') || '.'
}

export function normalizeRunnerCacheConfig(cache: RunnerConfig['cache'], cwd: string): NormalizedRunnerCacheConfig {
  if (cache === false) {
    return {
      enabled: false,
      location: resolveCacheLocation(cwd),
    }
  }
  if (cache === true || cache === undefined) {
    return {
      enabled: true,
      location: resolveCacheLocation(cwd),
    }
  }
  return {
    enabled: cache.enabled ?? true,
    location: resolveCacheLocation(cwd, cache.location),
  }
}

export async function readCacheBody(location: string): Promise<CacheFileBody> {
  const text = await readFile(location, 'utf8')
  const metadata = parseMetadataLine(text.split(/\r?\n/, 1)[0], undefined)
  if (!metadata)
    throw new Error('Invalid alint cache metadata.')
  return replayLog(text, metadata).body
}

export function resolveCacheLocation(cwd: string, location?: string): string {
  if (!location)
    return join(cwd, DEFAULT_CACHE_FILE_NAME)
  const resolved = isAbsolute(location)
    ? resolve(location)
    : resolve(cwd, location)
  if (location.endsWith('/') || location.endsWith('\\'))
    return join(resolved, DEFAULT_CACHE_FILE_NAME)
  try {
    if (statSync(resolved).isDirectory())
      return join(resolved, DEFAULT_CACHE_FILE_NAME)
  }
  catch {
    // Missing locations without a trailing separator are treated as file paths.
  }
  return resolved
}

async function appendBatch(location: string, payload: string, append: typeof appendFile): Promise<void> {
  const handle = await open(location, 'a+')
  try {
    const { size } = await handle.stat()
    let separator = ''
    if (size > 0) {
      const finalByte = Buffer.alloc(1)
      await handle.read(finalByte, 0, 1, size - 1)
      separator = finalByte[0] === 10
        ? ''
        : '\n'
    }
    await append(location, `${separator}${payload}`, 'utf8')
  }
  finally {
    await handle.close()
  }
}

function applyEvent(body: CacheFileBody, event: CacheEvent): void {
  if (event.type === 'remove-owner') {
    removeOwner(body, event.ownerKey)
    body.updatedAt = event.at
    return
  }
  if (event.type === 'put') {
    const current = body.owners[event.ownerKey]
    const slots = new Set(current?.slots ?? [])
    slots.add(event.slotKey)
    body.entries[event.slotKey] = event.entry
    body.owners[event.ownerKey] = {
      ...event.owner,
      slots: [...slots].sort(),
    }
    body.updatedAt = event.at
    return
  }

  const entries = event.mode === 'merge'
    ? ownerEntries(body, body.owners[event.ownerKey])
    : new Map<string, CacheEntry>()
  for (const item of event.entries)
    entries.set(item.slotKey, item.entry)
  for (const slot of body.owners[event.ownerKey]?.slots ?? [])
    delete body.entries[slot]
  for (const [slotKey, entry] of entries)
    body.entries[slotKey] = entry
  body.owners[event.ownerKey] = {
    ...event.owner,
    slots: [
      ...entries.keys(),
    ].sort(),
  }
  body.updatedAt = event.at
}

function beginOwner(
  body: CacheFileBody,
  owner: CacheOwnerIdentity,
  cwd: string,
  writer: EventWriter,
  ownerMetadata: CacheOwnerMetadata = {},
): CacheOwnerTransaction {
  const normalizedOwner = {
    kind: owner.kind,
    path: normalizeCachePath(cwd, owner.path),
  }
  const key = ownerKey(normalizedOwner, cwd)
  const previousOwner = body.owners[key]
  const nextEntries = new Map<string, CacheEntry>()
  const checkpointEntries = new Map<string, CacheEntry>()

  const commit: CacheOwnerTransaction['commit'] = (metadata = {}) => {
    const contentHash = metadata.contentHash ?? ownerMetadata.contentHash
    const committedEntries = metadata.mode === 'merge'
      ? ownerEntries(body, body.owners[key])
      : new Map<string, CacheEntry>()
    for (const [entryKey, cacheEntry] of nextEntries)
      committedEntries.set(entryKey, cacheEntry)

    const replacedSlots = new Set([
      ...(previousOwner?.slots ?? []),
      ...(body.owners[key]?.slots ?? []),
    ])
    for (const replacedSlot of replacedSlots)
      delete body.entries[replacedSlot]
    for (const [entryKey, cacheEntry] of committedEntries)
      body.entries[entryKey] = cacheEntry

    const cachedOwner: CachedOwner = {
      contentHash,
      kind: normalizedOwner.kind,
      path: normalizedOwner.path,
      slots: [
        ...committedEntries.keys(),
      ].sort(),
    }
    body.owners[key] = cachedOwner
    body.updatedAt = new Date().toISOString()
    writer.enqueue({
      at: body.updatedAt,
      entries: [...committedEntries].map(([slotKey, entry]) => ({ entry, slotKey })),
      mode: metadata.mode ?? 'replace',
      owner: cachedOwner,
      ownerKey: key,
      type: 'replace-owner',
    })
    checkpointEntries.clear()
  }

  return {
    checkpoint: async () => {
      const cachedOwner: CachedOwner = {
        contentHash: ownerMetadata.contentHash,
        kind: normalizedOwner.kind,
        path: normalizedOwner.path,
        slots: [],
      }
      for (const [entryKey, cacheEntry] of checkpointEntries) {
        const event: PutEvent = {
          at: new Date().toISOString(),
          entry: cacheEntry,
          owner: cachedOwner,
          ownerKey: key,
          slotKey: entryKey,
          type: 'put',
        }
        applyEvent(body, event)
        writer.enqueue(event)
      }
      checkpointEntries.clear()
      await writer.flush(false)
    },
    commit,
    discard: (cacheSlot) => {
      const entryKey = slotKey(normalizedOwner, cacheSlot, cwd)
      nextEntries.delete(entryKey)
      checkpointEntries.delete(entryKey)
    },
    lookup: (cacheSlot, fingerprint) => {
      const entryKey = slotKey(normalizedOwner, cacheSlot, cwd)
      const cached = body.entries[entryKey]
      if (!cached || !fingerprintsEqual(cached.fingerprint, fingerprint))
        return undefined
      nextEntries.set(entryKey, cached)
      return cached
    },
    put: (cacheSlot, cacheEntry) => {
      const entryKey = slotKey(normalizedOwner, cacheSlot, cwd)
      nextEntries.set(entryKey, cacheEntry)
      checkpointEntries.set(entryKey, cacheEntry)
    },
  }
}

async function collectMissingFileOwners(
  body: CacheFileBody,
  cwd: string,
  fileExists: (path: string) => Promise<boolean>,
): Promise<string[]> {
  const removed: string[] = []
  for (const [key, owner] of Object.entries(body.owners)) {
    if (owner.kind !== 'file' || await fileExists(resolve(cwd, owner.path)))
      continue
    removeOwner(body, key)
    removed.push(key)
  }
  return removed
}

function createBaseTargetIdentity(target: TargetIdentityInput): string {
  if (target.identity && (target.kind !== 'file' || target.identity !== 'file')) {
    return target.filePath
      ? `${target.kind}:${target.filePath}:${target.identity}`
      : `${target.kind}:${target.identity}`
  }
  if (target.kind === 'file') {
    return target.filePath
      ? `file:${target.filePath}`
      : 'file'
  }
  if (target.name)
    return `${target.kind}:${target.name}`
  if (target.range)
    return `${target.kind}:${target.range.start}:${target.range.end}`
  return target.kind
}

function createEmptyCacheBody(createdAt = new Date().toISOString()): CacheFileBody {
  return {
    createdAt,
    entries: {},
    owners: {},
    updatedAt: createdAt,
  }
}

function createEventWriter(
  location: string,
  metadata: CacheMetadata,
  dependencies: {
    append: typeof appendFile
    lock: CacheLockDependencies
    write: typeof writeFileToDisk
  },
): EventWriter {
  const backlog: CacheEvent[] = []
  let validationError: unknown
  let previousWrite = Promise.resolve()

  const persistBacklog = async (): Promise<void> => {
    if (validationError)
      throw validationError
    if (backlog.length === 0)
      return
    await mkdir(dirname(location), { recursive: true })
    await withCacheLock(location, dependencies.lock, getCacheLockOptions({
      factor: 2,
      maxTimeout: 16_000,
      minTimeout: 2_000,
      retries: 4,
    }), async () => {
      await ensureCompatibleMetadata(location, metadata, dependencies.write)
      const batchSize = backlog.length
      const payload = backlog.slice(0, batchSize).map(event => `${JSON.stringify(event)}\n`).join('')
      // Prefixing the batch with a newline isolates it from a torn final record.
      await appendBatch(location, payload, dependencies.append)
      backlog.splice(0, batchSize)
    })
    validationError = undefined
  }

  return {
    enqueue: (event) => {
      try {
        backlog.push(parse(CacheEventSchema, event))
      }
      catch (error) {
        validationError ??= error
      }
    },
    flush: (finalAttempt) => {
      const write = previousWrite.then(persistBacklog)
      previousWrite = write.catch(() => {})
      return finalAttempt
        ? write
        : write.catch(() => {})
    },
  }
}

function createNoopCacheStore(location: string): CacheStore {
  const transaction: CacheOwnerTransaction = {
    checkpoint: async () => {},
    commit: () => {},
    discard: () => {},
    lookup: () => undefined,
    put: () => {},
  }
  return {
    beginOwner: () => transaction,
    flush: async () => {},
    location,
    reconcile: async () => {},
  }
}

function createReadOnlyCacheStore(location: string, body: CacheFileBody, cwd: string): CacheStore {
  return {
    beginOwner: owner => ({
      checkpoint: async () => {},
      commit: () => {},
      discard: () => {},
      lookup: (slot, fingerprint) => {
        const cached = body.entries[slotKey(owner, slot, cwd)]
        return cached && fingerprintsEqual(cached.fingerprint, fingerprint)
          ? cached
          : undefined
      },
      put: () => {},
    }),
    flush: async () => {},
    location,
    reconcile: async () => {},
  }
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  }
  catch (error) {
    if (isMissingFileError(error))
      return false
    throw error
  }
}

function emptyLoadedLog(alintVersion: string): LoadedCacheLog {
  const metadata: CacheMetadata = {
    alintVersion,
    createdAt: new Date().toISOString(),
    magic: CACHE_MAGIC,
    schemaVersion: CACHE_SCHEMA_VERSION,
    type: 'metadata',
  }
  return {
    body: createEmptyCacheBody(metadata.createdAt),
    metadata,
  }
}

async function ensureCompatibleMetadata(location: string, metadata: CacheMetadata, write: typeof writeFileToDisk): Promise<void> {
  try {
    const line = await readMetadataLine(location)
    if (parseMetadataLine(line, metadata.alintVersion))
      return
  }
  catch (error) {
    if (!isMissingFileError(error))
      throw error
  }

  // Startup trim is opportunistic. A later writer that owns the lease must establish the current
  // protocol before appending if trim skipped a missing, damaged, or incompatible cache.
  await write(location, `${JSON.stringify(metadata)}\n`)
}

function fingerprintsEqual(left: CacheFingerprint, right: CacheFingerprint): boolean {
  return left.configHash === right.configHash
    && left.modelHash === right.modelHash
    && left.ruleHash === right.ruleHash
    && left.targetHash === right.targetHash
}

function getCacheLockOptions(retries: LockOptions['retries']): LockOptions {
  return {
    realpath: false,
    retries,
    stale: LOCK_STALE_MS,
    update: LOCK_UPDATE_MS,
  }
}

function hasJsonArrayProperties(input: unknown[], ancestors: WeakSet<object>): boolean {
  let arrayLength: number | undefined
  let indexCount = 0
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !('value' in descriptor))
      return false
    if (key === 'length') {
      if (descriptor.enumerable || typeof descriptor.value !== 'number')
        return false
      arrayLength = descriptor.value
      continue
    }
    const index = typeof key === 'string'
      ? Number(key)
      : Number.NaN
    if (
      typeof key !== 'string'
      || !Number.isInteger(index)
      || index < 0
      || index >= 2 ** 32 - 1
      || String(index) !== key
      || !descriptor.enumerable
    ) {
      return false
    }
    if (!isJsonValueAt(descriptor.value, ancestors)) {
      return false
    }
    indexCount += 1
  }
  return arrayLength !== undefined && indexCount === arrayLength
}

function hasJsonObjectProperties(input: object, ancestors: WeakSet<object>): boolean {
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string')
      return false
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
      return false
    if (!isJsonValueAt(descriptor.value, ancestors))
      return false
  }
  return true
}

function isJsonValue(input: unknown): input is JsonValue {
  return isJsonValueAt(input, new WeakSet())
}

function isJsonValueAt(input: unknown, ancestors: WeakSet<object>): input is JsonValue {
  if (input === null || typeof input === 'string' || typeof input === 'boolean')
    return true
  if (typeof input === 'number')
    return Number.isFinite(input)
  if (typeof input !== 'object')
    return false
  if (ancestors.has(input))
    return false
  ancestors.add(input)
  try {
    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype)
        return false
      return hasJsonArrayProperties(input, ancestors)
    }
    if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
      return false
    return hasJsonObjectProperties(input, ancestors)
  }
  catch {
    return false
  }
  finally {
    ancestors.delete(input)
  }
}

function isMissingFileError(error: unknown): boolean {
  return isNodeErrorCode(error, 'ENOENT') || isNodeErrorCode(error, 'ENOTDIR')
}

async function loadCacheLog(location: string, alintVersion: string): Promise<LoadedCacheLog> {
  try {
    const metadata = parseMetadataLine(await readMetadataLine(location), alintVersion)
    if (!metadata)
      return emptyLoadedLog(alintVersion)
    const text = await readFile(location, 'utf8')
    return replayLog(text, metadata)
  }
  catch (error) {
    if (isMissingFileError(error))
      return emptyLoadedLog(alintVersion)
    throw error
  }
}

function ownerEntries(body: CacheFileBody, owner: CachedOwner | undefined): Map<string, CacheEntry> {
  const entries = new Map<string, CacheEntry>()
  for (const slot of owner?.slots ?? []) {
    const cacheEntry = body.entries[slot]
    if (cacheEntry)
      entries.set(slot, cacheEntry)
  }
  return entries
}

function ownerKey(owner: CacheOwnerIdentity, cwd: string): string {
  return stableHash({
    kind: owner.kind,
    path: normalizeCachePath(cwd, owner.path),
  })
}

function parseMetadataLine(line: string | undefined, expectedAlintVersion: string | undefined): CacheMetadata | undefined {
  if (!line)
    return undefined
  try {
    const value: unknown = JSON.parse(line)
    const metadata = parse(CacheMetadataSchema, value)
    if (expectedAlintVersion !== undefined && metadata.alintVersion !== expectedAlintVersion)
      return undefined
    return metadata
  }
  catch {
    return undefined
  }
}

async function persistCompactedLog(location: string, loaded: LoadedCacheLog, write: typeof writeFileToDisk): Promise<void> {
  const metadata = parse(CacheMetadataSchema, loaded.metadata)
  const compactedEvents = Object.entries(loaded.body.owners).map(([ownerKey, owner]) => ({
    at: loaded.body.updatedAt,
    entries: [
      ...ownerEntries(loaded.body, owner),
    ].map(([slotKey, entry]) => ({ entry, slotKey })),
    mode: 'replace' as const,
    owner,
    ownerKey,
    type: 'replace-owner' as const,
  }))
  const events = compactedEvents.map(event => parse(CacheEventSchema, event))
  const contents = [
    `${JSON.stringify(metadata)}\n`,
    ...events.map(event => `${JSON.stringify(event)}\n`),
  ].join('')
  const tempPath = join(dirname(location), `.${basename(location)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await write(tempPath, contents)
    await rename(tempPath, location)
  }
  catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

async function readMetadataLine(location: string): Promise<string | undefined> {
  const handle = await open(location, 'r')
  try {
    const buffer = Buffer.alloc(METADATA_READ_LIMIT)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const newlineIndex = buffer.subarray(0, bytesRead).indexOf(10)
    if (newlineIndex < 0)
      return undefined
    const lineEnd = newlineIndex > 0 && buffer[newlineIndex - 1] === 13
      ? newlineIndex - 1
      : newlineIndex
    return buffer.toString('utf8', 0, lineEnd)
  }
  finally {
    await handle.close()
  }
}

function removeOwner(body: CacheFileBody, key: string): void {
  for (const slot of body.owners[key]?.slots ?? [])
    delete body.entries[slot]
  delete body.owners[key]
}

function replayLog(text: string, metadata: CacheMetadata): LoadedCacheLog {
  const body = createEmptyCacheBody(metadata.createdAt)
  const lines = text.split(/\r?\n/)
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line)
      continue
    try {
      const value: unknown = JSON.parse(line)
      applyEvent(body, parse(CacheEventSchema, value))
    }
    catch {
      // Ordinary events are independent recovery units; a torn or corrupt line cannot hide later valid events.
    }
  }
  return {
    body: parse(CacheFileBodySchema, body),
    metadata,
  }
}

function slotKey(owner: CacheOwnerIdentity, slot: CacheSlotIdentity, cwd: string): string {
  return stableHash({
    owner: ownerKey(owner, cwd),
    ...slot,
  })
}

async function trimOnce(
  location: string,
  alintVersion: string,
  fallback: LoadedCacheLog,
  dependencies: {
    append: typeof appendFile
    lock: CacheLockDependencies
    write: typeof writeFileToDisk
  },
): Promise<LoadedCacheLog> {
  await mkdir(dirname(location), { recursive: true })
  try {
    return await withCacheLock(location, dependencies.lock, getCacheLockOptions(0), async () => {
      // The lease closes the read/compact race: trim must rebuild from bytes read after acquisition.
      const latest = await loadCacheLog(location, alintVersion)
      await persistCompactedLog(location, latest, dependencies.write)
      return latest
    })
  }
  catch (error) {
    if (isNodeErrorCode(error, 'ELOCKED'))
      return fallback
    throw error
  }
}

async function withCacheLock<Result>(
  location: string,
  lock: CacheLockDependencies,
  options: LockOptions,
  operation: () => Promise<Result>,
): Promise<Result> {
  let compromised: Error | undefined
  const release = await lock.acquire(location, {
    ...options,
    onCompromised: (error) => {
      compromised = error
    },
  })
  let operationError: unknown
  try {
    const result = await operation()
    if (compromised)
      throw compromised
    return result
  }
  catch (error) {
    operationError = error
    throw error
  }
  finally {
    try {
      await release()
    }
    catch (error) {
      if (operationError === undefined)
        throw error
    }
  }
}

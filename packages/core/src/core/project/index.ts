import type { ProjectFileEntry, ProjectTargetEntry } from '../../dsl/types'
import type { CacheOwnerTransaction, CacheStore } from '../cache'
import type { RuleJob, RuleRuntime, RuleTargetExecution } from '../execution/types'
import type { ProjectFileSnapshot, ProjectIndex, ProjectTargetSnapshot } from './types'

import { createStableHasher, stableHash } from '../hash'

export class ProjectIndexBuilder {
  private readonly files: ProjectFileEntry[] = []
  private hash?: string
  private readonly hasher = createStableHasher()
  private nextFileIndex = 0
  private readonly pending = new Map<number, ProjectFileSnapshot>()
  private readonly root: string
  private readonly targets: ProjectTargetEntry[] = []

  constructor(root: string) {
    this.root = root
    this.hasher.update({ root })
  }

  add(snapshot: ProjectFileSnapshot): void {
    if (this.hash !== undefined)
      throw new Error('Cannot add a project file after the index has been built.')
    if (!Number.isSafeInteger(snapshot.fileIndex) || snapshot.fileIndex < 0)
      throw new TypeError('Project file index must be a non-negative safe integer.')
    if (snapshot.fileIndex < this.nextFileIndex || this.pending.has(snapshot.fileIndex))
      throw new Error(`Project file index ${snapshot.fileIndex} has already been added.`)

    this.pending.set(snapshot.fileIndex, copySnapshot(snapshot))
    this.flushContiguousSnapshots()
  }

  build(): ProjectIndex {
    if (this.pending.size > 0)
      throw new Error(`Cannot build project index with a gap at file index ${this.nextFileIndex}.`)

    // digest() consumes the underlying hasher, so cache it independently of the copied public arrays.
    this.hash ??= this.hasher.digest()

    return {
      hash: this.hash,
      target: {
        files: this.files.map(copyFile),
        kind: 'project',
        root: this.root,
        targets: this.targets.map(copyDescriptor),
      },
    }
  }

  private flushContiguousSnapshots(): void {
    let snapshot = this.pending.get(this.nextFileIndex)

    // Only contiguous input reaches the hash, keeping it deterministic when extraction completes out of order.
    while (snapshot) {
      this.pending.delete(this.nextFileIndex)
      this.files.push(copyFile(snapshot.file))
      this.targets.push(...snapshot.targets.map(target => copyDescriptor(target.descriptor)))
      this.hasher.update({
        configHash: snapshot.configHash,
        file: snapshot.file,
        targets: snapshot.targets.map(target => ({
          descriptor: target.descriptor,
          semanticHash: target.semanticHash,
        })),
      })
      this.nextFileIndex += 1
      snapshot = this.pending.get(this.nextFileIndex)
    }
  }
}

export function createProjectJobs(options: {
  cacheStore: CacheStore
  configHash: string
  project: ProjectIndex
  runtimes: RuleRuntime[]
}): { jobs: RuleJob[], owner?: CacheOwnerTransaction } {
  const executions = options.runtimes
    .map(runtime => projectExecution(runtime))
    .filter((execution): execution is RuleTargetExecution => execution !== undefined)
  if (executions.length === 0)
    return { jobs: [] }

  const owner = options.cacheStore.beginOwner({ kind: 'project', path: options.project.target.root })
  const target = {
    cacheOwner: owner,
    cacheTargetHash: options.project.hash,
    configHash: options.configHash,
    descriptor: options.project.target,
    identity: 'project',
    kind: 'project' as const,
  }
  const jobs = executions.map((execution): RuleJob => {
    const ruleId = execution.runtime.enabledRule.id
    return {
      execution,
      jobRef: {
        id: stableHash({
          input: options.project.target.root,
          ruleId,
          targetIdentity: 'project',
          targetIndex: 0,
        }),
        index: 0,
        inputPath: options.project.target.root,
        ruleId,
        target: { identity: 'project', kind: 'project' },
      },
      orderKey: {
        inputIndex: 0,
        ruleIndex: execution.runtime.ruleIndex,
        scope: 'project',
        targetIndex: 0,
      },
      target,
    }
  })
  return { jobs, owner }
}

function copyDescriptor(descriptor: ProjectTargetEntry): ProjectTargetEntry {
  return {
    filePath: descriptor.filePath,
    identity: descriptor.identity,
    kind: descriptor.kind,
    name: descriptor.name,
    range: descriptor.range && { ...descriptor.range },
  }
}

function copyFile(file: ProjectFileEntry): ProjectFileEntry {
  return {
    contentHash: file.contentHash,
    language: file.language,
    path: file.path,
    targetCount: file.targetCount,
  }
}

function copySnapshot(snapshot: ProjectFileSnapshot): ProjectFileSnapshot {
  return {
    configHash: snapshot.configHash,
    file: copyFile(snapshot.file),
    fileIndex: snapshot.fileIndex,
    targets: snapshot.targets.map(copyTargetSnapshot),
  }
}

function copyTargetSnapshot(target: ProjectTargetSnapshot): ProjectTargetSnapshot {
  return {
    descriptor: copyDescriptor(target.descriptor),
    semanticHash: target.semanticHash,
  }
}

function projectExecution(runtime: RuleRuntime): RuleTargetExecution | undefined {
  if (runtime.handlers.onTargetWith)
    return { handler: 'with', runtime }
  if (runtime.handlers.onTargetProject)
    return { handler: 'project', runtime }
  return undefined
}

export type { ProjectFileSnapshot, ProjectIndex, ProjectTargetSnapshot } from './types'

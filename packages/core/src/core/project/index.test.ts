import type { ProjectFileSnapshot } from './types'

import { describe, expect, it } from 'vitest'

import { createStableHasher } from '../hash'
import { ProjectIndexBuilder } from './index'

function createSnapshot(fileIndex: number, path: string): ProjectFileSnapshot {
  return {
    configHash: `config-${path}`,
    file: {
      contentHash: `content-${path}`,
      language: 'typescript',
      path,
      targetCount: 1,
    },
    fileIndex,
    targets: [
      {
        descriptor: {
          filePath: path,
          identity: `file:${path}`,
          kind: 'file',
          name: `name:${path}`,
          range: {
            end: 4,
            start: 1,
          },
        },
        semanticHash: `semantic-${path}`,
      },
    ],
  }
}

describe('projectIndexBuilder', () => {
  it('includes the project root in an empty index hash', () => {
    const first = new ProjectIndexBuilder('/project/a').build()
    const second = new ProjectIndexBuilder('/project/b').build()

    expect(first.hash).not.toBe(second.hash)
  })

  it('builds the same compact index from forward and reverse additions', () => {
    const root = '/project'
    const first = createSnapshot(0, '/project/a.ts')
    const second = createSnapshot(1, '/project/b.ts')
    const forward = new ProjectIndexBuilder(root)
    const reverse = new ProjectIndexBuilder(root)

    forward.add(first)
    forward.add(second)
    reverse.add(second)
    reverse.add(first)

    expect(reverse.build()).toEqual(forward.build())
    expect(forward.build()).toEqual({
      hash: createStableHasher()
        .update({ root })
        .update({
          configHash: first.configHash,
          file: first.file,
          targets: first.targets,
        })
        .update({
          configHash: second.configHash,
          file: second.file,
          targets: second.targets,
        })
        .digest(),
      target: {
        files: [first.file, second.file],
        kind: 'project',
        root,
        targets: [first.targets[0]?.descriptor, second.targets[0]?.descriptor],
      },
    })
  })

  it('exposes only the exact compact file and target descriptor fields', () => {
    const snapshot = createSnapshot(0, '/project/a.ts')
    const builder = new ProjectIndexBuilder('/project')

    builder.add(snapshot)

    const project = builder.build().target
    expect(Object.keys(project.files[0]!).sort()).toEqual([
      'contentHash',
      'language',
      'path',
      'targetCount',
    ])
    expect(Object.keys(project.targets[0]!).sort()).toEqual([
      'filePath',
      'identity',
      'kind',
      'name',
      'range',
    ])
    expect(JSON.stringify(project)).not.toContain('source text')
    expect(JSON.stringify(project)).not.toContain('metadata')
    expect(JSON.stringify(project)).not.toContain('semanticHash')
  })

  it('excludes structurally compatible extra file fields from the target and hash', () => {
    const snapshot = createSnapshot(0, '/project/a.ts')
    const snapshotWithExtras = {
      ...snapshot,
      file: {
        ...snapshot.file,
        metadata: { private: true },
        text: 'source text',
      },
    }
    const cleanBuilder = new ProjectIndexBuilder('/project')
    const extraBuilder = new ProjectIndexBuilder('/project')

    cleanBuilder.add(snapshot)
    extraBuilder.add(snapshotWithExtras)

    const clean = cleanBuilder.build()
    const extra = extraBuilder.build()
    expect(extra.hash).toBe(clean.hash)
    expect(Object.keys(extra.target.files[0]!).sort()).toEqual([
      'contentHash',
      'language',
      'path',
      'targetCount',
    ])
    expect(JSON.stringify(extra.target)).not.toContain('source text')
    expect(JSON.stringify(extra.target)).not.toContain('metadata')
  })

  it('rejects build while an index gap remains', () => {
    const builder = new ProjectIndexBuilder('/project')

    builder.add(createSnapshot(1, '/project/b.ts'))

    expect(() => builder.build()).toThrow('Cannot build project index with a gap at file index 0.')
  })

  it('memoizes the digest while returning fresh descriptor arrays', () => {
    const builder = new ProjectIndexBuilder('/project')
    builder.add(createSnapshot(0, '/project/a.ts'))

    const first = builder.build()
    const second = builder.build()

    expect(second).toEqual(first)
    expect(second.target.files).not.toBe(first.target.files)
    expect(second.target.targets).not.toBe(first.target.targets)
  })

  it('copies descriptors before retaining them', () => {
    const snapshot = createSnapshot(0, '/project/a.ts')
    const mutableTargets = [...snapshot.targets]
    const builder = new ProjectIndexBuilder('/project')

    builder.add({ ...snapshot, targets: mutableTargets })
    mutableTargets.length = 0

    expect(builder.build().target.targets).toEqual([snapshot.targets[0]?.descriptor])
  })

  it('rejects duplicate pending and already flushed indexes', () => {
    const builder = new ProjectIndexBuilder('/project')

    builder.add(createSnapshot(1, '/project/b.ts'))
    expect(() => builder.add(createSnapshot(1, '/project/duplicate.ts'))).toThrow(
      'Project file index 1 has already been added.',
    )

    builder.add(createSnapshot(0, '/project/a.ts'))
    expect(() => builder.add(createSnapshot(0, '/project/late.ts'))).toThrow(
      'Project file index 0 has already been added.',
    )
  })

  it.each([
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects invalid file index %s without changing builder state', (fileIndex) => {
    const builder = new ProjectIndexBuilder('/project')

    expect(() => builder.add(createSnapshot(fileIndex, '/project/invalid.ts'))).toThrow(
      new TypeError('Project file index must be a non-negative safe integer.'),
    )

    builder.add(createSnapshot(0, '/project/a.ts'))
    expect(builder.build().target.files.map(file => file.path)).toEqual(['/project/a.ts'])
  })

  it('rejects additions after build', () => {
    const builder = new ProjectIndexBuilder('/project')
    builder.add(createSnapshot(0, '/project/a.ts'))
    builder.build()

    expect(() => builder.add(createSnapshot(1, '/project/b.ts'))).toThrow(
      'Cannot add a project file after the index has been built.',
    )
  })
})

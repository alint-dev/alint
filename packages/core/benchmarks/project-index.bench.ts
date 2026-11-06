import type { ProjectFileSnapshot } from '../src/core/project'

import { bench, describe } from 'vitest'

import { ProjectIndexBuilder } from '../src/core/project'

for (const targetCount of [10_000, 50_000, 100_000]) {
  describe(`${targetCount.toLocaleString()} compact project descriptors`, () => {
    const snapshots = createSnapshots(targetCount)

    bench('adds and builds the project index', () => {
      const builder = new ProjectIndexBuilder('/benchmark')
      for (const snapshot of snapshots)
        builder.add(snapshot)
      builder.build()
    })
  })
}

function createSnapshots(targetCount: number): ProjectFileSnapshot[] {
  const targetsPerFile = 100
  return Array.from({
    length: Math.ceil(targetCount / targetsPerFile),
  }, (_, fileIndex) => {
    const path = `/benchmark/file-${fileIndex}.mock`
    const start = fileIndex * targetsPerFile
    const count = Math.min(targetsPerFile, targetCount - start)
    return {
      configHash: 'c',
      file: {
        contentHash: `f${fileIndex}`,
        language: 'benchmark/mock',
        path,
        targetCount: count,
      },
      fileIndex,
      targets: Array.from({ length: count }, (_, targetIndex) => ({
        descriptor: {
          filePath: path,
          identity: `function:${targetIndex}`,
          kind: 'function',
          range: { end: targetIndex + 1, start: targetIndex },
        },
        // Hashing has already happened before project indexing; short stable values isolate index costs.
        semanticHash: `s${targetIndex}`,
      })),
    }
  })
}

import type { AlintConfig } from '@alint-js/core'

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, bench } from 'vitest'

import { findLintTargets } from '../src/cli/commands/lint/discovery'

const artifactDirectoryCount = 50
const artifactFilesPerDirectory = 400
const sourceFileCount = 500
const allFilesPattern: AlintConfig = [
  {
    files: ['**/*'],
  },
]
const sourceFilesPattern: AlintConfig = [
  {
    files: ['src/**/*.ts'],
  },
]

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'alint-discovery-benchmark-'))
  await mkdir(join(root, 'src'), { recursive: true })

  await Promise.all(Array.from({ length: sourceFileCount }, (_, index) =>
    writeFile(join(root, 'src', `source-${index}.ts`), 'export const value = 1\n')))

  for (let directoryIndex = 0; directoryIndex < artifactDirectoryCount; directoryIndex += 1) {
    const directory = join(root, 'target', `artifact-${directoryIndex}`)
    await mkdir(directory, { recursive: true })
    await Promise.all(Array.from({ length: artifactFilesPerDirectory }, (_, fileIndex) =>
      writeFile(join(directory, `artifact-${fileIndex}.bin`), 'artifact')))
  }

  await assertDiscoveredCount(sourceFilesPattern, sourceFileCount)
  await assertDiscoveredCount(allFilesPattern, sourceFileCount + artifactDirectoryCount * artifactFilesPerDirectory)
})

afterAll(async () => {
  await rm(root, { force: true, recursive: true })
})

bench('discovers 500 matching files among 20,000 unmatched artifacts', async () => {
  await assertDiscoveredCount(sourceFilesPattern, sourceFileCount)
})

bench('discovers all 20,500 files', async () => {
  await assertDiscoveredCount(allFilesPattern, sourceFileCount + artifactDirectoryCount * artifactFilesPerDirectory)
})

async function assertDiscoveredCount(config: AlintConfig, expected: number): Promise<void> {
  const targets = await findLintTargets({
    config,
    cwd: root,
    inputs: ['.'],
  })

  if (targets.files.length !== expected) {
    throw new Error(`Expected ${expected} discovered files, received ${targets.files.length}.`)
  }
}

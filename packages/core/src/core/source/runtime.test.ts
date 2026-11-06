import type { SourceChangedError } from './runtime'

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { hashText } from '../hash'
import { createSourceRuntime } from './runtime'

describe('source runtime', () => {
  it('reads the planned source when its content hash matches', async () => {
    const text = 'planned source'
    const root = await mkdtemp(join(tmpdir(), 'alint-source-runtime-'))
    const path = join(root, 'file.custom')
    await writeFile(path, text)
    const runtime = createSourceRuntime()

    const file = await runtime.readFile({
      contentHash: hashText(text),
      language: 'custom',
      path,
    })

    expect(file.path).toBe(path)
    expect(file.text).toBe(text)
  })

  it('rejects a planned source that changed before execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-source-runtime-'))
    const path = join(root, 'file.custom')
    await writeFile(path, 'changed')
    const runtime = createSourceRuntime()

    await expect(runtime.readFile({
      contentHash: hashText('planned'),
      language: 'custom',
      path,
    })).rejects.toEqual(expect.objectContaining({
      actualHash: hashText('changed'),
      expectedHash: hashText('planned'),
      name: 'SourceChangedError',
      path,
    } satisfies Partial<SourceChangedError>))
  })
})

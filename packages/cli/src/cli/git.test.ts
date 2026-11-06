import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { x } from 'tinyexec'
import { describe, expect, it } from 'vitest'

import { findDirtyChanges, findGitRoot } from './git'

describe('git discovery', () => {
  it('finds staged, unstaged, and untracked files but excludes deleted files', async () => {
    const cwd = await createRepository()
    await writeFile(join(cwd, 'unstaged.ts'), 'changed\n', 'utf8')
    await writeFile(join(cwd, 'staged.ts'), 'staged\n', 'utf8')
    await git(cwd, ['add', 'staged.ts'])
    await writeFile(join(cwd, 'untracked.ts'), 'new\n', 'utf8')
    await rename(join(cwd, 'renamed-old.ts'), join(cwd, 'renamed-new.ts'))

    const { files } = await findDirtyChanges(cwd)

    expect(files).toContain('renamed-new.ts')
    expect(files).toContain('staged.ts')
    expect(files).toContain('unstaged.ts')
    expect(files).toContain('untracked.ts')
    expect(files).not.toContain('renamed-old.ts')
    expect(files).not.toContain('deleted.ts')
  })

  it('finds the root from a nested directory', async () => {
    const cwd = await createRepository()
    const nested = join(cwd, 'nested')
    await mkdir(nested)

    expect(await findGitRoot(nested)).toBe(cwd)
  })

  it('maps tracked and untracked changes to new-file line ranges', async () => {
    const cwd = await createRepository()
    await writeFile(join(cwd, 'unstaged.ts'), 'first\nchanged\nthird\n', 'utf8')
    await writeFile(join(cwd, 'untracked.ts'), 'new first\nnew second\n', 'utf8')

    const changes = await findDirtyChanges(cwd)

    expect(changes.files).toContain('unstaged.ts')
    expect(changes.files).toContain('untracked.ts')
    expect(changes.changedLines.get('unstaged.ts')).toEqual([
      { endLine: 3, startLine: 1 },
    ])
    expect(changes.changedLines.get('untracked.ts')).toEqual([
      { endLine: 2, startLine: 1 },
    ])
  })

  it('maps renamed and quoted Git paths to their current worktree paths', async () => {
    const cwd = await createRepository()
    const unicodePath = 'unicode-你好 file.ts'
    await writeFile(join(cwd, unicodePath), 'original\n', 'utf8')
    await git(cwd, ['add', unicodePath])
    await git(cwd, ['commit', '-m', 'add unicode path'])
    await writeFile(join(cwd, unicodePath), 'changed\n', 'utf8')
    await rename(join(cwd, 'renamed-old.ts'), join(cwd, 'renamed-new.ts'))
    await writeFile(join(cwd, 'renamed-new.ts'), 'changed after rename\n', 'utf8')

    const changes = await findDirtyChanges(cwd)

    expect(changes.changedLines.get(unicodePath)).toEqual([
      { endLine: 1, startLine: 1 },
    ])
    expect(changes.changedLines.get('renamed-new.ts')).toEqual([
      { endLine: 1, startLine: 1 },
    ])
    expect(changes.changedLines.has('renamed-old.ts')).toBe(false)
  })

  it('keeps registered submodules outside the repository lint boundary', async () => {
    const cwd = await createRepository()
    const source = await createSubmoduleRepository()
    await git(cwd, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      source,
      'vendor/example',
    ])
    await git(cwd, ['commit', '-am', 'add submodule'])
    await writeFile(join(source, 'input.ts'), 'updated upstream\n', 'utf8')
    await git(source, ['add', 'input.ts'])
    await git(source, ['commit', '-m', 'update submodule'])
    const updatedRevision = (await gitOutput(source, ['rev-parse', 'HEAD'])).trim()
    await git(join(cwd, 'vendor/example'), ['fetch', 'origin'])
    await git(join(cwd, 'vendor/example'), ['checkout', updatedRevision])
    await writeFile(join(cwd, 'vendor/example/input.ts'), 'dirty inside submodule\n', 'utf8')

    const changes = await findDirtyChanges(cwd)

    expect(changes.files).not.toContain('vendor/example')
    expect(changes.files.some(file => file.startsWith('vendor/example/'))).toBe(false)
    expect(changes.changedLines.has('vendor/example')).toBe(false)
  })
})

async function createRepository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'alint-git-'))
  await git(cwd, ['init'])
  await git(cwd, ['config', 'user.email', 'test@example.com'])
  await git(cwd, ['config', 'user.name', 'Test'])

  for (const file of [
    'deleted.ts',
    'renamed-old.ts',
    'staged.ts',
    'unstaged.ts',
  ]) {
    await writeFile(join(cwd, file), 'original\n', 'utf8')
  }

  await git(cwd, ['add', '.'])
  await git(cwd, ['commit', '-m', 'initial'])
  await rm(join(cwd, 'deleted.ts'))
  return cwd
}

async function createSubmoduleRepository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'alint-submodule-'))
  await git(cwd, ['init'])
  await git(cwd, ['config', 'user.email', 'test@example.com'])
  await git(cwd, ['config', 'user.name', 'Test'])
  await writeFile(join(cwd, 'input.ts'), 'original\n', 'utf8')
  await git(cwd, ['add', '.'])
  await git(cwd, ['commit', '-m', 'initial'])
  return cwd
}

async function git(cwd: string, args: string[]): Promise<void> {
  await gitOutput(cwd, args)
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await x('git', args, {
    nodeOptions: { cwd },
    nodePath: false,
    throwOnError: true,
  })

  return result.stdout
}

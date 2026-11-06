import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createTools, DEFAULT_IGNORE_PATTERNS } from './index'

async function createProject(): Promise<{ cwd: string, outsidePath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'alint-tools-fs-'))
  const cwd = join(root, 'project')

  await mkdir(join(cwd, 'src/alpha'), { recursive: true })
  await mkdir(join(cwd, 'src/beta'), { recursive: true })
  await mkdir(join(cwd, 'vendor/generated'), { recursive: true })
  await mkdir(join(cwd, '.venv'), { recursive: true })

  await writeFile(join(cwd, 'README.md'), '# Readme\n')
  await writeFile(join(cwd, 'src/alpha/keep.txt'), 'alpha NEEDLE line\nsecond line\n')
  await writeFile(join(cwd, 'src/beta/keep.txt'), 'beta NEEDLE line\n')
  await writeFile(join(cwd, 'vendor/generated/ignored.txt'), 'vendor NEEDLE line\n')
  await writeFile(join(cwd, '.venv/lib.txt'), 'venv NEEDLE line\n')

  const outsidePath = join(root, 'outside.txt')
  await writeFile(outsidePath, 'outside project root\n')

  return { cwd, outsidePath }
}

function toolNamed(cwd: string, name: string, options?: Parameters<typeof createTools>[1]) {
  const tool = createTools(cwd, options).find(candidate => candidate.name === name)

  if (!tool) {
    throw new Error(`Expected tool "${name}"`)
  }

  return tool
}

describe('createTools', () => {
  it('exposes the four filesystem tools', () => {
    const names = createTools('/repo').map(tool => tool.name)

    expect(names).toEqual([
      'read_file',
      'list_files',
      'search_files',
      'search_in_files',
    ])
  })

  it('uses strict-provider-compatible parameter schemas', () => {
    for (const tool of createTools('/repo')) {
      const parameters = tool.parameters as {
        properties: Record<string, unknown>
        required?: string[]
      }

      expect(parameters.required).toEqual(Object.keys(parameters.properties))
    }

    const listParameters = toolNamed('/repo', 'list_files').parameters as {
      properties: Record<string, unknown>
    }

    expect(JSON.stringify(listParameters.properties)).toContain('"type":"null"')
  })

  it('lists files while honoring base ignores and glob patterns', async () => {
    const { cwd } = await createProject()

    const listed = String(await toolNamed(cwd, 'list_files').execute({ patterns: '**/*.txt' }))

    expect(listed).toContain('src/alpha/keep.txt')
    expect(listed).toContain('src/beta/keep.txt')
    // vendor is a base default ignore.
    expect(listed).not.toContain('vendor/generated/ignored.txt')
  })

  it('extends the builtins by spreading DEFAULT_IGNORE_PATTERNS', async () => {
    const { cwd } = await createProject()

    const listed = String(await toolNamed(cwd, 'list_files', {
      ignore: [...DEFAULT_IGNORE_PATTERNS, '**/.venv/**'],
    }).execute({ patterns: '**/*.txt' }))

    expect(listed).toContain('src/alpha/keep.txt')
    expect(listed).not.toContain('vendor/generated/ignored.txt') // still ignored via the spread base
    expect(listed).not.toContain('.venv/lib.txt') // ignored via the added pattern
  })

  it('replaces the builtins when ignore is passed without them', async () => {
    const { cwd } = await createProject()

    const listed = String(await toolNamed(cwd, 'list_files', {
      ignore: ['**/.venv/**'],
    }).execute({ patterns: '**/*.txt' }))

    expect(listed).not.toContain('.venv/lib.txt') // the only pattern we passed
    // The base is fully replaced, so vendor is no longer ignored.
    expect(listed).toContain('vendor/generated/ignored.txt')
  })

  it('reads files relative to cwd and absolute paths outside the project root', async () => {
    const { cwd, outsidePath } = await createProject()

    const readFile = toolNamed(cwd, 'read_file')

    expect(String(await readFile.execute({ path: 'README.md' }))).toContain('# Readme')
    expect(String(await readFile.execute({ path: outsidePath }))).toContain('outside project root')
  })

  it('searches file paths and file contents by substring', async () => {
    const { cwd } = await createProject()

    const pathMatches = String(await toolNamed(cwd, 'search_files').execute({ query: 'alpha/keep' }))
    const contentMatches = String(await toolNamed(cwd, 'search_in_files').execute({ query: 'NEEDLE' }))

    expect(pathMatches).toContain('src/alpha/keep.txt')
    expect(pathMatches).not.toContain('src/beta/keep.txt')
    expect(contentMatches).toContain('src/alpha/keep.txt:1: alpha NEEDLE line')
    // vendor is ignored, so its NEEDLE never surfaces.
    expect(contentMatches).not.toContain('vendor/generated/ignored.txt')
  })

  it('scopes search to the requested directory', async () => {
    const { cwd } = await createProject()

    const contentMatches = String(await toolNamed(cwd, 'search_in_files').execute({ directory: 'src/alpha', query: 'NEEDLE' }))

    expect(contentMatches).toContain('src/alpha/keep.txt')
    // The same NEEDLE in src/beta is outside the requested directory.
    expect(contentMatches).not.toContain('src/beta/keep.txt')
  })

  it('scopes list_files to the requested directory', async () => {
    const { cwd } = await createProject()

    const listed = String(await toolNamed(cwd, 'list_files').execute({ directory: 'src/beta', patterns: '**/*.txt' }))

    expect(listed).toContain('src/beta/keep.txt')
    expect(listed).not.toContain('src/alpha/keep.txt')
  })
})

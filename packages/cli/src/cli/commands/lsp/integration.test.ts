import type { TestClient } from './test-client'

import process from 'node:process'

import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { executeCli } from '../../cli'
import { startLspServer } from './server'
import { createTestClient, initializeParams } from './test-client'

function startServer(env: NodeJS.ProcessEnv, folderPath: string): TestClient {
  const client = createTestClient(env)

  void startLspServer(client.io)
  client.send({
    id: 1,
    method: 'initialize',
    params: initializeParams([pathToFileURL(folderPath).toString()]),
  })
  client.send({ method: 'initialized', params: {} })

  return client
}

/**
 * Warms the cache with a terminal run, then opens the project through a directory symlink.
 *
 * `process.cwd()` gives the lint command a canonical path. The client gives the server the path the
 * user opened. The symlink makes the two differ, as they do for a symlinked project.
 */
async function warmSymlinkedProject(): Promise<{ cwd: string, env: NodeJS.ProcessEnv, folderPath: string }> {
  const projectPath = await mkdtemp(join(tmpdir(), 'alint-lsp-integration-'))
  const configHome = await mkdtemp(join(tmpdir(), 'alint-lsp-integration-home-'))
  const env = { ...process.env, XDG_CONFIG_HOME: configHome }
  const folderPath = `${projectPath}-link`

  await symlink(projectPath, folderPath, 'dir')

  const cwd = await realpath(folderPath)

  await writeFixtureProject(cwd)

  let stdoutText = ''
  const warmExitCode = await executeCli(['node', 'alint', '--format', 'json', 'demo.ts'], {
    cwd,
    env,
    stderr: { write: () => true },
    stdout: {
      write: (chunk) => {
        stdoutText += chunk
        return true
      },
    },
  })

  expect(warmExitCode).toBe(0)
  expect(JSON.parse(stdoutText).diagnostics[0].message).toBe('checked 1')
  await expect(readFile(join(cwd, '.alintcache'), 'utf8')).resolves.toContain('"entries"')

  return { cwd, env, folderPath }
}

/**
 * A project with one rule that counts its own executions.
 *
 * The rule calls no model, so a second execution costs nothing and is otherwise invisible. The
 * counter makes it visible: a cache replay still reports "checked 1", a second execution reports
 * "checked 2".
 *
 * The diagnostic is on line 3. A dropped `loc` falls back to line 0, so line 3 detects that too.
 */
async function writeFixtureProject(cwd: string): Promise<void> {
  await writeFile(join(cwd, 'demo.ts'), [
    '// two lines of header so the finding is not on line 1',
    '',
    'export function load() {}',
    '',
  ].join('\n'))

  const callKey = `__alintLspFixtureCalls_${cwd}`

  await writeFile(join(cwd, 'alint.config.ts'), `
const callKey = ${JSON.stringify(callKey)}
globalThis[callKey] = globalThis[callKey] ?? 0

export default [
  {
    files: ['**/*.ts'],
    plugins: {
      company: {
        rules: {
          cached: {
            languages: 'any',
            create: (ctx) => ({
              onTargetFunction: async (target) => {
                globalThis[callKey] += 1
                ctx.report({
                  filePath: target.file.path,
                  loc: target.loc,
                  message: 'checked ' + globalThis[callKey],
                })
              },
            }),
          },
        },
      },
    },
    rules: {
      'company/cached': 'warn',
    },
  },
]
`)
}

describe('alint lsp against a warm cache', () => {
  // These tests do not replace `runAlint`. A cwd or setup config mismatch gives zero diagnostics and
  // zero errors, so every test that uses a mock passes while the server is broken.
  //
  // Creating a directory symlink needs elevation or Developer Mode on Windows.
  it.skipIf(process.platform === 'win32')('replays what the CLI already paid for, through a symlinked workspace folder', async () => {
    const { env, folderPath } = await warmSymlinkedProject()
    const client = startServer(env, folderPath)

    await client.receive()

    const published = await client.receive()

    expect(published.method).toBe('textDocument/publishDiagnostics')
    // The client path, not the resolved path the run used. An editor matches by exact URI.
    expect(published.params?.uri).toBe(pathToFileURL(join(folderPath, 'demo.ts')).toString())
    expect(published.params?.diagnostics).toHaveLength(1)
    // "checked 1", not "checked 2": the server replayed the cache entry and did not run the rule.
    expect(published.params?.diagnostics?.[0]?.message).toBe('checked 1')
    expect(published.params?.diagnostics?.[0]?.code).toBe('company/cached')
    expect(published.params?.diagnostics?.[0]?.source).toBe('alint')
    expect(published.params?.diagnostics?.[0]?.severity).toBe(2)
    // alint lines are 1-based and LSP lines are 0-based, so source line 3 becomes line 2.
    expect(published.params?.diagnostics?.[0]?.range.start.line).toBe(2)
  })

  it.skipIf(process.platform === 'win32')('follows a file that changes and is deleted outside the editor', async () => {
    const { cwd, env, folderPath } = await warmSymlinkedProject()
    const client = startServer(env, folderPath)
    // The client watches the path it opened, so events arrive under the symlink.
    const demoUri = pathToFileURL(join(folderPath, 'demo.ts')).toString()
    const original = await readFile(join(cwd, 'demo.ts'), 'utf8')
    // Type 2 is FileChangeType.Changed and type 3 is FileChangeType.Deleted.
    const report = (type: number): void => client.send({
      method: 'workspace/didChangeWatchedFiles',
      params: { changes: [{ type, uri: demoUri }] },
    })

    await client.receive()
    await client.receive()

    // The changed function misses the cache, so its job is skipped and the finding disappears.
    await writeFile(join(cwd, 'demo.ts'), original.replace('load()', 'unload()'))
    report(2)

    const edited = await client.receive()

    expect(edited.params?.uri).toBe(demoUri)
    expect(edited.params?.diagnostics).toEqual([])

    // The original content has the original identity, so the entry the CLI wrote replays again.
    await writeFile(join(cwd, 'demo.ts'), original)
    report(2)

    const restored = await client.receive()

    expect(restored.params?.uri).toBe(demoUri)
    // "checked 1": the pass read the cache and did not run the rule.
    expect(restored.params?.diagnostics?.[0]?.message).toBe('checked 1')

    await rm(join(cwd, 'demo.ts'))
    report(3)

    const deleted = await client.receive()

    expect(deleted.params?.uri).toBe(demoUri)
    expect(deleted.params?.diagnostics).toEqual([])
  })
})

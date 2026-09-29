import process from 'node:process'

import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import * as alintCore from '@alint-js/core'

import { executeCli } from '../../cli'
import { runResultWith } from '../../test-support'
import { startLspServer } from './server'
import { createTestClient, initializeParams } from './test-client'

/** Restores what `executeCli` replaces, since the lsp command's promise never settles. */
function withRestoredConsole(): () => void {
  const { console } = globalThis
  const { debug, dir, info, log } = console

  return () => {
    console.debug = debug
    console.dir = dir
    console.info = info
    console.log = log
  }
}

async function writeWorkspaceFixture(): Promise<{ configHome: string, cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'alint-lsp-'))
  const configHome = await mkdtemp(join(tmpdir(), 'alint-lsp-home-'))

  await writeFile(join(cwd, 'date.ts'), 'export function format() {\n  return 1\n}\n')
  await writeFile(join(cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    plugins: {
      company: { rules: {} },
    },
  },
]
`)

  return { configHome, cwd }
}

describe('startLspServer', () => {
  it('answers initialize with the capabilities the client needs', async () => {
    const client = createTestClient()

    void startLspServer(client.io)
    client.send({ id: 1, method: 'initialize', params: initializeParams() })

    const response = await client.receive()

    expect(response.id).toBe(1)
    expect(response.result?.capabilities.executeCommandProvider?.commands)
      .toEqual(['alint.clearCache', 'alint.runFile', 'alint.runWorkspace'])
    expect(response.result?.capabilities.executeCommandProvider?.workDoneProgress).toBe(true)
    expect(response.result?.capabilities.workspace?.workspaceFolders)
      .toEqual({ changeNotifications: true, supported: true })
    // change 0 is TextDocumentSyncKind.None. Open and save drive every refresh.
    expect(response.result?.capabilities.textDocumentSync)
      .toEqual({ change: 0, openClose: true, save: true })
  })

  it('publishes cached diagnostics for every workspace folder file once initialized', async () => {
    const { configHome, cwd } = await writeWorkspaceFixture()
    const client = createTestClient({ ...process.env, XDG_CONFIG_HOME: configHome })
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockResolvedValue(runResultWith([{
      filePath: join(cwd, 'date.ts'),
      loc: { start: { column: 2, line: 4 } },
      message: 'helper is duplicated',
      ruleId: 'js/no-duplicated-helper',
      severity: 'warn',
    }]))

    try {
      void startLspServer(client.io)
      client.send({ id: 1, method: 'initialize', params: initializeParams([pathToFileURL(cwd).toString()]) })
      await client.receive()

      // The server sends no notification before this.
      client.send({ method: 'initialized', params: {} })

      const published = await client.receive()

      expect(published.method).toBe('textDocument/publishDiagnostics')
      expect(published.params?.uri).toBe(pathToFileURL(join(cwd, 'date.ts')).toString())
      expect(published.params?.diagnostics?.[0]?.message).toBe('helper is duplicated')
      expect(published.params?.diagnostics?.[0]?.range.start).toEqual({ character: 0, line: 3 })
      expect(runAlint.mock.calls[0]?.[0]?.cacheOnly).toBe(true)
    }
    finally {
      runAlint.mockRestore()
    }
  })

  it('refreshes a file that changed on disk without reloading the config', async () => {
    // A checkout or another tool changes files the editor never saves.
    const { configHome, cwd } = await writeWorkspaceFixture()
    const dateUri = pathToFileURL(join(cwd, 'date.ts')).toString()
    const client = createTestClient({ ...process.env, XDG_CONFIG_HOME: configHome })
    const runAlint = vi.spyOn(alintCore, 'runAlint')
      .mockResolvedValueOnce(runResultWith([{
        filePath: join(cwd, 'date.ts'),
        message: 'stale after the checkout',
        ruleId: 'js/no-duplicated-helper',
        severity: 'warn',
      }]))
      .mockResolvedValue(runResultWith([]))

    try {
      void startLspServer(client.io)
      client.send({ id: 1, method: 'initialize', params: initializeParams([pathToFileURL(cwd).toString()]) })
      await client.receive()
      client.send({ method: 'initialized', params: {} })
      await client.receive()

      // Type 2 is FileChangeType.Changed.
      client.send({
        method: 'workspace/didChangeWatchedFiles',
        params: { changes: [{ type: 2, uri: dateUri }] },
      })

      const published = await client.receive()

      expect(published.method).toBe('textDocument/publishDiagnostics')
      expect(published.params?.uri).toBe(dateUri)
      expect(published.params?.diagnostics).toEqual([])
      expect(runAlint.mock.calls[1]?.[0]?.files).toEqual([join(await realpath(cwd), 'date.ts')])
      expect(client.stdoutText()).not.toContain('Configuration changed')
    }
    finally {
      runAlint.mockRestore()
    }
  })

  it('reloads only the folder whose config changed', async () => {
    // Each folder loads its own config. Another folder's config does not change its diagnostics.
    const first = await writeWorkspaceFixture()
    const second = await writeWorkspaceFixture()
    const client = createTestClient({ ...process.env, XDG_CONFIG_HOME: first.configHome })
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockImplementation(async options => runResultWith([{
      filePath: join(options?.cwd ?? '', 'date.ts'),
      message: 'cached',
      ruleId: 'js/no-duplicated-helper',
      severity: 'warn',
    }]))

    try {
      void startLspServer(client.io)
      client.send({
        id: 1,
        method: 'initialize',
        params: initializeParams([pathToFileURL(first.cwd).toString(), pathToFileURL(second.cwd).toString()]),
      })
      await client.receive()
      client.send({ method: 'initialized', params: {} })

      // One publish per folder shows that both folders are open.
      await client.receive()
      await client.receive()

      const callsBefore = runAlint.mock.calls.length

      client.send({
        method: 'workspace/didChangeWatchedFiles',
        params: { changes: [{ type: 2, uri: pathToFileURL(join(first.cwd, 'alint.config.ts')).toString() }] },
      })

      let message = await client.receive()

      while (message.method !== 'textDocument/publishDiagnostics') {
        message = await client.receive()
      }

      expect(message.params?.uri).toBe(pathToFileURL(join(first.cwd, 'date.ts')).toString())
      expect(runAlint.mock.calls.slice(callsBefore).map(([options]) => options?.cwd))
        .toEqual([await realpath(first.cwd)])
    }
    finally {
      runAlint.mockRestore()
    }
  })

  it('opens a folder the client adds and clears a folder it removes', async () => {
    const { configHome, cwd } = await writeWorkspaceFixture()
    const folder = { name: 'fixture', uri: pathToFileURL(cwd).toString() }
    const dateUri = pathToFileURL(join(cwd, 'date.ts')).toString()
    const client = createTestClient({ ...process.env, XDG_CONFIG_HOME: configHome })
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockResolvedValue(runResultWith([{
      filePath: join(cwd, 'date.ts'),
      message: 'helper is duplicated',
      ruleId: 'js/no-duplicated-helper',
      severity: 'warn',
    }]))

    try {
      void startLspServer(client.io)
      client.send({
        id: 1,
        method: 'initialize',
        // The server receives folder changes only from a client that declares this capability.
        params: initializeParams([], { workspace: { workspaceFolders: true } }),
      })
      await client.receive()
      client.send({ method: 'initialized', params: {} })

      client.send({
        method: 'workspace/didChangeWorkspaceFolders',
        params: { event: { added: [folder], removed: [] } },
      })

      const opened = await client.receive()

      expect(opened.params?.uri).toBe(dateUri)
      expect(opened.params?.diagnostics?.[0]?.message).toBe('helper is duplicated')

      client.send({
        method: 'workspace/didChangeWorkspaceFolders',
        params: { event: { added: [], removed: [folder] } },
      })

      // The editor keeps a published list until the server replaces it.
      const closed = await client.receive()

      expect(closed.params?.uri).toBe(dateUri)
      expect(closed.params?.diagnostics).toEqual([])
    }
    finally {
      runAlint.mockRestore()
    }
  })

  it('reports a missing stdin instead of crashing', async () => {
    const client = createTestClient()

    const exitCode = await startLspServer({ ...client.io, stdin: undefined })

    expect(exitCode).toBe(2)
    expect(client.stderrText()).toContain('stdin')
    expect(client.stdoutText()).toBe('')
  })
})

describe('alint lsp', () => {
  it('writes nothing but framed JSON-RPC to stdout', async () => {
    // A rule that logs to stdout corrupts the JSON-RPC stream and ends the session.
    const client = createTestClient()
    const restoreConsole = withRestoredConsole()

    try {
      void executeCli(['node', 'alint', 'lsp', '--stdio'], client.io)
      client.send({ id: 1, method: 'initialize', params: initializeParams() })
      await client.receive()

      globalThis.console.log('rule noise')

      client.send({ id: 2, method: 'shutdown' })

      const response = await client.receive()

      expect(response.id).toBe(2)
      expect(client.stdoutText().startsWith('Content-Length: ')).toBe(true)
      expect(client.stdoutText()).not.toContain('rule noise')
      expect(client.stderrText()).toContain('rule noise')
    }
    finally {
      restoreConsole()
    }
  })
})

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import packageJson from '../package.json'

const MiB = 1024 * 1024
const outputLimit = 64 * 1024
const runnerPath = fileURLToPath(new URL('./memory-runner.ts', import.meta.url))
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe('run memory regressions', () => {
  it('finishes compact planning while source rule jobs remain blocked under a 64 MiB heap', async () => {
    const root = await createRoot('alint-memory-blocked-planning-')
    const fileCount = 40
    const source = 'x'.repeat(MiB)

    for (let index = 0; index < fileCount; index += 1)
      await writeFile(join(root, `${index.toString().padStart(3, '0')}.blocked`), source)

    const child = await runScenario('blocked-planning', root)

    expect(child.signal, failureMessage(child)).toBeNull()
    expect(child.code, failureMessage(child)).toBe(0)
    expect(JSON.parse(child.stdout)).toMatchObject({
      execution: {
        completed: fileCount,
        planned: fileCount,
      },
      planningProgress: {
        execution: {
          planned: fileCount,
          queued: 20,
          running: 20,
        },
        filesPlanned: fileCount,
        planningComplete: true,
      },
    })
  }, 120_000)

  it('runs 9,600 semantic targets and a compact project rule under a 64 MiB heap', async () => {
    const root = await createRoot('alint-memory-project-')
    const fileCount = 120
    const targetsPerFile = 80
    const targetBytes = Math.floor(19 * MiB / fileCount / targetsPerFile)
    let totalBytes = 0

    for (let fileIndex = 0; fileIndex < fileCount; fileIndex += 1) {
      let source = ''
      for (let targetIndex = 0; targetIndex < targetsPerFile; targetIndex += 1) {
        const marker = `/* TARGET ${targetIndex} */\n`
        source += `${marker}${'x'.repeat(targetBytes - Buffer.byteLength(marker))}`
      }
      totalBytes += Buffer.byteLength(source)
      await writeFile(join(root, `${fileIndex.toString().padStart(3, '0')}.mock`), source)
    }

    expect(totalBytes).toBeGreaterThan(18 * MiB)
    expect(totalBytes).toBeLessThan(20 * MiB)

    const child = await runScenario('project', root)

    expect(child.signal, failureMessage(child)).toBeNull()
    expect(child.code, failureMessage(child)).toBe(0)
    expect(JSON.parse(child.stdout)).toEqual({
      cached: 0,
      cancelled: 0,
      completed: 9_601,
      failed: 0,
      planned: 9_601,
      queued: 0,
      running: 0,
      skipped: 0,
    })
  }, 120_000)

  it('rejects a 44 MiB legacy cache before parsing its body under a 64 MiB heap', async () => {
    const root = await createRoot('alint-memory-cache-')
    const cachePath = join(root, '.alintcache')
    const handle = await open(cachePath, 'w')
    const chunk = 'x'.repeat(MiB)
    const prefix = '{"padding":"'
    const suffix = '"}'
    const paddingBytes = 44 * MiB - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)
    try {
      await handle.write(prefix)
      for (let index = 0; index < Math.floor(paddingBytes / MiB); index += 1)
        await handle.write(chunk)
      await handle.write('x'.repeat(paddingBytes % MiB))
      await handle.write(suffix)
    }
    finally {
      await handle.close()
    }
    expect((await stat(cachePath)).size).toBe(44 * MiB)

    const child = await runScenario('legacy-cache', root)

    expect(child.signal, failureMessage(child)).toBeNull()
    expect(child.code, failureMessage(child)).toBe(0)
    expect(JSON.parse(child.stdout)).toEqual({
      cached: 0,
      cancelled: 0,
      completed: 0,
      failed: 0,
      planned: 0,
      queued: 0,
      running: 0,
      skipped: 0,
    })
    const metadataLine = (await readFile(cachePath, 'utf8')).split('\n', 1)[0]!
    expect(JSON.parse(metadataLine)).toEqual({
      alintVersion: packageJson.version,
      createdAt: expect.any(String),
      magic: 'ALINT_CACHE',
      schemaVersion: 2,
      type: 'metadata',
    })
  }, 120_000)

  it('terminates a hung child within its internal deadline and bounds diagnostics', async () => {
    const root = await createRoot('alint-memory-hang-')
    const startedAt = Date.now()

    const child = await runScenario('hang', root, { deadlineMs: 2_000, killGraceMs: 50 })

    expect(child.timedOut).toBe(true)
    expect(child.code).toBeNull()
    expect(child.signal).toBe('SIGKILL')
    expect(child.stdout.length).toBe(outputLimit)
    expect(child.stderr.length).toBe(outputLimit)
    expect(Date.now() - startedAt).toBeLessThan(4_000)
  })
})

interface ChildResult {
  code: null | number
  signal: NodeJS.Signals | null
  stderr: string
  stdout: string
  timedOut: boolean
}

function appendBounded(current: string, chunk: string): string {
  const combined = current + chunk
  return combined.length <= outputLimit
    ? combined
    : combined.slice(-outputLimit)
}

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function failureMessage(result: ChildResult): string {
  return `child code=${result.code} signal=${result.signal} timedOut=${result.timedOut}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
}

async function runScenario(
  scenario: string,
  root: string,
  options: { deadlineMs?: number, killGraceMs?: number } = {},
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--max-old-space-size=64',
      '--import',
      'tsx',
      runnerPath,
      scenario,
      root,
    ], {
      env: { ...process.env, NODE_OPTIONS: '' },
    })
    const deadlineMs = options.deadlineMs ?? 110_000
    const killGraceMs = options.killGraceMs ?? 1_000
    let deadlineTimer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined
    let settled = false
    let stderr = ''
    let stdout = ''
    let timedOut = false
    let onClose: (code: null | number, signal: NodeJS.Signals | null) => void
    let onError: (error: Error) => void
    let onStderr: (chunk: string) => void
    let onStdout: (chunk: string) => void

    const cleanup = () => {
      clearTimeout(deadlineTimer)
      clearTimeout(killTimer)
      child.off('close', onClose)
      child.off('error', onError)
      child.stderr.off('data', onStderr)
      child.stdout.off('data', onStdout)
      child.stderr.destroy()
      child.stdout.destroy()
    }
    const finish = (result: ChildResult) => {
      if (settled)
        return
      settled = true
      cleanup()
      resolve(result)
    }
    onClose = (code: null | number, signal: NodeJS.Signals | null) => {
      finish({
        code,
        signal,
        stderr,
        stdout,
        timedOut,
      })
    }
    onError = (error: Error) => {
      if (settled)
        return
      settled = true
      cleanup()
      reject(error)
    }
    onStderr = (chunk: string) => {
      stderr = appendBounded(stderr, chunk)
    }
    onStdout = (chunk: string) => {
      stdout = appendBounded(stdout, chunk)
    }

    child.stderr.setEncoding('utf8')
    child.stdout.setEncoding('utf8')
    child.stderr.on('data', onStderr)
    child.stdout.on('data', onStdout)
    child.once('error', onError)
    child.once('close', onClose)
    deadlineTimer = setTimeout(() => {
      if (settled)
        return
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        if (!settled)
          child.kill('SIGKILL')
      }, killGraceMs)
    }, deadlineMs)
  })
}

import type { AddressInfo } from 'node:net'

import type { Diagnostic } from '@alint-js/core'

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { executeCli } from '../../../cli'
import { summaryMarker } from './findings'

interface RecordedRequest {
  authorization?: string
  body?: Record<string, any>
  method: string
  url: string
}

const servers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close => close()))
})

describe('integrations github', () => {
  it('publishes a check run, a summary comment, and a job summary', async () => {
    const api = await startGitHubApi({ comments: [] })
    const cwd = await createWorkspace([warning(3), { ...warning(9), severity: 'error' }])

    const result = await run(cwd, api.url)

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('Published 1 error, 1 warning to acme/app@abcdef0.\n')
    expect(api.requests.map(request => `${request.method} ${request.url}`)).toEqual([
      'POST /repos/acme/app/check-runs',
      'GET /repos/acme/app/issues/12/comments?per_page=100&page=1',
      'POST /repos/acme/app/issues/12/comments',
    ])

    const checkRun = api.requests[0]
    expect(checkRun?.authorization).toBe('Bearer test-token')
    expect(checkRun?.body?.name).toBe('alint')
    expect(checkRun?.body?.conclusion).toBe('failure')
    // The event head commit wins over GITHUB_SHA, which is the merge commit on pull request events.
    expect(checkRun?.body?.head_sha).toBe('abcdef0123')
    expect(checkRun?.body?.output.title).toBe('1 error, 1 warning')
    expect(checkRun?.body?.output.annotations).toHaveLength(2)
    expect(checkRun?.body?.output.annotations[0].path).toBe('src/a.ts')
    expect(checkRun?.body?.output.annotations[0].annotation_level).toBe('failure')

    const comment = api.requests[2]?.body?.body
    expect(comment).toContain(summaryMarker)
    expect(await readFile(join(cwd, 'summary.md'), 'utf8')).toBe(`${comment}\n`)
  })

  it('rewrites the existing summary comment with a clean result', async () => {
    const api = await startGitHubApi({ comments: [{ body: 'unrelated', id: 1 }, { body: `${summaryMarker}\nold`, id: 2 }] })
    const cwd = await createWorkspace([])

    const result = await run(cwd, api.url)

    expect(result.exitCode).toBe(0)
    expect(api.requests[0]?.body?.conclusion).toBe('success')
    expect(api.requests.at(-1)?.method).toBe('PATCH')
    expect(api.requests.at(-1)?.url).toBe('/repos/acme/app/issues/comments/2')
    expect(api.requests.at(-1)?.body?.body).toContain('No findings')
  })

  it('does not comment on a pull request that never had findings', async () => {
    const api = await startGitHubApi({ comments: [] })
    const cwd = await createWorkspace([])

    const result = await run(cwd, api.url)

    expect(result.exitCode).toBe(0)
    expect(api.requests.map(request => request.method)).toEqual(['POST', 'GET'])
  })

  it('sends annotations above the request limit in update requests', async () => {
    const api = await startGitHubApi({ comments: [] })
    const cwd = await createWorkspace(Array.from({ length: 120 }, (_, index) => warning(index + 1)))

    const result = await run(cwd, api.url)

    expect(result.exitCode).toBe(0)
    expect(api.requests.slice(0, 3).map(request => `${request.method} ${request.url}`)).toEqual([
      'POST /repos/acme/app/check-runs',
      'PATCH /repos/acme/app/check-runs/77',
      'PATCH /repos/acme/app/check-runs/77',
    ])
    expect(api.requests.slice(0, 3).map(request => request.body?.output.annotations.length)).toEqual([50, 50, 20])
  })

  it('uses the explicit commit and pull request', async () => {
    const api = await startGitHubApi({ comments: [] })
    const cwd = await createWorkspace([warning(3)])

    const result = await run(cwd, api.url, { ALINT_GITHUB_PULL_REQUEST: '34', ALINT_GITHUB_SHA: '0123456' })

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
    expect(api.requests[0]?.body?.head_sha).toBe('0123456')
    expect(api.requests[1]?.url).toBe('/repos/acme/app/issues/34/comments?per_page=100&page=1')
  })

  it('returns 2 when GitHub rejects the request', async () => {
    const api = await startGitHubApi({ comments: [], status: 403 })
    const cwd = await createWorkspace([warning(3)])

    const result = await run(cwd, api.url)

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('Could not publish to GitHub: GitHub POST /check-runs failed with 403')
  })

  it('returns 2 without a token', async () => {
    const cwd = await createWorkspace([])
    let stderr = ''

    const exitCode = await executeCli(['node', 'alint', 'integrations', 'github', 'alint-output.json'], {
      cwd,
      env: {},
      stderr: { write: chunk => stderr += chunk },
      stdout: { write: () => {} },
    })

    expect(exitCode).toBe(2)
    expect(stderr).toBe('GitHub integration requires GITHUB_TOKEN and GITHUB_REPOSITORY.\n')
  })
})

async function createWorkspace(diagnostics: Diagnostic[]): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'alint-github-'))

  await writeFile(join(cwd, 'alint-output.json'), JSON.stringify({
    diagnostics: diagnostics.map(diagnostic => ({ ...diagnostic, filePath: join(cwd, diagnostic.filePath) })),
    usage: { inputTokens: 10, outputTokens: 5, records: [], totalTokens: 15 },
  }))
  await writeFile(join(cwd, 'event.json'), JSON.stringify({
    pull_request: { head: { sha: 'abcdef0123' }, number: 12 },
  }))

  return cwd
}

async function run(cwd: string, apiUrl: string, env: NodeJS.ProcessEnv = {}) {
  let stderr = ''
  let stdout = ''
  const exitCode = await executeCli(['node', 'alint', 'integrations', 'github', 'alint-output.json'], {
    cwd,
    env: {
      GITHUB_API_URL: apiUrl,
      GITHUB_EVENT_PATH: join(cwd, 'event.json'),
      GITHUB_REPOSITORY: 'acme/app',
      GITHUB_SHA: 'merge-commit',
      GITHUB_STEP_SUMMARY: join(cwd, 'summary.md'),
      GITHUB_TOKEN: 'test-token',
      ...env,
    },
    stderr: { write: chunk => stderr += chunk },
    stdout: { write: chunk => stdout += chunk },
  })

  return { exitCode, stderr, stdout }
}

async function startGitHubApi(options: { comments: Array<{ body: string, id: number }>, status?: number }) {
  const requests: RecordedRequest[] = []
  const server = createServer((request, response) => {
    let text = ''

    request.on('data', chunk => text += chunk)
    request.on('end', () => {
      requests.push({
        authorization: request.headers.authorization,
        body: text === '' ? undefined : JSON.parse(text),
        method: request.method ?? '',
        url: request.url ?? '',
      })
      response.writeHead(options.status ?? 200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(request.method === 'GET' ? options.comments : { id: 77 }))
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(() => new Promise(resolve => server.close(() => resolve())))

  return { requests, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

function warning(line: number): Diagnostic {
  return {
    filePath: 'src/a.ts',
    loc: { start: { column: 1, line } },
    message: `Problem at line ${line}.`,
    ruleId: 'demo/rule',
    severity: 'warn',
  }
}

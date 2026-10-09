import type { Annotation, Conclusion } from './findings'

import { isRecord } from '../../output-inspect/run-result'
import { summaryMarker } from './findings'

export interface CheckRun {
  annotations: readonly Annotation[]
  conclusion: Conclusion
  name: string
  sha: string
  summary: string
  title: string
}

export interface Repository {
  apiUrl: string
  repository: string
  token: string
}

// https://docs.github.com/en/rest/checks/runs#create-a-check-run
// One request accepts at most 50 annotations. More annotations go in update requests.
const annotationsPerRequest = 50
const commentsPerPage = 100

export async function publishCheckRun(repository: Repository, checkRun: CheckRun): Promise<void> {
  const output = { summary: checkRun.summary, title: checkRun.title }
  const created = await request(repository, 'POST', '/check-runs', {
    conclusion: checkRun.conclusion,
    head_sha: checkRun.sha,
    name: checkRun.name,
    output: { ...output, annotations: checkRun.annotations.slice(0, annotationsPerRequest) },
    status: 'completed',
  })

  if (!isRecord(created) || typeof created.id !== 'number') {
    throw new Error('GitHub returned a check run without an id.')
  }

  for (let offset = annotationsPerRequest; offset < checkRun.annotations.length; offset += annotationsPerRequest) {
    await request(repository, 'PATCH', `/check-runs/${created.id}`, {
      output: { ...output, annotations: checkRun.annotations.slice(offset, offset + annotationsPerRequest) },
    })
  }
}

/**
 * Rewrites the summary comment of a pull request.
 *
 * A pull request that never had findings gets no comment. After the first comment exists,
 * each run rewrites it, so a fixed pull request shows the clean result.
 */
export async function publishSummaryComment(
  repository: Repository,
  pullRequest: number,
  body: string,
  hasFindings: boolean,
): Promise<void> {
  const existing = await findSummaryComment(repository, pullRequest)

  if (existing !== undefined) {
    await request(repository, 'PATCH', `/issues/comments/${existing}`, { body })
    return
  }

  if (hasFindings) {
    await request(repository, 'POST', `/issues/${pullRequest}/comments`, { body })
  }
}

async function findSummaryComment(repository: Repository, pullRequest: number): Promise<number | undefined> {
  for (let page = 1; ; page += 1) {
    const comments = await request(
      repository,
      'GET',
      `/issues/${pullRequest}/comments?per_page=${commentsPerPage}&page=${page}`,
    )

    if (!Array.isArray(comments)) {
      throw new TypeError('GitHub returned a comment list that is not an array.')
    }

    for (const comment of comments) {
      if (isRecord(comment) && typeof comment.id === 'number' && typeof comment.body === 'string' && comment.body.includes(summaryMarker)) {
        return comment.id
      }
    }

    if (comments.length < commentsPerPage) {
      return undefined
    }
  }
}

async function request(repository: Repository, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${repository.apiUrl}/repos/${repository.repository}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${repository.token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    method,
  })

  if (!response.ok) {
    throw new Error(`GitHub ${method} ${path} failed with ${response.status}: ${await response.text()}`)
  }

  return response.json()
}

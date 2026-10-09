import type { CliIo } from '../../../types'

import process from 'node:process'

import { appendFile, readFile } from 'node:fs/promises'

import { errorMessageFrom } from '@moeru/std'

import { defineCommand } from '../../command'
import { isRecord, readRunResult } from '../../output-inspect/run-result'
import { publishCheckRun, publishSummaryComment } from './api'
import { formatSummary, formatTitle, toAnnotations, toConclusion, toFindings } from './findings'

interface PullRequestEvent {
  number?: number
  sha?: string
}

export const github = defineCommand({
  action: (context, file: string) => runGitHubCommand(context.io, file),
  arguments: '<file>',
  description: 'Publish saved alint JSON output to GitHub',
  exactArguments: true,
  examples: [
    [
      '# In a GitHub Actions job, lint and publish the result',
      'alint --dirty --format json > alint-output.json',
      'alint integrations github alint-output.json',
    ].join('\n'),
  ],
  help: [
    'Publish a saved alint JSON run result to GitHub as a check run with line annotations, a pull request summary comment, and a job summary.',
    'The command reads GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, and GITHUB_EVENT_PATH, which GitHub Actions sets. The token needs `checks: write` and `pull-requests: write`.',
    'Outside a pull request event, set ALINT_GITHUB_SHA to the commit that receives the check run and ALINT_GITHUB_PULL_REQUEST to the pull request that receives the comment.',
    'The check run fails when a diagnostic is an error. The command returns 0 after it publishes the result and 2 when it cannot publish.',
  ].join('\n\n'),
  name: 'github',
})

async function readPullRequestEvent(eventPath: string | undefined): Promise<PullRequestEvent> {
  if (eventPath === undefined) {
    return {}
  }

  const event: unknown = JSON.parse(await readFile(eventPath, 'utf8'))

  if (!isRecord(event) || !isRecord(event.pull_request)) {
    return {}
  }

  const { head, number } = event.pull_request

  return {
    number: typeof number === 'number' ? number : undefined,
    sha: isRecord(head) && typeof head.sha === 'string' ? head.sha : undefined,
  }
}

async function runGitHubCommand(io: CliIo, file: string): Promise<number> {
  const env = io.env ?? process.env
  const result = await readRunResult(io, file)

  if (result === undefined) {
    return 2
  }

  const token = env.GITHUB_TOKEN
  const repository = env.GITHUB_REPOSITORY

  if (!token || !repository) {
    io.stderr.write('GitHub integration requires GITHUB_TOKEN and GITHUB_REPOSITORY.\n')
    return 2
  }

  try {
    const event = await readPullRequestEvent(env.GITHUB_EVENT_PATH)
    // On a pull request event, GITHUB_SHA is the temporary merge commit.
    // A check run on that commit does not show on the pull request, so the head commit comes first.
    const sha = env.ALINT_GITHUB_SHA ?? event.sha ?? env.GITHUB_SHA
    const pullRequest = env.ALINT_GITHUB_PULL_REQUEST === undefined ? event.number : Number(env.ALINT_GITHUB_PULL_REQUEST)

    if (!sha) {
      io.stderr.write('GitHub integration requires ALINT_GITHUB_SHA or GITHUB_SHA.\n')
      return 2
    }

    if (pullRequest !== undefined && !Number.isInteger(pullRequest)) {
      io.stderr.write('ALINT_GITHUB_PULL_REQUEST must be a pull request number.\n')
      return 2
    }

    const serverUrl = env.GITHUB_SERVER_URL ?? 'https://github.com'
    const findings = toFindings(result.diagnostics, io.cwd)
    const summary = formatSummary(findings, {
      repository,
      runUrl: env.GITHUB_RUN_ID === undefined ? undefined : `${serverUrl}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`,
      serverUrl,
      sha,
      usage: result.usage,
    })
    const target = { apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com', repository, token }

    if (env.GITHUB_STEP_SUMMARY !== undefined) {
      await appendFile(env.GITHUB_STEP_SUMMARY, `${summary}\n`)
    }

    await publishCheckRun(target, {
      annotations: toAnnotations(findings),
      conclusion: toConclusion(findings),
      name: 'alint',
      sha,
      summary,
      title: formatTitle(findings),
    })

    if (pullRequest !== undefined) {
      await publishSummaryComment(target, pullRequest, summary, findings.length > 0)
    }

    io.stdout.write(`Published ${formatTitle(findings).toLowerCase()} to ${repository}@${sha.slice(0, 7)}.\n`)
    return 0
  }
  catch (error) {
    io.stderr.write(`Could not publish to GitHub: ${errorMessageFrom(error) ?? 'unknown error'}\n`)
    return 2
  }
}

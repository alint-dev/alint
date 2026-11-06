import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { getGlobalSetupConfigPath, getProjectSetupConfigPath, installStaticPlugins, writeSetupConfig } from '@alint-js/config'
import { describe, expect, it, vi } from 'vitest'

import { executeCli } from './cli'

const acpCases: Array<{
  rule: 'coding-agent' | 'structured'
  runtime: 'fake' | 'real'
  scope: 'global' | 'project'
}> = [
  { rule: 'structured', runtime: 'fake', scope: 'global' },
  { rule: 'structured', runtime: 'fake', scope: 'project' },
  { rule: 'coding-agent', runtime: 'fake', scope: 'global' },
  ...(process.env.ALINT_ACP_E2E_COMMAND
    ? [
        { rule: 'structured' as const, runtime: 'real' as const, scope: 'project' as const },
      ]
    : []),
]

describe('cli ACP adapter end to end', () => {
  it.each(acpCases)('starts a $runtime ACP model from $scope setup and runs an alint $rule rule', async ({ rule, runtime, scope }) => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-cli-acp-'))
    const configHome = await mkdtemp(join(tmpdir(), 'alint-cli-acp-home-'))
    const agentPath = join(cwd, 'agent.mjs')
    const stoppedPath = join(cwd, 'stopped.txt')
    const stderr: string[] = []
    const stdout: string[] = []
    const gatewayRoot = resolve(import.meta.dirname, '../../../model-adapter-acp')
    const coreRoot = resolve(import.meta.dirname, '../../../core')
    // Resolved through the package's `exports` from the gateway, which owns the dependency, so the
    // fake agent follows the SDK's internal layout instead of hardcoding a `dist/` path.
    const acpUrl = pathToFileURL(createRequire(join(gatewayRoot, 'package.json')).resolve('@agentclientprotocol/sdk')).href
    const mcpClientUrl = pathToFileURL(join(
      await realpath(join(gatewayRoot, 'node_modules/@modelcontextprotocol/sdk')),
      'dist/esm/client/index.js',
    )).href
    const mcpTransportUrl = pathToFileURL(join(
      await realpath(join(gatewayRoot, 'node_modules/@modelcontextprotocol/sdk')),
      'dist/esm/client/streamableHttp.js',
    )).href
    const structuredOutputUrl = pathToFileURL(join(coreRoot, 'src/structuredOutput/index.ts')).href
    const valibotUrl = pathToFileURL(join(
      await realpath(join(coreRoot, 'node_modules/valibot')),
      'dist/index.mjs',
    )).href

    await writeFile(join(cwd, 'demo.ts'), 'export function reviewMe() { return 1 }\n', 'utf8')
    if (rule === 'coding-agent') {
      const rulesPath = join(cwd, 'rules')
      await mkdir(rulesPath)
      await writeFile(join(cwd, 'alint.config.toml'), `
[[config.group]]
files = ["**/*.ts"]

[config.group.plugins]
review = "./rules"

[config.group.rules]
"review/code-review" = "warn"
`, 'utf8')
      await writeFile(join(rulesPath, 'rule.alint.toml'), `
name = "code-review"
builtInAgent = "basic-coding-agent"
instruction = "Report one finding."
`, 'utf8')
      await installStaticPlugins({ cwd })
    }
    else {
      await writeFile(join(cwd, 'alint.config.ts'), `
import { generateStructured } from ${JSON.stringify(structuredOutputUrl)}
import { array, object, string } from ${JSON.stringify(valibotUrl)}

const schema = object({ findings: array(object({ message: string() })) })

export default [{
  files: ['**/*.ts'],
  language: 'typescript',
  plugins: {
    e2e: {
      rules: {
        review: {
          languages: 'any',
          create: ctx => ({
            onTargetFile: async target => {
              const result = await generateStructured({
                createMessages: () => [{
                  content: 'Call reportFindings with exactly one finding whose message is "Use a named constant." for ' + target.file.path,
                  role: 'user',
                }],
                model: await ctx.model(),
                operation: 'cli-acp-adapter',
                retryDelay: () => 0,
                schema,
              })
              for (const finding of result.findings) ctx.report({ message: finding.message })
            },
          }),
        },
      },
    },
  },
  rules: { 'e2e/review': 'warn' },
}]
`, 'utf8')
    }
    if (runtime === 'fake') {
      const reportToolName = rule === 'coding-agent'
        ? 'report_findings'
        : 'reportFindings'
      const reportArguments = rule === 'coding-agent'
        ? {
            findings: [
              {
                confidence: 'high',
                filePath: 'demo.ts',
                line: 1,
                message: 'Use a named constant.',
                suggestion: 'Extract the value into a named constant.',
              },
            ],
          }
        : {
            findings: [
              { message: 'Use a named constant.' },
            ],
          }
      await writeFile(agentPath, `
import { writeFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import * as acp from ${JSON.stringify(acpUrl)}
import { Client } from ${JSON.stringify(mcpClientUrl)}
import { StreamableHTTPClientTransport } from ${JSON.stringify(mcpTransportUrl)}

process.on('SIGTERM', () => {
  writeFileSync(${JSON.stringify(stoppedPath)}, 'stopped')
  process.exit(0)
})

let mcpServer
acp.agent({ name: 'alint-e2e-agent' })
  .onRequest(acp.methods.agent.initialize, () => ({
    agentCapabilities: { loadSession: false, mcpCapabilities: { http: true } },
    protocolVersion: acp.PROTOCOL_VERSION,
  }))
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    mcpServer = params.mcpServers[0]
    return { sessionId: crypto.randomUUID() }
  })
  .onRequest(acp.methods.agent.session.prompt, async () => {
    const client = new Client({ name: 'alint-e2e-agent', version: '1.0.0' })
    const headers = Object.fromEntries(mcpServer.headers.map(header => [header.name, header.value]))
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpServer.url), { requestInit: { headers } }))
    try {
      const tools = await client.listTools()
      const report = tools.tools.find(tool => tool.name === ${JSON.stringify(reportToolName)})
      if (!report) throw new Error('Expected report tool.')
      await client.callTool({
        arguments: ${JSON.stringify(reportArguments)},
        name: report.name,
      })
      return { stopReason: 'end_turn' }
    }
    finally {
      await client.close()
    }
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
`, 'utf8')
    }

    const setupPath = scope === 'global'
      ? getGlobalSetupConfigPath({ XDG_CONFIG_HOME: configHome })
      : getProjectSetupConfigPath(cwd)

    await writeSetupConfig(setupPath, {
      providers: [
        {
          id: 'acp',
          models: [
            {
              aliases: ['default'],
              args: runtime === 'fake'
                ? [agentPath]
                : parseIntegrationArgs(process.env.ALINT_ACP_E2E_ARGS_JSON),
              command: runtime === 'fake'
                ? process.execPath
                : process.env.ALINT_ACP_E2E_COMMAND!,
              driver: 'acp',
              id: 'reviewer',
            },
          ],
        },
      ],
      version: 1,
    })

    const exitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      '--model',
      'acp/reviewer',
      '--timeout-ms',
      '180000',
      'demo.ts',
    ], {
      cwd,
      env: { ...process.env, XDG_CONFIG_HOME: configHome },
      stderr: {
        write: chunk => stderr.push(chunk),
      },
      stdout: {
        write: chunk => stdout.push(chunk),
      },
    })

    expect(exitCode, stderr.join('')).toBe(0)
    expect(JSON.parse(stdout.join('')).diagnostics).toMatchObject([
      {
        message: 'Use a named constant.',
        model: { providerId: 'acp', resolvedId: 'reviewer' },
        ruleId: rule === 'coding-agent'
          ? 'review/code-review'
          : 'e2e/review',
      },
    ])
    expect(stderr.join('')).toBe('')
    if (runtime === 'fake') {
      await vi.waitFor(async () => {
        await expect(readFile(stoppedPath, 'utf8')).resolves.toBe('stopped')
      })
    }
  }, 190_000)
})

function parseIntegrationArgs(value: string | undefined): string[] {
  if (value === undefined) {
    return []
  }

  const parsed: unknown = JSON.parse(value)

  if (!Array.isArray(parsed) || !parsed.every(argument => typeof argument === 'string')) {
    throw new TypeError('ALINT_ACP_E2E_ARGS_JSON must be a JSON array of strings.')
  }

  return parsed
}

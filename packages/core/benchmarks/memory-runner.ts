import type { ProgressSnapshot } from '../src/index'

import process from 'node:process'

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { defineConfig, definePlugin, defineRule, runAlint } from '../src/index'

const setupConfig = { providers: [], version: 1 } as const

async function main(): Promise<void> {
  const [, , scenario, root] = process.argv

  if (!root)
    throw new Error('Memory regression runner requires a scenario and root path.')

  if (scenario === 'project') {
    const files = (await readdir(root))
      .filter(path => path.endsWith('.mock'))
      .sort()
      .map(path => join(root, path))
    const functionRule = defineRule({
      create: () => ({
        onTargetFunction: () => {},
      }),
      languages: 'any',
    })
    const projectRule = defineRule({
      create: () => ({
        onTargetProject: (target) => {
          if (target.files.length !== 120 || target.targets.length !== 9_600) {
            throw new Error(`Unexpected compact project target: ${target.files.length} files, ${target.targets.length} targets.`)
          }
        },
      }),
    })
    const plugin = definePlugin({
      languages: {
        mock: {
          extensions: ['.mock'],
          extract: (file) => {
            const targets = []
            const pattern = /\/\* TARGET (\d+) \*\/\n([\s\S]*?)(?=\/\* TARGET |$)/g
            for (const match of file.text.matchAll(pattern)) {
              const index = Number(match[1])
              const text = match[2] ?? ''
              const start = (match.index ?? 0) + match[0].length - text.length
              targets.push({
                file,
                identity: `function:${index}`,
                kind: 'function' as const,
                language: 'benchmark/mock',
                range: { end: start + text.length, start },
                text,
              })
            }
            return targets
          },
          name: 'benchmark/mock',
        },
      },
      rules: { function: functionRule, project: projectRule },
    })
    const result = await runAlint({
      config: defineConfig([
        {
          plugins: { benchmark: plugin },
          rules: {
            'benchmark/function': 'warn',
            'benchmark/project': 'warn',
          },
        },
        {
          files: ['**/*.mock'],
          language: 'benchmark/mock',
        },
      ]),
      cwd: root,
      files,
      runner: { cache: false },
      setupConfig,
    })
    process.stdout.write(JSON.stringify(result.execution))
  }
  else if (scenario === 'blocked-planning') {
    const files = (await readdir(root))
      .filter(path => path.endsWith('.blocked'))
      .sort()
      .map(path => join(root, path))
    let releaseHandlers!: () => void
    const handlersBlocked = new Promise<void>((resolve) => {
      releaseHandlers = resolve
    })
    const rule = defineRule({
      create: () => ({
        /**
         * Holds every benchmark job until planning has admitted the complete compact workload.
         *
         * Triggering workflow:
         *
         * {@link rule}
         *   -> `RuleHandlers.onTargetFile`
         *     -> `handlersBlocked`
         *
         * Upstream:
         * - {@link rule}
         *
         * Downstream:
         * - `handlersBlocked`
         */
        onTargetFile: () => handlersBlocked,
      }),
    })
    const plugin = definePlugin({
      languages: {
        blocked: {
          extensions: ['.blocked'],
          extract: file => [
            {
              file,
              identity: 'file',
              kind: 'file',
              language: 'benchmark/blocked',
              text: file.text,
            },
          ],
          name: 'benchmark/blocked',
        },
      },
      rules: { blocked: rule },
    })
    let planningProgress: ProgressSnapshot | undefined
    const result = await runAlint({
      config: defineConfig([
        {
          plugins: { benchmark: plugin },
          rules: { 'benchmark/blocked': 'warn' },
        },
        {
          files: ['**/*.blocked'],
          language: 'benchmark/blocked',
        },
      ]),
      cwd: root,
      files,
      progress: {
        onPlanningEnd: ({ progress }) => {
          planningProgress = progress
          releaseHandlers()
        },
      },
      projectTargets: false,
      runner: { cache: false, ruleConcurrency: 20 },
      setupConfig,
    })
    process.stdout.write(JSON.stringify({ execution: result.execution, planningProgress }))
  }
  else if (scenario === 'legacy-cache') {
    const result = await runAlint({
      config: [],
      cwd: root,
      files: [],
      runner: { cache: true },
      setupConfig,
    })
    process.stdout.write(JSON.stringify(result.execution))
  }
  else if (scenario === 'hang') {
    process.stdout.write('o'.repeat(2 * 64 * 1024))
    process.stderr.write('e'.repeat(2 * 64 * 1024))
    process.on('SIGTERM', () => {})
    setInterval(() => {}, 1_000)
  }
  else {
    throw new Error(`Unknown memory regression scenario: ${scenario}`)
  }
}

void main()

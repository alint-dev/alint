import type { InspectOptions } from 'node:util'

import type { CliIo, CliWritable } from './types'

import { inspect } from 'node:util'

import { cac } from 'cac'

import packageJson from '../../package.json'

import { commandTree, registerCommandTree } from './commands'

export type { CliIo } from './types'

export interface CliRuntimeOptions {
  signal?: AbortSignal
}

export async function executeCli(argv: string[], io: CliIo, runtime: CliRuntimeOptions = {}): Promise<number> {
  // cac's built-in `--version` prints `alint/<version> <platform> node-<version>`,
  // but we only need a pure version string here.
  if (argv.includes('--version') || argv.includes('-v')) {
    io.stdout.write(`${packageJson.version}\n`)
    return 0
  }

  const cli = cac('alint')
  const setupNoInteractive = argv.includes('-N') || argv.includes('--no-interactive')
  const globalOptions = {
    outputLanguage: parseStringOption(argv, ['--lang', '-l']),
  }
  let pendingResult: Promise<number> | undefined
  const setPendingResult = (result: Promise<number>) => {
    pendingResult = result
    return result
  }

  cli
    .option('--no-cache', 'Disable cache for this run')
    .option('--cache-location <path>', 'Path to the alint cache file or directory')
    .option('--cache-only', 'Report only cached diagnostics; skip rules that miss the cache and call no model')
    .option('-c, --config <path>', 'Path to alint config file')
    .option('--format <format>', 'Reporter format', { default: 'stylish' })
    .option('--model <model>', 'Force a model override')
    .option('-l, --lang <language>', 'Ask model-backed rules to write diagnostics in this language')
    .option('--progress', 'Show run progress')
    .option('--rule <pattern>', 'Only run rules whose id, name, or glob matches (repeatable, comma-separated)')
    .option('--rule-concurrency <count>', 'Maximum rule executions across the entire run')
    .option('--no-stats', 'Do not record run stats for this run')
    .option('--timeout-ms <ms>', 'Rule execution timeout in milliseconds')
    .version(packageJson.version) // To keep `-v` and `--version` visible in `alint --help` output.
    .help()

  registerCommandTree(cli, commandTree, {
    globalOptions,
    interceptConsoleOutput,
    io,
    setupNoInteractive,
    signal: runtime.signal,
  }, setPendingResult, {
    examples: [
      [
        '# Configure a provider interactively',
        'alint setup',
      ].join('\n'),
      [
        '# Run alint on source files with the default stylish reporter',
        'alint src',
      ].join('\n'),
      [
        '# Run alint and save machine-readable JSON for later inspection',
        'alint --format json src > alint-output.json',
        'alint output inspect alint-output.json',
      ].join('\n'),
      [
        '# Inspect the effective config that applies to a file',
        'alint config inspect src/index.ts',
      ].join('\n'),
      [
        '# List configured providers and models',
        'alint config providers list',
        'alint config models list',
      ].join('\n'),
    ],
    help: [
      'AI-assisted linting for source files, saved run outputs, and provider/model setup.',
      'Start with `alint setup` to configure a model provider, run `alint <files>` to analyze files, and use `alint output inspect` to read saved JSON output without rerunning rules.',
    ].join('\n\n'),
  })

  const restoreConsole = interceptConsoleOutput(shouldCaptureHelp(argv) ? io.stdout : io.stderr)

  try {
    cli.parse(argv)
    return await (pendingResult ?? Promise.resolve(0))
  }
  finally {
    restoreConsole()
  }
}

function interceptConsoleOutput(stdout: CliWritable): () => void {
  const cliConsole = globalThis.console
  const originalConsoleDebug = cliConsole.debug
  const originalConsoleDir = cliConsole.dir
  const originalConsoleInfo = console.info
  const originalConsoleLog = cliConsole.log

  const writeConsoleLine = (...args: unknown[]) => {
    stdout.write(`${args.map(String).join(' ')}\n`)
  }
  const writeConsoleDir = (item?: unknown, options?: InspectOptions) => {
    stdout.write(`${inspect(item, options)}\n`)
  }

  cliConsole.debug = writeConsoleLine
  cliConsole.dir = writeConsoleDir
  console.info = writeConsoleLine
  cliConsole.log = writeConsoleLine

  return () => {
    cliConsole.debug = originalConsoleDebug
    cliConsole.dir = originalConsoleDir
    console.info = originalConsoleInfo
    cliConsole.log = originalConsoleLog
  }
}

function parseStringOption(argv: readonly string[], flags: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]

    for (const flag of flags) {
      const equalsPrefix = `${flag}=`

      if (value?.startsWith(equalsPrefix)) {
        return value.slice(equalsPrefix.length)
      }

      if (value === flag) {
        return argv[index + 1]
      }
    }
  }

  return undefined
}

function shouldCaptureHelp(argv: string[]): boolean {
  return argv.includes('--help') || argv.includes('-h')
}

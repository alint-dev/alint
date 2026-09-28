import type {
  AlintConfig,
  NormalizedRunnerCacheConfig,
  ProgressReporter,
  RunnerConfig,
  RunResult,
  SetupConfig,
} from '@alint-js/core'

import type { LintTargets } from '../commands/lint/discovery'
import type { CliIo } from '../types'

import { loadAlintConfig } from '@alint-js/config'
import { normalizeRunnerCacheConfig, runAlint } from '@alint-js/core'

import { loadRunSetupConfig } from '../commands/config/setup-config'
import { findLintTargets } from '../commands/lint/discovery'
import { startModelAdapters } from './model-adapter'
import { mergeRunnerConfigs, resolveConfigRunner } from './runner'

export interface CreateRunSessionOptions {
  /** Reuses a config that the caller already loaded to make a pre-run policy decision. */
  config?: AlintConfig
  configPath?: string
  /** Spawns ACP processes and binds a loopback port. Replace it to keep a session offline. */
  startModelAdapters?: typeof startModelAdapters
}

export interface RunSession {
  /** Where this project's cache file is, and whether the project uses one. */
  cache: NormalizedRunnerCacheConfig
  config: AlintConfig
  cwd: string
  defaultModel?: string
  run: (options: SessionRunOptions) => Promise<RunResult>
  /** Setup config merged with project config. No CLI flag is applied. */
  runner?: RunnerConfig
  setupConfig: SetupConfig
  shutdown: () => Promise<void>
}

export type SessionRunOptions = SessionRunSettings & SessionTargetSelection

export type SessionTargetSelection
  = | { inputs?: never, targets: LintTargets }
    | { inputs?: string[], targets?: never }

interface SessionRunSettings {
  cacheOnly?: boolean
  modelOverride?: string
  outputLanguage?: string
  progress?: ProgressReporter
  projectTargets?: boolean
  ruleFilter?: readonly string[]
  runner?: RunnerConfig
  signal?: AbortSignal
}

/**
 * Loads config, setup config, and model adapters once, then runs any number of times.
 *
 * The lint command and the language server both use this function. A second implementation would
 * resolve config or cwd differently, and the editor would then read a different cache file.
 */
export async function createRunSession(
  io: CliIo,
  options: CreateRunSessionOptions = {},
): Promise<RunSession> {
  const [{ defaultModel, setupConfig: fileSetupConfig }, config] = await Promise.all([
    loadRunSetupConfig(io),
    options.config ?? loadAlintConfig(io.cwd, options.configPath),
  ])
  const startAdapters = options.startModelAdapters ?? startModelAdapters
  const runtime = await startAdapters(fileSetupConfig, io)

  // core hashes setupConfig into modelHash, and normalization can embed a per-process ACP port.
  // Normalize once, or each run gets a different cache key.
  const { setupConfig } = runtime
  let shutdown: Promise<void> | undefined

  const runner = mergeRunnerConfigs(setupConfig.runner, resolveConfigRunner(config))

  return {
    cache: normalizeRunnerCacheConfig(runner?.cache, io.cwd),
    config,
    cwd: io.cwd,
    defaultModel,
    run: async (runOptions) => {
      const targets = runOptions.targets ?? await findLintTargets({
        config,
        cwd: io.cwd,
        errorOnUnmatchedPattern: true,
        globInputPaths: true,
        inputs: runOptions.inputs ?? [],
      })

      return runAlint({
        cacheOnly: runOptions.cacheOnly,
        config,
        cwd: io.cwd,
        defaultModel,
        directories: targets.directories,
        files: targets.files,
        modelOverride: runOptions.modelOverride,
        outputLanguage: runOptions.outputLanguage,
        progress: runOptions.progress,
        projectTargets: runOptions.projectTargets,
        ruleFilter: runOptions.ruleFilter,
        runner: runOptions.runner,
        setupConfig,
        signal: runOptions.signal,
      })
    },
    runner,
    setupConfig,
    // Two owners can dispose the same session. Shut the gateway down only once.
    shutdown: () => shutdown ??= runtime.shutdown(),
  }
}

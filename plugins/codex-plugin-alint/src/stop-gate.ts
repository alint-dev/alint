#!/usr/bin/env node

import type { HookDecision, HookInput, SessionState, StopGateEnvelope } from './types'

import process from 'node:process'

import { readFileSync, writeSync } from 'node:fs'

import { errorMessageFrom } from '@moeru/std'

import { reportFatalFailure } from './fatal-diagnostic'
import { applyResult, lintLimitDecision, maximumLintRounds, runtimeErrorMessage } from './policy'
import { findGitRoot, hasProjectConfig, isHeadDetached } from './repository'
import { resolveAlintStopGate } from './runner'
import { createStateStore } from './state'

function emit(decision: HookDecision): void {
  if (Object.keys(decision).length > 0) {
    // Hook processes are short-lived and Codex captures both descriptors through pipes. Write
    // synchronously so the process cannot exit before the host receives the complete decision.
    writeSync(process.stdout.fd, `${JSON.stringify(decision)}\n`)
  }
}

function inactiveEnvelope(): StopGateEnvelope {
  return {
    errorCount: 0,
    schemaVersion: 2,
    status: 'inactive',
    warningCount: 0,
  }
}

function readHookInput(): HookInput {
  const input = readFileSync(0, 'utf8').trim()
  return input.length === 0
    ? {}
    : JSON.parse(input) as HookInput
}

function requiredString(value: string | undefined, message: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(message)
  }

  return value
}

function runtimeErrorEnvelope(message: string): StopGateEnvelope {
  return {
    errorCount: 0,
    message,
    schemaVersion: 2,
    status: 'runtime-error',
    warningCount: 0,
  }
}

let parsedInput: HookInput | undefined

try {
  parsedInput = readHookInput()
}
catch (error) {
  reportFatalFailure('Could not read Codex hook input', error)
}

if (parsedInput !== undefined) {
  void run(parsedInput).catch((error) => {
    try {
      const message = runtimeErrorMessage({ message: errorMessageFrom(error) ?? 'unknown error' })
      const hookFailureDecision: HookDecision = parsedInput?.stop_hook_active
        ? { systemMessage: message }
        : { decision: 'block', reason: message }
      emit(hookFailureDecision)
    }
    catch (emitError) {
      reportFatalFailure('Could not return its hook failure decision', emitError)
    }
  })
}

async function run(input: HookInput): Promise<void> {
  const sessionId = requiredString(input.session_id, 'Stop hook input did not include session_id.')
  // Codex defines CLAUDE_PLUGIN_DATA as an official compatibility alias for its PLUGIN_DATA variable.
  const pluginData = requiredString(process.env.CLAUDE_PLUGIN_DATA, 'Codex did not provide CLAUDE_PLUGIN_DATA to the alint plugin.')
  const store = createStateStore(pluginData)
  const state = await store.load(sessionId)
  let result: Awaited<ReturnType<typeof runForInput>>

  try {
    result = await runForInput(input, sessionId, state)
  }
  catch (error) {
    result = {
      envelope: runtimeErrorEnvelope(errorMessageFrom(error) ?? 'unknown error'),
    }
  }

  if (result.decision !== undefined) {
    emit(result.decision)
    return
  }

  const envelope = result.envelope ?? runtimeErrorEnvelope('unknown error')
  const applied = applyResult(state, envelope)
  await store.save(sessionId, applied.state)
  emit(applied.decision)
}

async function runForInput(
  input: HookInput,
  sessionId: string,
  state: SessionState,
): Promise<{ decision?: HookDecision, envelope?: StopGateEnvelope }> {
  const gitRoot = await findGitRoot(input.cwd ?? process.cwd())

  if (gitRoot === undefined || !await hasProjectConfig(gitRoot)) {
    return {
      envelope: inactiveEnvelope(),
    }
  }

  const stopGate = await resolveAlintStopGate(gitRoot)

  if (!stopGate.enabled) {
    return {
      envelope: inactiveEnvelope(),
    }
  }

  if (stopGate.target === 'dirty-files' && await isHeadDetached(gitRoot)) {
    return {
      decision: {
        systemMessage: 'alint-plugin: Stop Gate skipped because Git HEAD is detached. You may need to let the user know that. Run `alint --dirty` manually if this checkout should be reviewed.',
      },
    }
  }

  if (state.lintRounds >= maximumLintRounds) {
    return {
      decision: lintLimitDecision(state),
    }
  }

  return { envelope: await stopGate.run(sessionId) }
}

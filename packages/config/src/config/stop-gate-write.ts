import type { ResolvedStopGateConfig, StopGateTarget } from '@alint-js/core'

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'

import { defaultStopGateConfig, resolveStopGateConfig } from '@alint-js/core'
import { dirname, extname, join, resolve } from 'pathe'
import { parse, stringify } from 'smol-toml'

import { loadAlintConfigWithMetadata } from './load'

export interface SetStopGateConfigOptions {
  configFile?: string
  cwd: string
  enabled?: boolean
  target?: StopGateTarget
  timeoutMs?: number
}

interface StaticConfigDocument {
  config: {
    group: Record<string, unknown>[]
  }
}

export async function setStopGateConfig(
  options: SetStopGateConfigOptions,
): Promise<{ config: ResolvedStopGateConfig, configFile: string }> {
  if (options.enabled === undefined && options.target === undefined && options.timeoutMs === undefined) {
    throw new Error('Stop Gate config write requires enabled, target, or timeoutMs.')
  }

  const loaded = await loadAlintConfigWithMetadata(options.cwd, options.configFile)

  if (options.configFile !== undefined && loaded.configFile === undefined) {
    throw new Error(`Config file "${options.configFile}" does not exist.`)
  }

  const config = resolveStopGateConfig([
    ...loaded.config,
    {
      integrations: {
        stopGate: {
          enabled: options.enabled,
          target: options.target,
          timeoutMs: options.timeoutMs,
        },
      },
    },
  ], options.cwd)

  const configFile = loaded.configFile === undefined
    ? join(options.cwd, 'alint.config.toml')
    : resolve(options.cwd, loaded.configFile)

  if (extname(configFile).toLowerCase() !== '.toml') {
    throw new Error('Stop Gate config writes require an alint.config.toml file.')
  }

  const document: StaticConfigDocument = loaded.configFile === undefined
    ? {
        config: { group: [] },
      }
    : parseStaticConfigDocument(await readFile(configFile, 'utf8'))
  const stopGates: Record<string, unknown>[] = []
  for (const group of document.config.group) {
    if (isPlainObject(group.integrations) && isPlainObject(group.integrations.stopGate))
      stopGates.push(group.integrations.stopGate)
  }

  setOverride(document, stopGates, 'enabled', options.enabled, defaultStopGateConfig.enabled)
  setOverride(document, stopGates, 'target', options.target, defaultStopGateConfig.target)
  setOverride(document, stopGates, 'timeoutMs', options.timeoutMs, defaultStopGateConfig.timeoutMs)

  for (const stopGate of stopGates) {
    removeEmptyStopGateConfig(document, stopGate)
  }

  await writeConfigAtomically(configFile, stringify(document))

  return {
    config,
    configFile,
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseStaticConfigDocument(toml: string): StaticConfigDocument {
  const document = parse(toml)

  if (!isPlainObject(document) || !isPlainObject(document.config) || !Array.isArray(document.config.group)) {
    throw new Error('Static TOML config must use [[config.group]].')
  }

  if (!document.config.group.every(isPlainObject)) {
    throw new TypeError('Static config field "config.group" must contain only tables.')
  }

  return document as unknown as StaticConfigDocument
}

function removeEmptyStopGateConfig(
  document: StaticConfigDocument,
  stopGate: Record<string, unknown>,
): void {
  if (Object.keys(stopGate).length > 0) {
    return
  }

  for (let index = document.config.group.length - 1; index >= 0; index -= 1) {
    const group = document.config.group[index]
    const integrations = group?.integrations

    if (!isPlainObject(integrations) || integrations.stopGate !== stopGate) {
      continue
    }

    delete integrations.stopGate

    if (Object.keys(integrations).length === 0) {
      delete group.integrations
    }

    if (group.name === 'alint stop gate' && Object.keys(group).length === 1) {
      document.config.group.splice(index, 1)
    }

    return
  }
}

function setOverride<T>(
  document: StaticConfigDocument,
  stopGates: Record<string, unknown>[],
  key: string,
  value: T | undefined,
  defaultValue: T,
): void {
  if (value === undefined) {
    return
  }

  if (value === defaultValue) {
    for (const stopGate of stopGates) {
      delete stopGate[key]
    }
    return
  }

  let stopGate = stopGates.at(-1)
  if (stopGate === undefined) {
    stopGate = {}
    document.config.group.push({
      integrations: { stopGate },
      name: 'alint stop gate',
    })
    stopGates.push(stopGate)
  }
  stopGate[key] = value
}

async function writeConfigAtomically(configFile: string, content: string): Promise<void> {
  await mkdir(dirname(configFile), { recursive: true })
  const tempFile = `${configFile}.${randomUUID()}.tmp`

  await writeFile(tempFile, content, 'utf8')
  await rename(tempFile, configFile)
}

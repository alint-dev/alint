import type { CliIo } from '../../types'

import { stat } from 'node:fs/promises'

import { loadAlintConfig } from '@alint-js/config'
import { resolveConfigForDirectory, resolveConfigForFile } from '@alint-js/core'
import { resolve } from 'pathe'

import { defineCommand } from '../command'

export const inspect = defineCommand({
  action: (context, path: string, options: { config?: string }) =>
    runConfigInspectCommand(path, options.config, context.io),
  arguments: '<path>',
  description: 'Inspect resolved config for a file or directory',
  name: 'inspect',
})

async function runConfigInspectCommand(
  path: string,
  configPath: string | undefined,
  io: CliIo,
): Promise<number> {
  const config = await loadAlintConfig(io.cwd, configPath)
  const targetPath = resolve(io.cwd, path)
  const isDirectory = await stat(targetPath)
    .then(stats => stats.isDirectory())
    .catch(() => false)
  const result = isDirectory
    ? resolveConfigForDirectory(targetPath, config, { cwd: io.cwd })
    : resolveConfigForFile(targetPath, config, { cwd: io.cwd })

  io.stdout.write(`${isDirectory ? 'directory' : 'file'}: ${path}\n`)
  io.stdout.write(`ignored: ${result.ignored ? 'yes' : 'no'}\n`)
  io.stdout.write('matched:\n')

  for (const item of result.matched) {
    io.stdout.write(`  - ${item.name ?? '<anonymous>'}\n`)
  }

  io.stdout.write(`language: ${result.config.language ?? '<inferred>'}\n`)
  io.stdout.write('rules:\n')

  for (const [id, entry] of Object.entries(result.config.rules)) {
    io.stdout.write(`  ${id}: ${Array.isArray(entry)
      ? entry[0]
      : entry}\n`)
  }

  return 0
}

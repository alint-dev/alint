import type { ReporterName } from '../../reporters'
import type { CliIo } from '../../types'

import { errorMessageFrom } from '@moeru/std'

import { formatDiagnostics } from '../../reporters'
import { defineCommand } from '../command'
import { readRunResult } from './run-result'

interface OutputInspectOptions {
  format: ReporterName
}

export const inspect = defineCommand({
  action: (context, file: string, options: OutputInspectOptions) =>
    inspectOutputFile(context.io, file, options),
  arguments: '<file>',
  description: 'Inspect saved alint JSON output',
  examples: [
    [
      '# Pretty-print saved JSON output',
      'alint output inspect alint-output.json',
    ].join('\n'),
    [
      '# Validate and reprint normalized JSON',
      'alint output inspect alint-output.json --format json',
    ].join('\n'),
    [
      '# Save a run as JSON, then inspect it later',
      'alint --format json src > alint-output.json',
      'alint output inspect alint-output.json',
    ].join('\n'),
  ],
  help: [
    'Read a saved alint JSON run result and render it with a reporter.',
    'Defaults to the human-friendly stylish reporter, which groups diagnostics by file and prints the same summary style as a normal alint run. Use `--format json` to validate the file and reprint normalized JSON.',
  ].join('\n\n'),
  name: 'inspect',
  options: [
    {
      config: { default: 'stylish' },
      description: 'Reporter used to render the parsed run result. One of: stylish, json',
      flags: '-f, --format <format>',
    },
  ],
})

async function inspectOutputFile(
  io: CliIo,
  file: string,
  options: OutputInspectOptions,
): Promise<number> {
  const parsed = await readRunResult(io, file)

  if (parsed === undefined) {
    return 2
  }

  try {
    io.stdout.write(formatDiagnostics(options.format, parsed, {
      color: io.stdout.isTTY === true,
    }))
  }
  catch (error) {
    io.stderr.write(`${errorMessageFrom(error)}\n`)
    return 2
  }

  return parsed.diagnostics.some(diagnostic => diagnostic.severity === 'error') ? 1 : 0
}

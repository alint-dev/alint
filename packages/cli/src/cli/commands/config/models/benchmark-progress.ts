import type { SetupConfig } from '@alint-js/config'
import type { ModelBenchmarkProgress } from '@alint-js/core'

import type { CliWritable } from '../../../types'

import cliSpinners from 'cli-spinners'
import fastStringWidth from 'fast-string-width'

import { formatModelBenchmarkProgressFrame } from '../../../provider-registry'

export interface ModelBenchmarkProgressDisplay {
  finish: () => void
  update: (progress: ModelBenchmarkProgress) => void
}

export interface ModelBenchmarkProgressDisplayOptions {
  color: boolean
  config: SetupConfig
  output: CliWritable
}

/** Keeps the benchmark preview live without mixing transient frames into the final stdout table. */
export function createModelBenchmarkProgressDisplay(
  options: ModelBenchmarkProgressDisplayOptions,
): ModelBenchmarkProgressDisplay {
  const frames = cliSpinners.dots.frames
  let frameIndex = 0
  let latest: ModelBenchmarkProgress | undefined
  let previous: ReturnType<typeof formatModelBenchmarkProgressFrame> | undefined
  let interval: ReturnType<typeof globalThis.setInterval> | undefined

  const render = (): void => {
    if (latest === undefined) {
      return
    }

    const next = formatModelBenchmarkProgressFrame(options.config, latest, {
      color: options.color,
      frame: frames[frameIndex % frames.length] ?? '',
      maxRows: options.output.rows,
      // The spinner already communicates activity. Keeping the footer bar static avoids unrelated writes.
      tick: 0,
    })

    if (previous === undefined || !sameLayout(previous, next)) {
      clearFrame(options.output, previous?.rows.length ?? 0)
      options.output.write(`${next.rows.map(row => `${row.prefix}${row.suffix}`).join('\n')}\r`)
      previous = next
      return
    }

    for (const [rowIndex, row] of next.rows.entries()) {
      const previousRow = previous.rows[rowIndex]

      if (previousRow !== undefined && previousRow.suffix !== row.suffix) {
        patchSuffix(options.output, rowIndex, next.rows.length, fastStringWidth(row.prefix), row.suffix)
      }
    }

    previous = next
  }

  const start = (): void => {
    if (interval === undefined) {
      interval = globalThis.setInterval(() => {
        frameIndex += 1
        render()
      }, cliSpinners.dots.interval)
      interval.unref()
    }

    render()
  }

  /**
   * Applies one core benchmark progress snapshot to the transient TTY table.
   *
   * Triggering workflow:
   *
   * `benchmarkModels` `onProgress`
   *   -> `config models list --with-speed`
   *     -> `ModelBenchmarkProgressDisplay.update`
   *
   * Upstream:
   * - `benchmarkModels` `onProgress` callback registered by `runListModelsCommand`
   *
   * Downstream:
   * - incremental benchmark table renderer `start` or `render`
   */
  const update = (progress: ModelBenchmarkProgress): void => {
    latest = progress

    if (interval === undefined) {
      start()
      return
    }

    render()
  }

  return {
    finish: () => {
      if (interval !== undefined) {
        globalThis.clearInterval(interval)
        interval = undefined
      }

      clearFrame(options.output, previous?.rows.length ?? 0)
      previous = undefined
    },
    update,
  }
}

function clearFrame(output: CliWritable, rowCount: number): void {
  if (rowCount === 0) {
    return
  }

  let sequence = '\r\x1B[K'

  for (let row = 1; row < rowCount; row += 1) {
    sequence += '\r\x1B[1A\x1B[K'
  }

  output.write(sequence)
}

function patchSuffix(
  output: CliWritable,
  rowIndex: number,
  rowCount: number,
  column: number,
  suffix: string,
): void {
  const rowsUp = rowCount - rowIndex - 1
  const moveUp = rowsUp === 0
    ? ''
    : `\x1B[${rowsUp}A`
  const moveDown = rowsUp === 0
    ? ''
    : `\x1B[${rowsUp}B`
  const moveRight = column === 0
    ? ''
    : `\x1B[${column}C`

  // Every patch returns to column zero on the bottom row, making subsequent updates position-independent.
  output.write(`\r${moveUp}${moveRight}\x1B[K${suffix}\r${moveDown}`)
}

function sameLayout(
  previous: ReturnType<typeof formatModelBenchmarkProgressFrame>,
  next: ReturnType<typeof formatModelBenchmarkProgressFrame>,
): boolean {
  return previous.rows.length === next.rows.length
    && previous.rows.every((row, index) => row.prefix === next.rows[index]?.prefix)
}

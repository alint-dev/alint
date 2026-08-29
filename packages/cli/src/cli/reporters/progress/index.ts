import type { ProgressReporter } from '@alint-js/core'

import cliSpinners from 'cli-spinners'

import { createPlainProgressReporter } from './plain'
import { createSummaryProgressReporter } from './summary'
import { createTtyProgressRenderer } from './tty'

export interface CliProgressReporter {
  dispose: () => void
  reporter: ProgressReporter
  write: (chunk: string) => void
}

export interface CliProgressReporterOptions {
  color: boolean
  columns: number
  cwd: string
  isTty: boolean
  rows?: number
  write: (chunk: string) => void
}

export function createCliProgressReporter(options: CliProgressReporterOptions): CliProgressReporter {
  if (!options.isTty) {
    return {
      dispose: () => {},
      reporter: createPlainProgressReporter({ write: options.write }),
      write: options.write,
    }
  }

  const summary = createSummaryProgressReporter({
    color: options.color,
    columns: options.columns,
    cwd: options.cwd,
    rows: options.rows,
    spinnerFrames: cliSpinners.dots.frames,
  })
  const renderer = createTtyProgressRenderer<ReturnType<typeof globalThis.setInterval>>({
    clearInterval: handle => globalThis.clearInterval(handle),
    createInterval: (callback, intervalMs) => globalThis.setInterval(() => {
      summary.tick()
      callback()
    }, intervalMs),
    getRows: summary.getRows,
    intervalMs: 120,
    write: options.write,
  })
  const reporter = createRenderingProgressReporter(summary, renderer)

  return {
    dispose: renderer.finish,
    reporter,
    write: renderer.write,
  }
}

function createRenderingProgressReporter(
  summary: ProgressReporter,
  renderer: { start: () => void },
): ProgressReporter {
  /**
   * Resets the summary and starts its bounded TTY render interval.
   *
   * Triggering workflow:
   *
   * `runAlint`
   *   -> `ProgressReporter.onPrepareStart`
   *     -> `handlePrepareStart`
   *       -> `TtyProgressRenderer.start`
   *
   * Upstream:
   * - `runAlint` emits `onPrepareStart` before source discovery.
   *
   * Downstream:
   * - Delegates state reset to `summary.onPrepareStart` and starts the renderer interval.
   */
  const handlePrepareStart: NonNullable<ProgressReporter['onPrepareStart']> = (payload) => {
    summary.onPrepareStart?.(payload)
    renderer.start()
  }

  return {
    ...summary,
    onPrepareStart: handlePrepareStart,
  }
}

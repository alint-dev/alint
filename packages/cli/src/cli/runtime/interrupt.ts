export interface InterruptSignalBinding {
  dispose: () => void
  signal: AbortSignal
}

export interface InterruptSignalSource {
  off: (event: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown
  once: (event: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown
}

/** Binds one graceful process interrupt to an abort signal for the active CLI run. */
export function bindInterruptSignal(source: InterruptSignalSource): InterruptSignalBinding {
  const controller = new AbortController()

  /**
   * Aborts active CLI work when the process receives its first interrupt signal.
   *
   * Triggering workflow:
   *
   * {@link bindInterruptSignal}
   *   -> `InterruptSignalSource.once('SIGINT' | 'SIGTERM')`
   *     -> `handleInterrupt`
   *       -> `AbortController.abort()`
   *
   * Upstream:
   * - {@link bindInterruptSignal} registers this handler for `SIGINT` and `SIGTERM`.
   *
   * Downstream:
   * - Aborts {@link InterruptSignalBinding.signal}, which the lint command passes to `runAlint`.
   */
  const handleInterrupt = (): void => {
    controller.abort()
  }

  source.once('SIGINT', handleInterrupt)
  source.once('SIGTERM', handleInterrupt)

  return {
    dispose: () => {
      source.off('SIGINT', handleInterrupt)
      source.off('SIGTERM', handleInterrupt)
    },
    signal: controller.signal,
  }
}

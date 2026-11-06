/**
 * Parse a `--since` time into an inclusive lower-bound timestamp.
 *
 * Supported formats:
 * - `Nh`/`Nd`/`Nw`/`Nm`/`Ny` — now minus N hours/days/weeks/months/years.
 *   Weeks, months, and years are fixed approximations (7/30/365 days). `m` is
 *   months here, not minutes — a day is the finest window this tool tracks.
 * - `YYYY-MM`/`YYYY-MM-DD` — start of that UTC month/day.
 *
 * Edge cases:
 * - An empty time means "no lower bound".
 * - An unrecognized time throws.
 */
const HOUR_MS = 3_600_000
const UNIT_MS = {
  d: 24 * HOUR_MS,
  h: HOUR_MS,
  m: 30 * 24 * HOUR_MS,
  w: 7 * 24 * HOUR_MS,
  y: 365 * 24 * HOUR_MS,
}

export function parseSince(time: string | undefined, now: number): number | undefined {
  if (time === undefined || time === '') {
    return undefined
  }

  const relative = /^(\d+)([dhmwy])$/u.exec(time)

  if (relative) {
    return now - Number(relative[1]) * UNIT_MS[relative[2] as keyof typeof UNIT_MS]
  }

  const calendar = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/u.exec(time)

  if (calendar) {
    const year = Number(calendar[1])
    const month = Number(calendar[2])
    const day = calendar[3] === undefined
      ? 1
      : Number(calendar[3])

    return Date.UTC(year, month - 1, day)
  }

  throw new Error(`Invalid --since "${time}": use e.g. 24h, 7d, 2w, 3m, 1y, 2025-01, or 2025-01-15.`)
}

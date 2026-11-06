import { createHash } from 'node:crypto'

export interface StableHasher {
  digest: () => string
  update: (value: unknown) => StableHasher
}

export function createStableHasher(): StableHasher {
  const hash = createHash('sha256')
  const api: StableHasher = {
    digest: () => hash.digest('hex'),
    update: (value) => {
      const serialized = stableStringify(value)
      // Length framing keeps adjacent canonical values from sharing ambiguous sequence boundaries.
      hash.update(`${serialized.length}:`)
      hash.update(serialized)
      return api
    },
  }
  return api
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function stableHash(value: unknown): string {
  return hashText(stableStringify(value))
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(item => stableStringify(item)).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().flatMap((key) => {
      const property = record[key]
      return property === undefined
        ? []
        : [`${JSON.stringify(key)}:${stableStringify(property)}`]
    }).join(',')}}`
  }
  return JSON.stringify(value)
}

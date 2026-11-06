import { parseHeaderList } from '../../provider-registry'

export interface ProbeOptions {
  endpoint?: string
  providerHeader?: string | string[]
}

export function providerHeadersFromOptions(options: ProbeOptions): Record<string, string> {
  return parseHeaderList(toArray(options.providerHeader)) ?? {}
}

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return []
  }

  return (Array.isArray(value)
    ? value
    : [value]).filter(
    (item): item is string => typeof item === 'string',
  )
}

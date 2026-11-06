import { glob } from 'tinyglobby'

const maxListedFiles = 160

export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  '**/.git/**',
  '**/build/**',
  '**/dist/**',
  '**/node_modules/**',
  '**/vendor/**',
]

export interface ListFilesOptions {
  ignore?: readonly string[] | string
  patterns?: readonly string[] | string
}

export async function listFiles(root: string, options: ListFilesOptions = {}): Promise<string[]> {
  try {
    return (await glob(options.patterns ?? '**/*', {
      absolute: true,
      cwd: root,
      ignore: toStringArray(options.ignore),
      onlyFiles: true,
    })).slice(0, maxListedFiles)
  }
  catch {
    return []
  }
}

export function toStringArray(value: readonly string[] | string | undefined): string[] {
  if (Array.isArray(value)) {
    return [...value]
  }

  return typeof value === 'string'
    ? [value]
    : []
}

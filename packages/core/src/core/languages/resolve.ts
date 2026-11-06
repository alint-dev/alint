import type { LanguageDefinition } from '../../dsl/types'
import type { SourceFile } from '../source/types'
import type { LanguageRegistry } from './registry'

import { extname } from 'node:path'

export interface ResolveLanguageOptions {
  language?: string
  processedLanguage?: string
}

export function resolveLanguage(
  file: SourceFile,
  registry: LanguageRegistry,
  options: ResolveLanguageOptions,
): LanguageDefinition {
  return resolveLanguageForPath(file.path, registry, options)
}

export function resolveLanguageForPath(
  filePath: string,
  registry: LanguageRegistry,
  options: ResolveLanguageOptions,
): LanguageDefinition {
  const languageName = options.language
    ?? options.processedLanguage
    ?? registry.byExtension.get(extname(filePath))
    ?? 'plaintext'
  const language = registry.languages.get(languageName)

  if (!language) {
    const registered = [
      ...registry.languages.keys(),
    ].sort().join(', ')

    throw new Error(
      `Unknown language "${languageName}". Languages come from plugins, and these are registered: ${registered}.`,
    )
  }

  return language
}

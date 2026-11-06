import type { LanguageDefinition } from '../../dsl/types'

export const textLanguage: LanguageDefinition = {
  extensions: [],
  extract: file => [
    {
      file,
      identity: 'file',
      kind: 'file',
      language: 'plaintext',
      origin: { physicalPath: file.path },
      text: file.text,
    },
  ],
  name: 'plaintext',
}

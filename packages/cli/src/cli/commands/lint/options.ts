export interface LintCommandOptions {
  cache?: boolean
  cacheLocation?: string
  cacheOnly?: boolean
  config?: string
  dirty?: boolean
  format: string
  lang?: string
  model?: string
  outputLanguage?: string
  progress?: boolean
  rule?: string | string[]
  ruleConcurrency?: string
  stats?: boolean
  timeoutMs?: string
}

# `@alint-js/core`

The public SDK and run engine for `alint`.

## What it does

This package provides the core SDK and run engine APIs used by plugins, rules, language processors, embedding tools, and agent adapters:

- `definePlugin` and `defineRule`
- `runAlint`
- rule registry and flat config normalization
- source runtime helpers
- built-in JavaScript source extraction, with additional language support for others
- model resolution by size and capability
- diagnostics and progress payload types
- framework-neutral agent contracts under `@alint-js/core/agent`
- tool-call structured output under `@alint-js/core/structured-output`
- config DSL and types for advanced SDK consumers

## How to use

Write a rule:

```ts
import { defineRule } from '@alint-js/core'

export const rule = defineRule({
  create: ctx => ({
    async onTargetFile(target) {
      const model = await ctx.model({ size: 'small' })
      const file = await ctx.src.readFile(target.file)

      ctx.report({
        filePath: target.file.path,
        loc: target.loc,
        message: `reviewed ${file.lines.length} lines with ${model.id}`,
      })
    },
  }),
})
```

Source and project rules receive compact descriptors. Source handlers should pass `target.file`
to `ctx.src.readFile()` so core can detect changes since planning. Read source only when needed:

```ts
import { defineRule } from '@alint-js/core'

export const projectRule = defineRule({
  create: ctx => ({
    async onTargetProject(project) {
      for (const entry of project.files) {
        const file = await ctx.src.readFile(entry.path)
        if (file.text.includes('deprecated-api'))
          ctx.report({ filePath: entry.path, message: 'deprecated API used' })
      }
    },
  }),
})
```

`PlannedSourceTarget`, `ProjectFileEntry`, and `ProjectTargetEntry` intentionally omit source text.
Calls to `ctx.src.readFile()` are explicit and plugin-owned, so a rule controls which source files
it loads and how long it retains them. Cache hits do not invoke the handler and therefore do not
perform its execution-time read.

Use the agent contract for tool-using rules:

```ts
import { requireAgent } from '@alint-js/core/agent'

const agent = requireAgent(ctx)
```

Ask a model for one validated, typed result with `@alint-js/core/structured-output`. It forces
the model to call a single reporting tool whose arguments match a valibot schema, validates
them, and retries with the validation error fed back to the model:

```ts
import { generateStructured } from '@alint-js/core/structured-output'
import { array, description, object, pipe } from 'valibot'

const responseSchema = pipe(
  object({
    findings: array(findingSchema)
  }),
  description('Report findings for this file.'),
)

const { findings } = await generateStructured({
  createMessages: retryFeedback => [
    { content: prompt, role: 'system' },
    ...(retryFeedback
      ? [
          { content: retryFeedback, role: 'user' as const }
        ]
      : []),
    { content: numberedSource, role: 'user' },
  ],
  logger: ctx.logger,
  metering: ctx.metering,
  model: await ctx.model(),
  operation: 'my-rule-judge',
  schema: responseSchema,
})
```

The reporting tool is named `reportFindings` by default (`toolName` overrides it) and its
description defaults to the schema's valibot `description(...)`. `toolParametersFromSchema`,
`formatSourceWithLineNumbers`, and `formatOutputLanguageInstruction` are exported for callers
that build their own tools or prompts. Use `ctx.agent` instead when the model needs to
explore with tools before answering, because a forced tool call is a single shot, not a loop.

### Languages

Core parses JavaScript and TypeScript. Everything else is registered by a plugin, so a rule says
which languages it can read and core decides what to hand it:

```ts
defineRule({
  create: () => ({
    onTargetFunction: (target) => { /* ... */ }
  }),
  languages: 'any',
})
```

| `languages` | the rule receives | a named language nothing registered |
| --- | --- | --- |
| omitted | file targets only, never functions or classes | not applicable |
| `'any'` | every language except `plaintext` | never fails |
| `['go', 'rust']` | those languages only | run fails, `alint/missing-language` |
| `{ ids: ['go'], skipMissing: true }` | those languages only | skipped quietly |

`'any'` excludes `plaintext` on purpose. Plain text is what a file falls back to when no language
claims its extension, so a rule that asked for a language would otherwise be handed unparsed text.
When that happens the run reports `alint/unregistered-language` once per extension — a warning by
default, configurable through `linterOptions.reportUnregisteredLanguages`.

Declaring a list is the stricter choice. It fails the run when the user has not installed a pack
that provides one of them, rather than letting the rule match nothing and look like a pass.

A plugin registers a language by describing how to turn a file into targets:

```ts
definePlugin({
  languages: {
    zig: {
      extensions: ['.zig'],
      extract: file => [/* SourceTarget[] */],
      name: 'zig',
    },
  },
})
```

Ids are the identifiers editors use — `go`, `python`, `typescript`, `plaintext`. Registering fails
on a duplicate name or extension, so two plugins can never claim the same language.

Put a `FunctionInfo` under `metadata.function` on each function target, and the file's call sites
under `metadata.calls` on the file target. Those two keys are what let a rule read any language
without a parser of its own.

`@alint-js/languages` provides Go, Python and Rust this way.

To parse a file the run was not asked to lint, such as when building a workspace-wide index, use
`ctx.src.extract(path)`. It resolves that file's own config and language, and returns nothing for a
file the config ignores rather than throwing.

## When to use

- You are writing an `alint` plugin or rule package.
- You are adding a language processor or source extractor.
- You are embedding `alint` in another tool.
- You are implementing an `AgentAdapter`.
- You need project-wide analysis that can consume compact descriptors and load source lazily.

## When not to use

- Use `@alint-js/cli` for command-line usage and ordinary `alint.config.*` files.
- Use `@alint-js/config` for setup TOML, config loading, and config-file tooling only.
- A plugin that needs a persistent repository database should build and inject that database.
  Do not retain every `SourceFile` returned by `ctx.src.readFile()` as a substitute for one.

## Memory boundaries

`alint` bounds concurrent source planning reads and parser work. Planning releases rich extractor
values as soon as compact jobs are admitted; queued jobs do not retain source text. It cannot bound
source files retained by plugin code after `ctx.src.readFile()` returns.

A valid cache written by the same `alint` version is still read from one monolithic JSON document.
An extremely large cache may therefore exhaust available memory.

After each cacheable rule job completes, `alint` writes a cache checkpoint before releasing its
scheduler slot. Each checkpoint atomically replaces the monolithic cache file. An interrupted run
can therefore reuse every result that had already become durable, but large caches can cause
substantial disk writes during runs with many cache misses. Cache hits, skipped jobs, failed jobs,
and rules that opt out of caching do not add checkpoint writes. A checkpoint or final cache write
error is fatal and causes the run to fail.

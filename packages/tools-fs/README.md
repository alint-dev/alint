# `@alint-js/tools-fs`

Shared filesystem `AgentTool`s for alint plugins whose rules let an agent explore a project.
`createTools(cwd, options?)` returns four tools, all reporting paths relative to `cwd`:

- `read_file` — read a UTF-8 file (path relative to `cwd` or absolute).
- `list_files` — list files, with optional glob `patterns`, `ignore`, and `directory`.
- `search_files` — match file paths by substring.
- `search_in_files` — match file contents, returning `path:line: snippet` lines.

## Usage

```ts
import { createTools, DEFAULT_IGNORE_PATTERNS } from '@alint-js/tools-fs'

// Built-in ignores:
const tools = createTools(ctx.cwd)
// Extend the builtins:
const py = createTools(ctx.cwd, {
  ignore: [...DEFAULT_IGNORE_PATTERNS, '**/.venv/**']
})
// Replace the builtins:
const bare = createTools(ctx.cwd, {
  ignore: ['**/generated/**']
})
```

`options.ignore` **replaces** the builtins (`git/build/dist/node_modules/vendor`); spread
`DEFAULT_IGNORE_PATTERNS` to extend them instead. Per-call ignores from the agent always append to the ignore list set at tool creation time.
The underlying `listFiles` / `readFile` / `searchFiles` / `searchInFiles` are exported too.

## When to use

- **Use** when a `ctx.agent` rule needs generic read/list/search tools to explore a project.

## When not to use

- **Don't** for a single structured model judgement without an agent loop, or when you need real code search (regex/AST/ranking).

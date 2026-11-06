# `@alint-js/languages`

> [!IMPORTANT]
> This package is a WIP. APIs may be subject to major changes.

First-party language support for alint, beyond the JavaScript and TypeScript that core has built in.
Adds Go, Python and Rust.

## What it does

A plugin that declares languages and nothing else — no rules, no processors. Registering it means
every rule in the run, from every plugin, starts receiving function targets for `.go`, `.py` and
`.rs` files. A rule needs no parser of its own and no dependency on this package.

Each function target carries a `FunctionInfo` under `metadata.function`: which statements the body
holds, whether it is a single expression, where its comments are, which names it declares, which
identifiers may be renamed, and whether it is reachable from outside its file. The file target
carries every call site under `metadata.calls`, including calls made outside any function.

`FunctionInfo` is core's contract, and core's own JavaScript producer fills in the same fields, so
a rule reads one shape whatever parsed the file.

## How to use

```bash
npm install -D @alint-js/languages
```

```ts
import languages from '@alint-js/languages'

import { defineConfig } from '@alint-js/cli'

export default defineConfig([
  {
    files: ['**/*.{go,py,rs}'],
    plugins: { languages },
  },
])
```

The alias is arbitrary: languages register under their own names, not the plugin's.

A rule opts in to what it can read by declaring `languages`:

```ts
defineRule({
  create: () => ({
    onTargetFunction: (target) => { /* ... */ }
  }),
  languages: 'any', // or ['go', 'rust'] to scope, which fails the run if nothing provides them
})
```

From a static (TOML) config, point a directory specifier at your own installed copy:

```toml
plugin_languages = "./node_modules/@alint-js/languages"
```

The directory lock records physical identity, so upgrading the package re-locks it. Re-run
`alint plugin install` when it says the target changed.

## Add a language

This package reads the prebuilt grammars in `tree-sitter-wasms`. That dependency supplies 36
grammars, and this package uses three of them (by the time this is written). A new language needs a query, not a grammar. The
query maps the node names of the grammar to the six captures that `extract.ts` reads.

To add a language, do these steps:

1. Add the file name of the grammar to `GRAMMAR` in `src/grammar.ts`.
2. Add the query to `QUERIES` in `src/queries.ts`.
3. Add a case to `isExported` in `src/extract.ts`.
4. Add a `LanguageDefinition` to `src/index.ts`.
5. Add the new language to `languagesPlugin` in the same file.
6. Add a test for the new language to `src/extract.test.ts`.

Note: `LanguageId` comes from the keys of `GRAMMAR`. After step 1, the code does not compile until
you complete step 2 and step 3. The compiler gives no error for step 4, step 5, or step 6.

To find the node names of a grammar, read the `grammar.js` file of that tree-sitter parser.

CAUTION: Make sure that the grammar uses these three node names. If the grammar uses other names,
the code still compiles and `FunctionInfo` is wrong:

- `block` is the node type of a branch or a loop (`holdsBlock` in `src/extract.ts`).
- `body` is the field name for the body of a function (`bodyStatements`).
- `name` is the field name for the name of a function (`withOwnName`).

Go, Python, and Rust use these three names. Other grammars use other names. For example, TypeScript
calls the block `statement_block`.

## When to use

- Your project has Go, Python or Rust files and you want rules to see functions in them rather than
  raw text.
- You are writing a rule that works from `FunctionInfo` and want it to cover more than JavaScript
  without importing a parser.

## When not to use

- You only lint JavaScript and TypeScript. Core's built-in oxc producer already covers those, and
  this package would add roughly 6 MB of grammars for nothing.
- You want to distribute it through the plugin store. The store installs one tarball and no
  dependencies, and the grammars are resolved from `node_modules` at runtime. Install it with your
  package manager instead — the same way agent adapters are installed.

## Notes

- Parsing is done with [tree-sitter](https://tree-sitter.github.io/tree-sitter/), which is an
  implementation detail: nothing in the public surface names it, and a language could move to a
  different parser without the config changing.
- Pinned to `web-tree-sitter` 0.24.x. 0.25 rewrote the WASM loader and rejects the prebuilt
  `tree-sitter-wasms` grammars, which still carry the legacy `dylink` section.
- Extensions core already owns (`.js`, `.jsx`, `.ts`, `.tsx`, and the rest) are deliberately not
  claimed here. Two plugins claiming one extension is an error, not a fallback.

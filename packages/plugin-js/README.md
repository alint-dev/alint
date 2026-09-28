# @alint-js/plugin-js

Model-backed JavaScript and TypeScript review rules for `alint`.

The package default export is the plugin definition. Individual rule definitions are also available as named exports.

## Rules

The bundled `recommended` config enables these rules under the `js` plugin name:

- `js/inline-miniature-normalizer` reports clusters of local helpers that form a private reader or narrowing toolkit.
- `js/no-config-file-tests` reports standalone tests that restate repository configuration instead of verifying behavior. It skips non-test files before calling the model, but the `files:` glob must include tests and ignored files remain excluded.
- `js/no-mixed-layers-without-abstraction` reports consuming features that own independently reusable external-integration responsibilities without a stable interface.
- `js/no-private-schema-toolkit` reports clusters of local helpers that form an ad hoc schema or payload-normalization toolkit.
- `js/no-redundant-binding` reports local bindings that only rename an unchanged value or reference without adding a useful boundary.
- `js/no-redundant-jsdoc` reports JSDoc that mostly restates the documented declaration, signature, or implementation.
- `js/no-trivial-wrapper-stack` reports chains of shallow wrappers that add no meaningful policy or runtime boundary.
- `js/no-vacuous-function` reports functions whose shallow implementation does not earn a separate runtime boundary.

`js/no-vacuous-function` remains a local, cacheable model review. Repository-wide test usage is handled by a separate opt-in rule so enabling an agent does not change the recommended rule's behavior or cacheability.

Five repository-aware rules are registered but intentionally not enabled by `recommended`:

- `js/no-duplicated-knowledge` finds policy or mechanism knowledge duplicated across files when both locations encode one decision that must change together. A small, whole-helper clone is usually a better fit for `simplicity/no-duplicated-helper`.
- `js/no-redundant-catch` finds an outer error-normalization catch that is made redundant by a callee's proven domain-error postcondition.
- `js/no-single-use-materialization` finds a collection produced once and consumed once immediately when the producer and consumer can be fused safely. It is broader than the local `js/no-redundant-binding` check for unchanged aliases.
- `js/no-test-only-production-wrapper` finds a shallow wrapper declared in production but referenced only by tests and unreachable through package exports.
- `js/no-overlapping-entrypoints` finds competing package public entrypoints that expose materially the same symbol surface and have unclear canonical ownership. It is not a replacement for `js/no-trivial-wrapper-stack`, which reviews shallow local call chains.

## Repository-aware review requirements

The five opt-in rules require both a configured model and an agent adapter capable of tool calls. They reuse the standard `@alint-js/tools-fs` list, search, and read tools, and ask the agent to include repository evidence with each finding.

`js/no-config-file-tests` is not repository-aware and needs no agent adapter: it judges the test file it is handed, so a configured model is enough.

## How to use

Use the default export with the `js` plugin name because the bundled preset refers to `js/*` rule IDs.

### Recommended preset

```ts
import jsPlugin from '@alint-js/plugin-js'

import { defineConfig } from '@alint-js/cli'

export default defineConfig([
  {
    extends: ['js/recommended'],
    files: ['**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}'],
    plugins: {
      js: jsPlugin,
    },
  },
])
```

### Opt in to repository-aware rules

Configure an agent and tool-call-capable model in your `alint` runtime, then enable the repository-aware rules explicitly:

```ts
import jsPlugin from '@alint-js/plugin-js'

import { defineConfig } from '@alint-js/cli'

export default defineConfig([
  {
    files: ['**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}'],
    plugins: {
      js: jsPlugin,
    },
    rules: {
      'js/no-duplicated-knowledge': 'warn',
      'js/no-overlapping-entrypoints': 'warn',
      'js/no-redundant-catch': 'warn',
      'js/no-single-use-materialization': 'warn',
      'js/no-test-only-production-wrapper': 'warn',
    },
  },
])
```

## When to use

- Use the recommended preset for model-assisted JavaScript and TypeScript design review.
- Opt in to repository-aware rules when cross-file ownership, package surfaces, or control/data-flow contracts need investigation.
- Use the named rule exports when composing another plugin definition programmatically.

## When not to use

- Do not use model-backed rules as a deterministic replacement for syntax-aware lint.
- Do not enable repository-aware rules with a generation-only model or without an agent adapter.
- Do not use `js/no-config-file-tests` when the configuration module owns logic the repository must verify, such as a custom lint rule, a custom bundler plugin, or a merge or normalization helper. Move that logic into its own module and test the module instead.
- Do not use `js/no-duplicated-knowledge` for coincidental literals or clones that do not encode one shared decision.
- Do not use `js/no-overlapping-entrypoints` for documented compatibility aliases or conditional/type-only exports.
- Do not use `js/no-redundant-catch` when the outer catch changes cleanup, observability, error metadata, cause, identity, or cancellation behavior.
- Do not use `js/no-single-use-materialization` when fusion would change validation ordering, evaluation, identity, side effects, concurrency, or another observable behavior.

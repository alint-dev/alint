<picture>
  <source
    width="200"
    srcset="./docs/assets/alint-logo.svg"
    media="(prefers-color-scheme: dark)"
  />
  <source
    width="200"
    srcset="./docs/assets/alint-logo.svg"
    media="(prefers-color-scheme: light), (prefers-color-scheme: no-preference)"
  />
  <img width="200" src="./docs/assets/alint-logo.svg" alt="Alint Logo" />
</picture>

# `alint`

[![npm version][npmx-version-src]][npmx-version-href]
[![npm downloads][npmx-downloads-src]][npmx-downloads-href]
[![bundle][bundle-src]][bundle-href]
[![License][license-src]][license-href]
[![JSDocs][jsdocs-src]][jsdocs-href]

![Demo](./docs/assets/demo.gif)

`alint` is an [`eslint`](https://eslint.org/) inspired agentic code analysis tool for vibe-coded code that needs another look. It runs model-backed rules against source files, reports diagnostics in a familiar lint format, and lets rule authors use plain model calls or swappable tool-using agents when a rule needs deeper context.

While `alint` is inspired by `eslint`, we expect the concept that `alint` brings to the table to be a new paradigm for code analysis. It should not be limited to just JavaScript/TypeScript. You can extend this to other languages, non-code artifacts, generated files, or any content a plugin knows how to review.

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
## Table of Contents

- [Installation and Usage](#installation-and-usage)
- [Concepts](#concepts)
- [Packages](#packages)
- [Documentation Automation](#documentation-automation)
- [Development](#development)
- [Status](#status)
- [License](#license)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Installation and Usage

### Prerequisites

`alint` is written in TypeScript and published as ESM packages for JavaScript and TypeScript projects. Release builds also include standalone binaries, so teams working in Python, Go, Rust, and other non-Node.js projects can run the CLI without setting up Node.js, npm, or pnpm.

You also need at least one OpenAI-compatible model provider. Local providers such as Ollama and LM Studio work well for repeated lint runs because they keep token cost predictable.

### Install the CLI

Download a standalone binary from the GitHub release assets if you want to use `alint` without a Node.js toolchain.

Install globally if you want an `alint` command available everywhere:

```bash
npm install -g @alint-js/cli
pnpm add -g @alint-js/cli
```

Or install it in a project and run it through your package manager:

```bash
npm install -D @alint-js/cli
npx alint src
```

```bash
pnpm add -D @alint-js/cli
pnpm exec alint src
```

### Configure a Model Provider

Use `alint setup` to write provider configuration. The `-N` flag is short for `--no-interactive`, so setup can run in scripts or through coding agents without opening an interactive TUI.

Without `--local`, setup writes the global config at `~/.config/alint/config.toml`. With `--local`, it writes `.alint/config.toml` in the current project.

Provider management commands use the same scope policy: writes target the global config by default, and `--local` selects the current project's config. Update an existing provider or edit individual fields with:

```bash
alint config providers update --provider openrouter
alint config providers set --provider openrouter endpoint https://openrouter.ai/api/v1
alint config providers set --provider openrouter headers.Authorization "Bearer $TOKEN"
alint config providers unset --provider openrouter headers.Authorization
```

`providers update` probes the provider and adds newly reported models. It is additive by default and does not automatically remove a configured model merely because the remote provider no longer reports it. In the interactive TUI, deselecting a configured model removes it when you confirm the update. Use the destructive `models prune` command when you intend to remove configured models absent from provider responses.

Provider inspection, command output, and failure reports show header names only; they never print header values. Header values supplied as command arguments may remain in shell history. Use an environment variable such as `$TOKEN`, not a literal credential.

<details>
<summary>Ollama</summary>

```bash
alint setup -N \
  --provider-endpoint http://localhost:11434/v1 \
  --provider-model qwen:8b
```

</details>

Write provider setup into the current project when a repository should carry its own model mapping:

```bash
alint setup -N \
  --local \
  --provider-endpoint http://localhost:11434/v1 \
  --provider-model qwen:8b
```

<details>
<summary>LM Studio</summary>

```bash
alint setup -N \
  --provider-endpoint http://localhost:1234/v1 \
  --provider-model qwen:8b
```

</details>

<details>
<summary>OpenRouter</summary>

```bash
export OPENROUTER_API_KEY="sk-..."

alint setup -N \
  --provider-endpoint https://openrouter.ai/api/v1 \
  --provider-header "Authorization=Bearer $OPENROUTER_API_KEY" \
  --provider-header "HTTP-Referer=http://localhost" \
  --provider-header "X-OpenRouter-Title=alint" \
  --provider-model openrouter:fusion
```

</details>

<details>
<summary>OpenAI</summary>

```bash
export OPENAI_API_KEY="sk-..."

alint setup -N \
  --provider-endpoint https://api.openai.com/v1 \
  --provider-header "Authorization=Bearer $OPENAI_API_KEY" \
  --provider-model gpt-5.4-mini
```

</details>

### Run alint

Run the CLI against files or directories:

```bash
alint src
alint demo.ts
alint --format json demo.ts
```

#### --dirty

Use `--dirty` without file arguments to lint only existing files that differ from `HEAD`:

```bash
alint --dirty
```

This includes staged, unstaged, and untracked files from the Git repository root. Ignored and deleted files are excluded. Registered submodule worktrees are excluded. A clean repository exits successfully without producing lint output.

#### --model

Override the matched model for a one-off run:

```bash
alint --model qwen:8b demo.ts
```

#### --lang

When the project-local setup does not configure any models, model calls without a rule-level or call-level selector use the `default` alias from the global setup. Rule selectors continue to use normal model matching. Configuring at least one model in `.alint/config.toml` restores project-first matching for unselected calls. An explicit `--model` override always takes precedence.

Ask model-backed rules to write diagnostics in a specific language:

```bash
alint --lang zh-CN src
```

#### --rule

Run only the rules a filter names, to read one rule's findings without paying for every other rule in the run:

```bash
alint --rule docs/review-copy src
alint --rule 'docs/*' src
alint --rule docs/review-copy,docs/naming src
```

A pattern matches the configured rule id (`plugin/rule`) or the rule's own name. The flag is repeatable and accepts a comma-separated list. Filtered rules are left unplanned, so the run neither calls their models nor reports their diagnostics. When the filter matches no enabled rule, the run fails and lists the rule ids it did enable, because a silent empty run is indistinguishable from a clean one.

`alint` returns exit code `0` when diagnostics contain no errors, including warning-only runs. It returns `1` when at least one error diagnostic is reported and `2` when the command cannot complete because of a configuration, input, or runtime failure. `alint output inspect` uses the same exit-code behavior for saved results.

### Inspect Configuration and Output

Useful CLI commands:

```bash
alint config inspect src/index.ts
alint config providers list
alint config providers show openrouter
alint config models list
alint config models show ollama/qwen
alint config models probe --endpoint http://localhost:11434/v1
alint config models rm qwen --provider ollama
alint config models prune --provider ollama -N --yes
```

When a model ID exists under multiple providers, qualify it as `<provider>/<model-id>` or pass `--provider <provider-id>`. Configuration mutations write globally unless `--local` selects the current project's setup config.

`models rm` removes one exact configured model. `models prune` probes provider model endpoints and destructively removes configured IDs that are no longer reported. Interactive prune asks for confirmation; scripts must pass `-N --yes`.

Save machine-readable output and inspect it later without rerunning model calls:

```bash
alint --format json src > alint-output.json
alint output inspect alint-output.json
```

### Editor Integration

`alint lsp` runs alint as a language server on stdin and stdout. Any editor with LSP support can
use it.

The server is cache-first. It publishes diagnostics that earlier runs stored, and it never calls a
model on its own, so opening a workspace costs nothing. A cold cache shows no diagnostics. Run
`alint` once to fill it.

Diagnostics appear when the editor opens the workspace. They refresh when you save a file, and when
a file changes on disk outside the editor, for example after `git checkout`. The server reloads
`alint.config.ts` after it changes. Changes on disk and config reloads need an editor that supports
dynamic registration for `workspace/didChangeWatchedFiles`. The server opens and closes workspace
folders as the editor adds and removes them.

Configure the editor to start the command. In Neovim:

```lua
vim.lsp.config.alint = {
  cmd = { 'alint', 'lsp' },
  root_markers = { 'alint.config.ts' },
}
```

The server declares three commands. `alint.runFile` and `alint.runWorkspace` start runs that call
models and spend tokens; both report progress and accept cancellation. `alint.clearCache` deletes
the cached diagnostics.

#### VS Code

The extension in `apps/vscode` starts the server and displays the diagnostics. It is not published
to the Marketplace yet. To run it from a checkout:

```bash
pnpm -F @alint-js/vscode build
code --extensionDevelopmentPath=apps/vscode/dist /path/to/your/project
```

The extension finds the alint executable in this order: the `alint.path` setting, then
`node_modules/.bin/alint` in the workspace folder, then `PATH`. The workspace installation takes
precedence, so the server and a terminal run use the same cache.

### Codex stop-gate plugin (optional)

#### Install
The Codex plugin adds a Stop hook that runs `alint --dirty` before the agent ends a turn.

Run these commands to install the plugin from the repository's default branch. These commands do not select the latest release:

```bash
codex plugin marketplace add moeru-ai/alint \
  --sparse .agents/plugins \
  --sparse plugins/codex-plugin-alint
codex plugin add alint@alint
```

To install from a release, use its Git tag:

```bash
codex plugin marketplace add moeru-ai/alint \
  --ref vX.Y.Z \
  --sparse .agents/plugins \
  --sparse plugins/codex-plugin-alint
codex plugin add alint@alint
```

Replace `vX.Y.Z` with the required release tag. Review and trust the Stop hook when Codex asks. The plugin stays inactive until a repository enables Stop Gate.

#### Configure

The codex plugin explicitly requires per-repo enable. Use this command to enable for current repository:

- .toml: run `alint config integrations stop-gate enable`
- .js/.ts:
```typescript
export default defineConfig([
  // ...
  {
    integrations: {
      stopGate: {
        enabled: true,
        // target: 'dirty-files' | 'all'
        // timeoutMs: 900000
      },
    },
  },
  // ...
])
```

## Concepts

`alint` keeps the familiar lint shape: select targets, apply named rules, report diagnostics, and return an exit code that CI can understand. The difference is that a rule can reach its judgment through model calls or a tool-using agent when syntax-only checks are not enough.

### `alint` User side

#### Configurations

`alint` uses two configuration systems with separate schemas and responsibilities:

| Configuration | Priority (high → low)                                                                | Content                                                              |
| --- |--------------------------------------------------------------------------------------|----------------------------------------------------------------------|
| Setup | Environment and CLI overrides > `.alint/config.toml` > `~/.config/alint/config.toml` | Providers, models, and runner defaults.                              |
| Lint | Environment and CLI overrides > `alint.config.*`                                     | Files, ignores, plugins, rules, and other project-level lint policy. |

Use setup TOML for machine or project provider definitions:

```toml
version = 1

[[providers]]
id = "http://localhost:11434/v1"
type = "openai-compatible"
endpoint = "http://localhost:11434/v1"

[[providers.models]]
id = "qwen:8b"
name = "qwen:8b"
size = "small"
capabilities = [ "tool-call" ]

[providers.models.default_params]
thinking = { type = "disabled" }
```

`default_params` is merged into every chat request for that model. Use it for provider-specific request fields that are not covered by the rest of the model entry.

The CLI can also launch an ACP coding-agent command and expose it to rules as an ordinary model. Interactive `alint setup` provides presets for Claude Code, Codex, Gemini CLI, Kimi Code CLI, and OpenCode:

```toml
version = 1

[[providers]]
id = "acp"

[[providers.models]]
id = "codex"
name = "Codex ACP"
driver = "acp"
aliases = [ "default" ]
capabilities = [ "tool-call" ]
command = "codex-acp"
args = []
cwd = "."
```

Then run `alint --model acp/codex src`. The checked-in `alint.config.ts` remains lint policy; process commands come only from global setup or `.alint/config.toml`. The command inherits the environment that launched `alint`; optional model `env` entries are literal overrides and should not contain committed credentials. Each concurrent request starts one ACP process, and request tools require MCP-over-HTTP support from the agent.

`alint` structured output forces a tool call (`tool_choice`). Some models, such as DeepSeek V4, reject that combination while thinking/reasoning is enabled. For those models, set `thinking = { type = "disabled" }` as above so structured output can run.

Note that `-N` stands for `--no-interactive`, which means this is not an interactive setup. TUI is not required, so you can ask Codex or Claude Code to run this command for you.

You can also use `--local` to write the config in the current project:

```bash
alint setup -N \
  --local \
  --provider-endpoint http://localhost:11434/v1 \
  --provider-model qwen:8b
```

- Without `--local`, `alint` writes the global config under `~/.config/alint/config.toml`.
- `--local` writes `.alint/config.toml` in the current project.
- You can inspect configs using the `alint config` command group.

##### Codex Stop Gate

Configure the optional Codex Stop Gate integration through the same project config system:

```bash
alint config integrations stop-gate enable
alint config integrations stop-gate show
alint config integrations stop-gate set --target all --timeout-ms 1800000
alint config integrations stop-gate disable
```

Stop Gate is disabled by default and runs only when the repository explicitly sets `integrations.stopGate.enabled = true`. The defaults after activation are `target = "dirty-files"` and `timeoutMs = 900000`; the maximum timeout is `86100000` (23 hours 55 minutes), leaving five minutes inside the plugin's 24-hour Codex hook limit for startup and persistence. The writer persists only non-default overrides and only extends the existing TOML write path; it does not extend the config writer to other formats. Read the [`plugins/codex-plugin-alint`](https://github.com/moeru-ai/alint/tree/main/plugins/codex-plugin-alint) documentation for complete runtime behavior.

#### Using Rules & Plugins

Similar to `eslint`, use `alint.config.ts` for files, ignores, plugins, and rules:

```ts
import { defineConfig } from '@alint-js/cli'
import { examplePlugin } from '@alint-js/plugin-example'

export default defineConfig([
  {
    files: ['**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}'],
    ignore: {
      // Reads applicable nested .gitignore files when selecting lint targets.
      // This is powered by gitignore-fs.
      gitignore: true,
    },
    plugins: {
      example: examplePlugin,
    },
    rules: {
      // The `example` prefix is the local alias configured above.
      'example/inline-miniature-normalizer': 'warn',
      'example/no-redundant-jsdoc': 'warn',
      'example/no-trivial-wrapper-stack': 'warn',
    },
  },
])
```

#### Nested configs

Every `alint.config.*` below the repository root is loaded together with the root config, and each file is scoped to the directory that contains it:

```ts
// packages/app/alint.config.ts
import { defineConfig } from '@alint-js/cli'

import { appPlugin } from './alint/plugin'

export default defineConfig([
  {
    plugins: { app: appPlugin },
    rules: { 'app/layer-boundary': 'error' },
  },
])
```

The item above reaches `packages/app/**` only. `files`, `directories`, and `ignores` resolve against the directory of the config that declares them, an item that declares no target patterns covers its whole subtree, and a deeper config overrides an outer one for its own directory. A package that owns a rule therefore needs one file, not an entry in the root config plus the same scope repeated in every tool that reads it.

- Discovery skips hidden directories, `node_modules`, and build output (`build`, `coverage`, `dist`, `out`, `vendor`).
- `--config <path>` pins exactly one config file and disables discovery, so a CI job can run one specific config.
- Every config file shares one plugin alias namespace and one plugin lockfile, and `alint plugin install` installs the plugins nested configs declare. Two files that bind one alias to different specifiers fail the load instead of resolving silently to one of them.
- Keep project-scoped rules (`onTargetProject`) in the root config: the project target sits outside a nested item's base path, so a nested config cannot claim it.

#### Executable and static configs

`alint` supports executable configs (`.js`, `.ts`, `.mjs`, `.cjs`, `.mts`, and `.cts`) and data-only static configs (`.toml`, `.yaml`, `.yml`, `.json`, `.jsonc`, and `.json5`).

- Executable configs export a flat config array and can import plugin definitions directly.
- Static configs use a `config.group` array and identify plugin sources with strings. They are useful for Python, Rust, Go, and other repositories that do not want to author a JavaScript config file or install a Node.js package manager just to run `alint`.

For example, a TOML static config can install an exact remote package or a local plugin directory:

```toml
[[config.group]]

[config.group.plugins]
plugin_1 = "@scope/alint-plugin-example1@1.2.3" # package
plugin_2 = "./plugins/relative-plugin-examplex" # relative directory
plugin_3 = "/opt/alint/plugins/absolute-plugin" # absolute directory
```

Relative plugin paths are resolved from the directory containing the config file, including when `--config` points to a nested config. On Windows, use TOML literal strings to preserve native backslashes:

```toml
[[config.group]]

[config.group.plugins]
native = 'C:\alint\plugins\native-plugin'
```

Use `alint plugin install` after adding or changing plugin sources.

- **Package:** `@scope/alint-plugin-example1@1.2.3` downloads that exact version into `.alint/plugins/store`, verifies its integrity, and loads its root export.
- **Local:** `./plugins/my-plugin` or an absolute directory loads the current package root export in place. `alint` checks that the package and entry exist and that the entry stays inside the package directory. It does not build the plugin or install the plugin's dependencies.

#### Declarative local rule plugins

For simple prompt-backed rules, a local plugin directory can omit `package.json` and contain one or more `rule.alint.*` files:

```toml
# rules/architecture/semantic/rule.alint.toml
name = "semantic-boundary"
builtInAgent = "basic-structured"
instruction = """
Find semantic boundary problems in the reviewed source.
Report concrete findings with line numbers and short suggestions.
"""
includeFiles = [ "src/**/*.py" ]
excludeFiles = [
  "**/*_test.py",
  "**/vendor/**",
]
```

Reference the directory through the same static `plugins` table:

```toml
[[config.group]]
files = [ "src/**/*.py" ]
language = "plaintext"

[config.group.plugins]
arch = "./rules/architecture"

[config.group.rules]
"arch/semantic-boundary" = "warn"
```

`name` becomes the local rule id. `builtInAgent` can be `basic-structured` for a prompt-only structured-output rule or `basic-coding-agent` for a small built-in agent with filesystem tools. `includeFiles` and `excludeFiles` define where diagnostics may be reported; they do not limit what `basic-coding-agent` can inspect.

Editing a rule's `instruction`, `includeFiles`, or `excludeFiles` invalidates the findings it cached: a declarative rule declares those inputs as its cache key, so a changed rule text never replays stale findings.

Run the install command again after changing a source string, moving a local directory, or changing its symlink target. Changes inside the same local directory are loaded by the next CLI process without reinstalling.

Local plugins execute as trusted Node.js code. Directory containment checks validate the installed source; they are not a sandbox.

#### Plugin lockfile

`alint plugin install` writes `.alint/plugins/lock.json`. Package entries lock the downloaded package and integrity metadata. Local entries lock the physical directory identity while loading its current contents at runtime.

Rule severities follow the familiar lint convention:

- `"off"` or `0` disables a rule.
- `"warn"` or `1` reports a warning.
- `"error"` or `2` reports an error.

Flat configs can analyze non-JavaScript files by selecting `plaintext`. Language ids follow [VS Code's language identifiers](https://code.visualstudio.com/docs/languages/identifiers), so a plugin that registers a language should use the same id:

```ts
import docsPlugin from '@your-alint-config/docs-rules'

import { defineConfig } from '@alint-js/cli'

export default defineConfig([
  {
    files: ['docs/**/*.md', '**/*.txt'],
    language: 'plaintext',
    plugins: {
      docs: docsPlugin,
    },
    rules: {
      'docs/review-copy': 'warn',
    },
  },
])
```

#### Cache and Stats

`alint` caches rule target results by default in `.alintcache` to avoid repeating LLM calls for unchanged source targets.

After each cacheable rule job completes, `alint` writes a cache checkpoint before releasing that job's scheduler slot. Each checkpoint atomically replaces the complete cache file, so an interrupted run can reuse every result that had already become durable. Cache hits, skipped jobs, failed jobs, and rules that opt out of caching do not add checkpoint writes. Any checkpoint or final cache write error causes the run to fail.

> [!NOTE]
> `.alintcache` should not be committed to Git. Add it to `.gitignore` before running repeated local analysis.

```bash
echo ".alintcache" >> .gitignore
```

Disable cache for a single run:

```bash
alint --no-cache src
```

Run stats are recorded by default. Use `--no-stats` to skip recording for a run, and use the `stats` command group to inspect saved usage over time.

### Rule Developer side

To reduce the token cost during analysis while allowing rule authors to specify model size and capabilities, `alint` allows rule authors to **Request & Match** models with *Capability Selector* and *Size Selector*, instead of hardening the entire `alint` run to use a single model for all rules.

In other words, you could set up your DeepSeek, OpenAI, Ollama, or other OpenAI-compatible model on your machine and let rule authors request a model with `tool-call` capability and `small` size. `alint` will match the best configured model for them.

```ts
const model = await ctx.model({
  capabilities: ['tool-call'],
  size: 'small',
})
```

You can also call `ctx.model()` without arguments when a rule does not need a specific size or capability.

#### About agent

In `alint`, we don't limit you to any specific agent SDK. You can use an exported client from a framework such as Eve, Strands, Pi, Claude Code SDK, Codex SDK, or another tool-using runtime to implement your own agent to analyze code.

Agentic rules use `ctx.agent` when they need a multi-step tool loop, such as reading related files before reporting findings. The rule stays framework-agnostic, and the user chooses the adapter:

```ts
import { createApeiraAdapter } from '@alint-js/agent-apeira'
import { createAgentExamplePlugin } from '@alint-js/plugin-example-agent'

export default [
  {
    agent: createApeiraAdapter(),
    extends: ['agent-example/recommended'],
    plugins: {
      'agent-example': createAgentExamplePlugin(),
    },
  },
]
```

Current adapter packages include:

- `@alint-js/agent-apeira` for Apeira on the xsai stack.
- `@alint-js/agent-pi` for Pi.

However, be careful with token cost. `alint` is designed to be a code analysis tool, where rapid and repeated calls to the model are expected. Local models, cheap small models, and cache-friendly prompts are usually better defaults than routing every rule target through a large hosted model.

#### BYOA, any agent works

Bring Your Own Agent means `alint` does not try to own the agent harness. A rule can depend on the `@alint-js/core` agent contract, while the actual runtime can be Apeira, Pi, your own in-house agent, or a small function that calls the tools you need.

If an adapter is missing, you can implement the missing function or package your own plugin to replace it. The important part is that the rule reports diagnostics back through `alint`; how the agent reads files, calls tools, plans steps, or talks to a model is intentionally left to the adapter or plugin author.

#### Example rule

Rules are ordinary JavaScript objects built with the public DSL from `@alint-js/core`. A rule receives source targets and reports diagnostics.

```ts
import { defineRule } from '@alint-js/core'

export const checkFunctionRule = defineRule({
  create: ctx => ({
    async onTargetFunction(target) {
      const model = await ctx.model({ capabilities: ['tool-call'], size: 'small' })

      ctx.report({
        filePath: target.file.path,
        loc: target.loc,
        message: `checked ${target.name} with ${model.id}`,
      })
    },
  }),
})
```

Package rules as plugins:

```ts
import { definePlugin } from '@alint-js/core'

import { checkFunctionRule } from './rules/check-function'

export default definePlugin({
  configs: {
    recommended: [
      {
        rules: {
          'my-plugin/check-function': 'warn',
        },
      },
    ],
  },
  rules: {
    'check-function': checkFunctionRule,
  },
})
```

Rule authors can opt out of caching when a rule depends on external state:

```ts
defineRule({
  cache: false,
  create: ctx => ({
    onTargetFile(target) {
      // Always reruns.
    },
  }),
})
```

Rules whose findings depend on inputs their source does not show must declare those inputs as `cacheKey`: an imported prompt, a shared message builder, or the text of a preset that builds the rule. `alint` hashes the rule source and `cacheKey` into every cache entry:

```ts
import prompt from './prompt.md?raw'

defineRule({
  cacheKey: { agentVersion: 1, prompt },
  create: ctx => ({ /* ... */ }),
})
```

Without a cache key, editing the prompt changes what the rule asks the model while the cache entry stays valid, and the next run replays the previous findings as cache hits without running the rule at all.

## Packages

| Package | Purpose |
| --- | --- |
| [`@alint-js/cli`](https://github.com/moeru-ai/alint/tree/main/packages/cli) | CLI entrypoint, user-facing config facade, setup commands, reporters, output inspection, and stats commands. |
| [`@alint-js/config`](https://github.com/moeru-ai/alint/tree/main/packages/config) | Lower-level config loading, setup TOML parsing, config paths, and ignore defaults for tools. |
| [`@alint-js/core`](https://github.com/moeru-ai/alint/tree/main/packages/core) | SDK and run engine for plugins, rules, source runtime, model resolution, diagnostics, cache, and agent contracts. |
| [`@alint-js/agent-apeira`](https://github.com/moeru-ai/alint/tree/main/packages/agent-apeira) | Apeira-backed `AgentAdapter`. |
| [`@alint-js/agent-pi`](https://github.com/moeru-ai/alint/tree/main/packages/agent-pi) | Pi-backed `AgentAdapter`. |
| [`@alint-js/languages`](https://github.com/moeru-ai/alint/tree/main/packages/languages) | First-party language support beyond core's built-in JavaScript and TypeScript: Go, Python, and Rust. |
| [`@alint-js/plugin-example`](https://github.com/moeru-ai/alint/tree/main/packages/plugin-example) | Example TypeScript/JavaScript model-backed rules. |
| [`@alint-js/plugin-example-agent`](https://github.com/moeru-ai/alint/tree/main/packages/plugin-example-agent) | Example plugin for framework-agnostic agentic rules. |
| [`@alint-js/plugin-example-go`](https://github.com/moeru-ai/alint/tree/main/packages/plugin-example-go) | Example semantic Go review plugin using `plaintext`. |

## Documentation Automation

The table of contents above is generated with `doctoc` so README navigation is not hand-written. Run this after changing headings:

```bash
pnpm docs:update
```

`docs:update` refreshes the root README TOC and then copies the root README to `packages/cli/README.md`, keeping the npm README for `@alint-js/cli` in sync with the project overview.

## Development

This repository is a pnpm workspace.

```bash
pnpm install
pnpm -F @alint-js/cli build
pnpm -F @alint-js/core exec vitest run
```

Before sending changes, run:

```bash
pnpm typecheck
pnpm lint
```

## Status

`alint` is early and APIs may change. The core direction is stable: lint-style diagnostics, model-backed rules, flat configs, provider setup, and optional agent adapters.

## License


MIT

[npmx-version-src]: https://npmx.dev/api/registry/badge/version/@alint-js/cli
[npmx-version-href]: https://npmx.dev/@alint-js/cli
[npmx-downloads-src]: https://npmx.dev/api/registry/badge/downloads-month/@alint-js/cli
[npmx-downloads-href]: https://npmx.dev/@alint-js/cli
[bundle-src]: https://npmx.dev/api/registry/badge/size/@alint-js/cli
[bundle-href]: https://bundlephobia.com/result?p=@alint-js/cli
[license-src]: https://npmx.dev/api/registry/badge/license/@alint-js/cli
[license-href]: https://github.com/moeru-ai/alint/blob/main/LICENSE
[jsdocs-src]: https://img.shields.io/badge/jsdocs-reference-080f12?style=flat&colorA=080f12&colorB=1fa669
[jsdocs-href]: https://www.jsdocs.io/package/@alint-js/cli

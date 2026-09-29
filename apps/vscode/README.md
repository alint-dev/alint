# `@alint-js/vscode`

The VS Code client for alint. It starts `alint lsp` and displays the diagnostics the server
publishes. All analysis happens in the server.

## What it does

- Finds the alint executable, in this order: the `alint.path` setting, `node_modules/.bin/alint` in
  a workspace folder, then `alint` on `PATH`. If none of them resolve, it reports one error that
  names all three locations.
- Starts that executable as `alint lsp` over stdio and keeps one `LanguageClient`.
- Adds the run and clear-cache commands to the command palette. The server performs the run,
  reports its progress, and handles cancellation. The extension forwards the request, and asks for
  confirmation before the cache is cleared.

The server is the alint the workspace installs, running on the user's own Node. Its working
directory, config discovery, and cache keys therefore match a terminal run, and both read the same
cache file.

## How to use it

The extension activates when a workspace contains an `alint.config.*` file. A workspace that does
not use alint starts no server.

```jsonc
// .vscode/settings.json - only needed for a non-standard installation
{
  "alint.path": "/usr/local/bin/alint"
}
```

To run it from a checkout, build the extension and open a project with it. The build writes the
extension manifest into `dist`, so the extension development path is `dist` and not the package
root.

```sh
pnpm -F @alint-js/vscode build
code --extensionDevelopmentPath=apps/vscode/dist /path/to/your/project
```

The `alint` output channel contains the server log.

## When to use it

- You want alint diagnostics underlined in the editor and listed in the Problems panel.
- You already run alint in a terminal, and you want those results in the editor without paying for
  them again.

## When not to use it

- You want analysis on every keystroke. alint never calls a model on its own. The editor shows
  cached diagnostics, and a run that spends tokens is always explicit.
- You do not use VS Code. The server works in any editor with LSP support: start `alint lsp`
  directly, for example `cmd = { 'alint', 'lsp' }` in Neovim. Only the status bar is specific to
  VS Code.
- Your cache is empty. There is nothing to display until the first run.

## Roadmap

### Available

- Diagnostics on workspace load, refreshed when a file is saved or changes on disk
- Workspace folders added to or removed from the window
- `alint: Run on Current File` and `alint: Run on Workspace`, with progress and a cancel button
- `alint: Clear Cache`, behind a confirmation
- Executable resolution: the `alint.path` setting, the workspace install, then `PATH`

### Planned

- A status bar with the number of checks that need a run, and the tokens a run spends
- A prompt when the workspace has no config or no model provider

Everything else an editor shows comes from `alint lsp`, which serves any LSP editor. Work on the
server is tracked with [alint](https://github.com/moeru-ai/alint) itself, not here.

## Packaging notes

The npm package name and the extension identifier are different things, and they cannot share one
file: VS Code builds the identifier from `publisher` and `name`, and the marketplace rejects a
scoped name. This package keeps the workspace name `@alint-js/vscode`, declares the identity under
a `vscode` key, and the build writes `dist/package.json` with `moeru-ai.alint`.

Configure the extension host and `vsce` to use `dist`, not the package root. The bundle includes
everything except `vscode`, which the host provides, so the emitted manifest declares no
dependencies and the package needs no `node_modules`.

# @alint-js/plugin-example-agent

An example alint plugin whose rule runs through a **swappable agent** via
`ctx.agent`, demonstrating how a single rule stays agnostic to the underlying
agent framework.

## What it does

Implements one rule, `agent-example/reinvented-helper`, which spots and warns
about local helper functions that duplicate a utility already available in the
codebase. Instead of a single model call, the rule drives a multi-step tool loop through `ctx.agent` (if configured):

- `read_file`: Lets the agent inspect the modules the file imports and any
  shared utilities before deciding.
- `report_finding`: Records one finding per duplicated helper, where the rule
  turns into a warning diagnostic.

The rule depends purely on `@alint-js/core`. It never imports an agent
framework: it reads the adapter via `requireAgent(ctx)` (from
`@alint-js/core/agent`), and alint resolves whichever adapter the user
configured.

## How to use

Register the plugin and provide an agent adapter through `agent`:

```ts
import { createApeiraAdapter } from '@alint-js/agent-apeira'
import { createAgentExamplePlugin } from '@alint-js/plugin-example-agent'

export default [
  {
    agent: createApeiraAdapter(),
    extends: ['agent-example/recommended'],
    plugins: {
      'agent-example': createAgentExamplePlugin()
    },
  },
]
```

Swapping the framework is a one-line change and touches nothing in the rule:

```diff
- import { createApeiraAdapter } from '@alint-js/agent-apeira'
- agent: createApeiraAdapter(),
+ import { createPiAdapter } from '@alint-js/agent-pi'
+ agent: createPiAdapter(),
```

`ctx.agent` is required only for agentic rules. When none is set for an agentic rule, the `requireAgent(ctx)` called internally will throw an error. Rules that don't need an agent can ignore `ctx.agent` entirely.

## When to use

- As a reference for writing agentic rules: rules that need a multi-step tool
  loop (read context, then report, etc.) rather than a single structured
  judgment.
- To learn how an agent adapter is wired into a config and swapped between
  frameworks.

## When not to use

- Do not use the rule in production. This is an example plugin.
- If you want to build a rule that only needs a single structured model call
  (no tool loop), follow the judge examples instead
  (`@alint-js/plugin-example`, `@alint-js/plugin-example-go`), which call the
  model directly.
- Do not depend on this package as a library. This is an example plugin.

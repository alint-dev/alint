# `@alint-js/agent-apeira`

> [!IMPORTANT]
> This package is a WIP. APIs may be subject to major changes.

An [Apeira](https://github.com/moeru-ai/apeira)-backed `AgentAdapter` for alint. One of the swappable vendor adapters behind `@alint-js/agent`.

## What it does

`createApeiraAdapter()` returns an `AgentAdapter` that runs a rule's request through
Apeira's `chat` runner: it translates the framework-agnostic `AgentTool`s to xsai tools,
runs the tool loop (capped at 8 steps by default), and reads back the final answer and usage.

An Apeira runner makes one model call per invocation. `runSteps()` is the tool loop on top of
it: it runs the requested tools, feeds their output into the next call, and stops when the model
stops calling tools, after `maxSteps` calls, or once an `until()` predicate holds.

## How to use

```ts
import { createApeiraAdapter } from '@alint-js/agent-apeira'

const adapter = createApeiraAdapter()
```

Pass `{ maxSteps }` to change the step cap, and `{ createRunner }` to inject a custom Apeira
runner, which is called once per step.

To drive a runner with your own tools and stop condition, use `runSteps()` directly:

```ts
import { runSteps } from '@alint-js/agent-apeira'

const { output, usage } = await runSteps(runner, context, {
  maxSteps: 8,
  until: () => report !== undefined,
})
```

## When to use

- You want tool-using rules powered by Apeira on the xsai stack.

## When not to use

- You use a different agent framework. Pick that vendor's adapter (e.g.
  `@alint-js/agent-pi`) or write your own `AgentAdapter`.
- Your rule needs no tools. Keep it on the plain `@alint-js/core` rule DSL.

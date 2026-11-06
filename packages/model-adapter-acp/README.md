# `@alint-js/model-adapter-acp`

An OpenAI-compatible HTTP gateway for ACP coding agents.

## What it does

The package keeps ACP session semantics outside alint. It exposes configured ACP agents as
OpenAI-compatible models and implements:

- `GET /v1/models`
- non-streaming and SSE text chat completions
- request-scoped OpenAI function tools exposed to ACP through MCP Streamable HTTP
- deferred `tool_calls` continuation through a later `role: tool` message
- `tool_choice`, usage, abort, continuation TTL, and permission-denial handling

The integration suite also runs a real `runAlint` file rule through `ctx.model()`, xsAI
`generateStructured`, this HTTP gateway, an ACP session, and the MCP `reportFindings` tool before
asserting the diagnostic returned by alint.

The MCP bridge uses a random route and bearer token for each completion turn. When the public
gateway address is not loopback, configure `mcpBaseUrl`; request Host headers are not trusted to
choose the authenticated MCP destination.

ACP has no equivalent for OpenAI `temperature`, and final ACP usage is unavailable while a
deferred tool call is pending. Use `onCompatibilityDiagnostic` to observe those cases. Pending
tool-call responses report zero usage because xsAI requires the OpenAI `usage` object.

## How to use with a command

`createCommandModel` uses `tinyexec` to start one ACP process per completion. `startGateway` owns the loopback HTTP server and closes active ACP processes when it shuts down.

```ts
import { createCommandModel, startGateway } from '@alint-js/model-adapter-acp'

const gateway = await startGateway({
  cwd: process.cwd(),
  models: [
    createCommandModel({
      command: 'codex-acp',
      cwd: process.cwd(),
      id: 'codex',
      name: 'Codex ACP',
    })
  ],
})

console.info(gateway.endpoint)
await gateway.shutdown()
```

The alint CLI wraps this interface. Users normally set `driver = "acp"` on a provider model in global setup or `.alint/config.toml` instead of starting the gateway themselves.

## How to embed an ACP connection

```ts
import { createGateway } from '@alint-js/model-adapter-acp'
import { serve } from 'h3/node'

const app = createGateway({
  cwd: process.cwd(),
  mcpBaseUrl: 'http://127.0.0.1:7419',
  models: [
    {
      id: 'reviewer',
      name: 'Review Agent',
      openConnection: async () => ({
        kind: 'stream',
        stream: await openYourAcpStream(),
      }),
    }
  ],
})

const server = await serve(app, { hostname: '127.0.0.1', port: 7419 }).ready()

// On shutdown, stop accepting HTTP first, then cancel retained ACP continuations.
await server.close()
await app.shutdown()
```

`openConnection` accepts either an official ACP `AgentApp` or `Stream`. An embedding application can own a different transport or lifecycle policy without using the command adapter.

Other OpenAI-compatible consumers can use the resulting ordinary provider endpoint:

```toml
[[providers]]
id = "acp"
type = "openai-compatible"
endpoint = "http://127.0.0.1:7419/v1"
```

## When to use

- You need existing OpenAI-compatible consumers to call an ACP coding agent.
- The ACP agent supports MCP over HTTP when request tools are used.
- The OpenAI client executes function calls and returns `role: tool` messages.

## When not to use

- Use an alint agent adapter when a rule intentionally depends on agent-specific behavior.
- Do not use this package as an OpenAI Responses, realtime, audio, or image compatibility layer.
- Sequential tool calls work with streaming and non-streaming chat completions.
- Parallel tool calls are not supported.

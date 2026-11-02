> ## Documentation Index
> Fetch the complete documentation index at: https://docs.langchain.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Connections

> Connection lifecycle, multiple servers, deployment scaling, protocol eras, and caching for MCP in LangChain.

[`MCPAdapter`](https://reference.langchain.com/javascript/langchain-mcp-adapters/MCPAdapter) discovers MCP tools and keeps their connections open so your agent can reuse them across calls. Discover tools with `listTools()` or `listToolsets()`, and close the adapter when your application finishes using them.

Choose how long to keep the adapter open:

| Situation | Pattern | Go to |
| - | - | - |
| Script or agent invocation | Create the adapter, run the agent, then close in `finally` | [Connection lifecycle](#connection-lifecycle) |
| Long-lived worker | Reuse one adapter and close it during shutdown | [Scale a deployment](#scale-a-deployment) |

See [Transports](https://docs.langchain.com/oss/javascript/langchain/mcp.md#transports) for each server's connection options.

## Connection lifecycle

Constructing an adapter validates its configuration without opening connections. `listTools()`, `listToolsets()`, `getClient()`, and the resource methods connect when they run discovery. Keep the adapter open while your agent uses those tools.

To discover tools, run an agent, and release the connections, pass your MCP server's HTTP URL to `runAgent`:

```ts theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { MCPAdapter } from "@langchain/mcp-adapters";
import { createAgent } from "langchain";

async function runAgent(serverUrl: string) {
  const adapter = new MCPAdapter({
    servers: { weather: { url: serverUrl } },
  });

  try {
    const tools = await adapter.listTools();
    const agent = createAgent({
      model: "claude-sonnet-5",
      tools,
    });
    const result = await agent.invoke({
      messages: [{ role: "user", content: "What is the weather in Oslo?" }],
    });
    console.log(result.messages.at(-1)?.text);
  } finally {
    await adapter.close();
  }
}
```

> [card] [View example trace](https://smith.langchain.com/public/80510373-9970-43bf-bb13-5aa9b7715cba/r)
>
> Open a public LangSmith run for this example.

`close()` aborts in-flight adapter work, closes its connections, and clears its caches. You can call `listTools()` again to open fresh connections, but use the newly returned tools. Previously returned tools retain their closed clients.

## Multiple servers

Each named entry in `servers` gets its own connection, authentication, and [protocol mode](#protocol-eras). One adapter can connect to both HTTP and stdio servers.

To discover tools from both transports, pass a calendar server's HTTP URL and a files server's script path to `listServerTools`:

```ts theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { MCPAdapter } from "@langchain/mcp-adapters";

async function listServerTools(calendarUrl: string, filesServerPath: string) {
  const adapter = new MCPAdapter({
    servers: {
      calendar: { url: calendarUrl },
      files: { command: "node", args: [filesServerPath] },
    },
  });

  try {
    const toolsets = await adapter.listToolsets();
    console.log(toolsets.calendar.map((tool) => tool.name));

    const fileTools = await adapter.listTools("files");
    console.log(fileTools.map((tool) => tool.name));
  } finally {
    await adapter.close();
  }
}
```

> [card] [View example trace](https://smith.langchain.com/public/545c62ba-f5c4-4127-9132-b8fbe8c152f8/r)
>
> Open a public LangSmith run for this example.

`listToolsets()` groups tools by server name. `listTools()` returns one array; pass a server name or an array of names to select which tools it returns. Selection filters the result, but discovery still contacts every configured server. A failure on an unselected server can fail the call.

The adapter prefixes tool names with their server name by default, such as `calendar_search` and `files_search`. Set `prefixToolNameWithServerName: false` to keep raw names. `listTools()` throws if its selected tools contain duplicate names.

OpenAI and Anthropic accept only letters, digits, `_`, and `-` in tool names (`^[a-zA-Z0-9_-]+$`), up to 64 characters for OpenAI and 128 for Anthropic. The adapter does not rename a prefixed name that breaks these limits, so keep server names short and free of dots and spaces.

Set `defaultToolTimeout` (in milliseconds) at the top level to apply it to every server's tools; it wins over a server's own `defaultToolTimeout`.

## Scale a deployment

Create the adapter at module scope, outside the graph factory. Each factory call can discover the current tool catalog and build an agent using the shared connections:

```ts theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { MCPAdapter } from "@langchain/mcp-adapters";
import { createAgent } from "langchain";

const servers = {
  weather: { url: "https://example.com/mcp" },
};
const adapter = new MCPAdapter({ servers });

export async function makeGraph() {
  const tools = await adapter.listTools([], { cacheMode: "refresh" });
  return createAgent({
    model: "claude-sonnet-5",
    tools,
  });
}
```

> [card] [View example trace](https://smith.langchain.com/public/a67437b5-3eef-41ee-8a90-7947c5897d31/r)
>
> Open a public LangSmith run for this example.

Keep the adapter open across runs. Close it during application shutdown, after active runs finish. For runs with different user credentials, see [Per-user authentication](https://docs.langchain.com/oss/javascript/langchain/mcp/auth.md#per-user-authentication).

Discovery throws on connection failures by default. Set `onConnectionError: "ignore"`, or provide a callback that returns normally, to continue with the remaining servers. Non-authentication failures keep that connection skipped on later discoveries, even with `cacheMode: "refresh"`. Close the adapter to clear skipped connections before discovering again. Authentication failures are retried on the next discovery.

Stdio servers support `restart` settings, and HTTP and SSE servers support `reconnect` settings when configured with `mode: "legacy"`. After a restart, call `listTools()` again and use the returned tools; tools returned before the restart keep the closed connection.

Modern MCP servers keep no session, so their replicas can run behind any load balancer. A sessionful legacy server still needs sticky routing to one replica. A modern server that runs several replicas must share one `requestState` signing key across them, or an elicitation answer that reaches a different replica is rejected. See [Protect `requestState` with the codec](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/input-required.md#protect-requeststate-with-the-codec) in the MCP TypeScript SDK documentation.

## Caching

The MCP SDK provides an in-memory cache for tool lists. Repeated discovery avoids a network request while the server's `ttlMs` hint remains valid. Without a positive `ttlMs`, discovery fetches the list again.

Use `cacheMode` to control how `listTools()` and `listToolsets()` read the response cache:

* **`"use"`** (the default): Serve a valid cached tool list when one is available, otherwise fetch and store it.
* **`"refresh"`**: Fetch a fresh tool list and update the cache.
* **`"bypass"`**: Fetch a fresh tool list without reading or updating the response cache.

To refresh tools from all configured servers, pass an empty server-selection array and the discovery options:

```typescript theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
const tools = await adapter.listTools([], { cacheMode: "refresh" });
```

The adapter also reuses converted LangChain tool wrappers when the server descriptors have not changed. Rediscovery returns the current tools; it does not update an existing agent's tool list. Build the next agent with the returned tools.

## Protocol eras

The adapter negotiates the MCP protocol separately for each server. The default `mode: "auto"` supports modern and legacy servers in the same adapter.

The legacy era starts with an `initialize` handshake. The modern era uses `server/discover` to discover server capabilities. Override `mode` when you need to require a specific era:

```ts theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { MCPAdapter } from "@langchain/mcp-adapters";

async function listToolsAcrossEras(modernUrl: string, legacyUrl: string) {
  const adapter = new MCPAdapter({
    servers: {
      current: { url: modernUrl, mode: "modern" },
      legacy: { url: legacyUrl, mode: "legacy" },
    },
  });

  try {
    const tools = await adapter.listTools();
    console.log(tools.map((tool) => tool.name));
  } finally {
    await adapter.close();
  }
}
```

> [card] [View example trace](https://smith.langchain.com/public/9302383c-3aa9-451e-b588-41a94c35dd3b/r)
>
> Open a public LangSmith run for this example.

Each server's `mode` controls its negotiation independently:

* **`"auto"`** (the default): Try the current protocol and fall back for a legacy-only server.
* **`"modern"`**: Require protocol version `2026-07-28` and fail instead of using legacy MCP.
* **`"legacy"`**: Skip modern probing and use the legacy client interface.

In `"auto"` mode, a URL server that answers the Streamable HTTP request with 404 or 405 is retried over SSE, at the same URL and then with a trailing `/mcp` replaced by `/sse`. In `"legacy"` mode, any 4xx falls back unless `automaticSSEFallback: false`.

`setLoggingLevel()` is legacy-only and throws when a connected server negotiated the modern protocol; set `logLevel` on each modern server instead.

## See also

* [Authentication](https://docs.langchain.com/oss/javascript/langchain/mcp/auth.md): Bearer, OAuth, and per-user credentials.

* [Human-in-the-loop](https://docs.langchain.com/oss/javascript/langchain/human-in-the-loop.md): Pause and resume tool calls.

* [MCP specification](https://modelcontextprotocol.io/specification/latest)

***

[Connect these docs](https://docs.langchain.com/use-these-docs.md) to your agent of choice via MCP for real-time answers.

[Edit this page on GitHub](https://github.com/langchain-ai/docs/edit/main/src/oss/langchain/mcp/connections.mdx) or [file an issue](https://github.com/langchain-ai/docs/issues/new/choose).

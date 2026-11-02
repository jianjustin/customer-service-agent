> ## Documentation Index
> Fetch the complete documentation index at: https://docs.langchain.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Tools

> Load MCP tools into LangChain agents, control their execution, and handle server results and requests.

[`MCPAdapter`](https://reference.langchain.com/javascript/langchain-mcp-adapters/MCPAdapter) bridges MCP servers and LangChain agents: it discovers the tools a server advertises and adapts them into standard LangChain tools. Pass the tools from `listTools()` to [`createAgent`](https://reference.langchain.com/javascript/langchain/index/createAgent) as you would any other LangChain tool.

This page covers what is specific to that bridge: identifying MCP tools, controlling their execution, handling their outputs, and responding when a server needs input during a call. For the runnable discovery-and-agent example, see the [MCP quickstart](https://docs.langchain.com/oss/javascript/langchain/mcp.md).

## Use MCP tools in an agent

Discover the server's catalog with [`MCPAdapter.listTools`](https://reference.langchain.com/javascript/langchain-mcp-adapters/MCPAdapter/listTools), then give the returned tools to [`createAgent`](https://reference.langchain.com/javascript/langchain/index/createAgent). From the agent's perspective, they behave like LangChain tools: the model chooses a tool, LangChain invokes it, and the resulting [`ToolMessage`](https://reference.langchain.com/javascript/langchain-core/messages/ToolMessage) returns to the model.

```ts theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { MCPAdapter } from "@langchain/mcp-adapters";
import { createAgent } from "langchain";

async function main(server: string) {
  const adapter = new MCPAdapter({
    servers: { weather: { url: server } },
  });

  try {
    // Discover the server's tools, then hand them to the agent like any other
    // LangChain tools. Keep the adapter open while the agent calls its tools.
    const tools = await adapter.listTools();
    const agent = createAgent({ model: "claude-sonnet-5", tools });

    await agent.invoke({
      messages: [{ role: "user", content: "What is the forecast for Oslo?" }],
    });
  } finally {
    await adapter.close();
  }
}
```

> [card] [View example trace](https://smith.langchain.com/public/fe7b9e79-fe95-4248-988e-f4a7b4a248da/r)
>
> Open a public LangSmith run for this example.

Keep the adapter open while the agent can call its tools, including when resuming an interrupted run. Call `await adapter.close()` when you finish using the agent.

For general guidance on defining, binding, and using LangChain tools, see [Tools](https://docs.langchain.com/oss/javascript/langchain/tools.md). For several MCP servers and their namespaced tool catalogs, see [Connections](https://docs.langchain.com/oss/javascript/langchain/mcp/connections.md#multiple-servers).

## Handle tool outputs

MCP tool results become [`ToolMessage`](https://reference.langchain.com/javascript/langchain-core/messages/ToolMessage) objects with content the model can read, an artifact for application data, and a status indicating success or failure.

### Multimodal content

The adapter converts model-visible MCP content into LangChain [content blocks](https://docs.langchain.com/oss/javascript/langchain/messages.md#standard-content-blocks). For example, a tool that returns an MCP image block with a screenshot reaches the model as an `image` block.

```ts theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { MCPAdapter } from "@langchain/mcp-adapters";
import { createAgent } from "langchain";

async function accessMultimodalToolContent(serverUrl: string) {
  const adapter = new MCPAdapter({
    servers: { browser: { url: serverUrl } },
  });

  try {
    const tools = await adapter.listTools();

    const agent = createAgent({ model: "claude-sonnet-5", tools });

    const result = await agent.invoke({
      messages: [
        { role: "user", content: "Take a screenshot of the current page" },
      ],
    });

    // An MCP result arrives as LangChain content blocks. Image content
    // converts into standardized `image` blocks alongside `text`.
    for (const message of result.messages) {
      if (message.type === "tool") {
        for (const block of message.contentBlocks) { // [!code highlight]
          if (block.type === "text") { // [!code highlight]
            console.log(`Text: ${block.text}`); // [!code highlight]
          } else if (block.type === "image") { // [!code highlight]
            console.log(`Image MIME type: ${block.mimeType}`); // [!code highlight]
            console.log(`Image data: ${String(block.data).slice(0, 50)}...`); // [!code highlight]
          } // [!code highlight]
        } // [!code highlight]
      }
    }
  } finally {
    await adapter.close();
  }
}
```

> [card] [View example trace](https://smith.langchain.com/public/da8706a2-07f7-456b-a74a-c3a3ee4e69ca/r)
>
> Open a public LangSmith run for this example.

### Structured content

When a tool returns structured content, the adapter attaches it to the [`ToolMessage`](https://reference.langchain.com/javascript/langchain-core/messages/ToolMessage) as an artifact rather than folding it into the model-visible text. Run the agent, then read the `artifact` from the [`ToolMessage`](https://reference.langchain.com/javascript/langchain-core/messages/ToolMessage) instances in the result:

```ts theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { MCPAdapter } from "@langchain/mcp-adapters";
import { createAgent, ToolMessage } from "langchain";

async function readStructuredContent(serverUrl: string) {
  const adapter = new MCPAdapter({
    servers: { crm: { url: serverUrl } },
  });

  try {
    const tools = await adapter.listTools();
    const agent = createAgent({ model: "claude-sonnet-5", tools });
    const result = await agent.invoke({
      messages: [{ role: "user", content: "Look up user 42." }],
    });

    // The adapter stores MCP result entries in an `artifact` array.
    // Find the `mcp_structured_content` entry, then read its `data` field.
    for (const message of result.messages) {
      if (ToolMessage.isInstance(message) && Array.isArray(message.artifact)) {
        const structured = message.artifact.find(
          (entry) => entry.type === "mcp_structured_content",
        );
        if (structured) {
          console.log(`Structured content: ${JSON.stringify(structured.data)}`); // [!code highlight]
        }
      }
    }
  } finally {
    await adapter.close();
  }
}
```

> [card] [View example trace](https://smith.langchain.com/public/213c3154-aef7-4d36-bdb4-61ccf1863231/r)
>
> Open a public LangSmith run for this example.

The `artifact` is an array of MCP result entries. Structured content appears in the entry with `type: "mcp_structured_content"`, and its `data` field holds the tool result's `structuredContent`.

### Errors

When a server returns `isError: true` during an agent tool call, the adapter returns a [`ToolMessage`](https://reference.langchain.com/javascript/langchain-core/messages/ToolMessage) with `status: "error"` and the server's message. The model can read the error and try again.

The adapter throws transport failures. When a tool runs inside `createAgent`, the agent's default error handling turns those failures into error tool messages too. The message's `status` alone does not distinguish the cause:

```ts theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { MCPAdapter } from "@langchain/mcp-adapters";
import { createAgent, ToolMessage } from "langchain";

async function divideByZero(serverUrl: string) {
  const adapter = new MCPAdapter({
    servers: { calculator: { url: serverUrl } },
  });

  try {
    const tools = await adapter.listTools();

    const agent = createAgent({ model: "claude-sonnet-5", tools });
    const result = await agent.invoke({
      messages: [{ role: "user", content: "What is 10 divided by 0?" }],
    });

    // A server error (isError: true) reaches the model as a failed ToolMessage,
    // so the agent can read the server's own message and recover. By default,
    // createAgent also converts transport failures into error tool messages.
    for (const message of result.messages) {
      if (ToolMessage.isInstance(message) && message.status === "error") {
        console.log(`Tool error: ${message.text}`); // [!code highlight]
      }
    }
  } finally {
    await adapter.close();
  }
}
```

> [card] [View example trace](https://smith.langchain.com/public/b4f86650-e369-4df6-bf4a-1f634d2c3099/r)
>
> Open a public LangSmith run for this example.

If you invoke an adapted tool directly with plain arguments, a server result with `isError: true` throws a `ToolException` instead, with the MCP result in `error.result`.

## Tool metadata

The adapter stores MCP tool annotations in `tool.metadata.annotations`:

```typescript theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
tool.metadata;
// {
//   annotations: {
//     destructiveHint: true,
//     readOnlyHint: false,
//   },
// }
```

`annotations` holds the server's MCP tool annotations, such as `readOnlyHint` and `destructiveHint`. A server may omit them, so the field can be `undefined`.

Read optional metadata defensively, so a missing field returns a default rather than failing:

This example and the [human-in-the-loop example](#human-in-the-loop) import types from `@modelcontextprotocol/client`; add it as a direct dependency.

```ts theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import type { DynamicStructuredTool } from "@langchain/core/tools";
import type { ToolAnnotations } from "@modelcontextprotocol/client";

/** Read the MCP destructive hint from the adapter's tool metadata. */
function isDestructive(tool: DynamicStructuredTool): boolean {
  // Use optional chaining and a default so a tool missing any field returns
  // false rather than raising.
  const annotations = tool.metadata?.annotations as ToolAnnotations | undefined;
  return annotations?.destructiveHint ?? false;
}
```

## Human-in-the-loop

Reading annotations lets you gate a tool based on what the server declares about it, rather than hardcoding tool names. The MCP annotation classifies the tool and LangChain's human-in-the-loop middleware enforces the approval policy.

Read the destructive hint from metadata once during tool discovery. Then give the human-in-the-loop configuration a `when` predicate that receives each pending tool call and returns whether the call needs approval:

```ts theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import type { DynamicStructuredTool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { MCPAdapter } from "@langchain/mcp-adapters";
import type { ToolAnnotations } from "@modelcontextprotocol/client";
import {
  createAgent,
  humanInTheLoopMiddleware,
  type InterruptOnConfig,
  type WhenPredicate,
} from "langchain";

function isDestructive(tool: DynamicStructuredTool): boolean {
  const annotations = tool.metadata?.annotations as ToolAnnotations | undefined;
  return annotations?.destructiveHint ?? false;
}

async function gateDestructiveTools(serverUrl: string) {
  const adapter = new MCPAdapter({
    servers: { crm: { url: serverUrl } },
  });
  const tools = await adapter.listTools();

  // Read the hint once, then apply the same predicate to every tool call.
  const destructive = new Set(
    tools.filter(isDestructive).map((tool) => tool.name),
  );

  const needsApproval: WhenPredicate = (request) =>
    destructive.has(request.toolCall.name);

  const gate: InterruptOnConfig = {
    allowedDecisions: ["approve", "reject"],
    when: needsApproval,
  };
  const interruptOn = Object.fromEntries(
    tools.map((tool) => [tool.name, gate]),
  );

  const agent = createAgent({
    model: "claude-sonnet-5",
    tools,
    middleware: [humanInTheLoopMiddleware({ interruptOn })],
    checkpointer: new MemorySaver(),
  });
  return { agent, adapter };
}
```

> [!WARNING]
>
> `interruptOn` keys must be the adapter's tool names, which include the server prefix (`crm_delete_file`). An unprefixed key never matches, so the tool runs without approval.

When the agent calls a tool that the predicate gates, the run pauses. Approve the call to run it, or reject it to skip the tool and tell the model:

```typescript theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { Command } from "@langchain/langgraph";

// Approve the pending destructive call and resume.
const resumed = await agent.invoke(
  new Command({ resume: { decisions: [{ type: "approve" }] } }),
  config
);
```

The predicate can also inspect the call's arguments. This lets a tool run freely for safe inputs and pause only for risky ones, such as a `delete_file` call targeting a protected path.

Access the arguments through `request.toolCall.args`.

Combine the metadata classification and argument check to gate a tool only when its type and inputs warrant approval. For the full approval workflow, see [Human-in-the-loop](https://docs.langchain.com/oss/javascript/langchain/human-in-the-loop.md).

## Server requests during tool execution

Most tools finish without asking the client for anything mid-call. When a server needs input, [`MCPAdapter`](https://reference.langchain.com/javascript/langchain-mcp-adapters/MCPAdapter) surfaces [elicitation](https://modelcontextprotocol.io/specification/draft/client/elicitation) as a LangGraph [`interrupt`](https://reference.langchain.com/javascript/langchain-langgraph/index/interrupt).

### Elicitation

[Elicitation](https://modelcontextprotocol.io/specification/draft/client/elicitation) lets an MCP server request input during a tool call. The adapter pauses the run with a LangGraph interrupt. Your application presents the request to the user and resumes the run with their answer. Agent Server asks for input this way when an agent exposed through its MCP endpoint pauses. For more information, see [Human-in-the-loop over MCP](https://docs.langchain.com/langsmith/server-mcp-elicitation.md).

Attach a [checkpointer](https://docs.langchain.com/oss/javascript/langchain/short-term-memory.md) to the agent and use the same `thread_id` when invoking and resuming it.

This example assumes the booking tool asks for one date and pauses once. Replace the sample date with the user's answer.

Interrupt-driven elicitation requires a modern MCP server and is enabled by default. Set `elicitation: false` on the server to opt out. For a legacy server, configure an `onElicitation` handler with `mode: "legacy"` instead. Without a checkpointer, a tool that asks for input fails with an error `ToolMessage` instead of pausing.

```ts theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { Command, MemorySaver } from "@langchain/langgraph";
import {
  MCPAdapter,
  createMCPElicitationResume,
  type MCPElicitationInterrupt,
} from "@langchain/mcp-adapters";
import { createAgent } from "langchain";

async function bookWithElicitation(serverUrl: string) {
  // When a server needs input mid-call, the adapter surfaces the question
  // as a LangGraph interrupt.
  const adapter = new MCPAdapter({
    servers: { booking: { url: serverUrl } },
  });

  try {
    const tools = await adapter.listTools();
    // A checkpointer saves the interrupted run so it can resume.
    const agent = createAgent({
      model: "claude-sonnet-5",
      tools,
      checkpointer: new MemorySaver(),
    });
    const config = { configurable: { thread_id: "booking-1" } };

    const paused = await agent.invoke(
      { messages: [{ role: "user", content: "Book a table for 4." }] },
      config,
    );
    const [pending] = paused.__interrupt__!;
    const question = pending.value as MCPElicitationInterrupt;
    const [key] = Object.keys(question.requests);

    // Answers are keyed by the server's own request key.
    // Use `decline` or `cancel` to refuse the request.
    const answer = {
      action: "accept" as const,
      content: { date: "2026-09-14" },
    };
    // Address the answer to the interrupt that requested it.
    const resume = createMCPElicitationResume(pending, { [key]: answer });
    return await agent.invoke(new Command({ resume }), config);
  } finally {
    await adapter.close();
  }
}
```

> [card] [View example trace](https://smith.langchain.com/public/a51e276f-3aa7-4426-a7b7-986b5c4332e1/r)
>
> Open a public LangSmith run for this example.

`createMCPElicitationResume` addresses the answer to the interrupt that requested it. The response uses the server's request key. Build every resume value with `createMCPElicitationResume` rather than a bare `{ responses }` object, which does not say which interrupt it answers.

Each interrupt's `value` is an `MCPElicitationInterrupt`: `type: "mcp_elicitation"`, `server`, `tool` (the server's own tool name, without the prefix), `arguments` (the effective tool arguments), and `requests`. Check `type` when the same agent can also raise human-in-the-loop interrupts.

When several calls pause at once, answer every interrupt. Merge the objects that `createMCPElicitationResume` returns into one `Command({ resume })`, for example `Object.assign({}, ...paused.__interrupt__!.map((q) => createMCPElicitationResume(q, answers)))`, or resume until `__interrupt__` is empty. A resume that answers only the first interrupt leaves the others paused.

> [!NOTE]
>
> Resuming reruns the tool from the beginning. Any work performed before the server asks for input can repeat. Make that work safe to repeat without duplicating side effects.

Each answer uses one of these actions:

* **`accept`**: Provide form `content` matching the request's schema, or confirm completion of a URL interaction without `content`.
* **`decline`**: Refuse to provide the requested information.
* **`cancel`**: Indicate that the user canceled the interaction.

The adapter forwards the answer to the server, which decides how the tool call finishes.

Only elicitation is answered this way. The adapter declares only the elicitation capability on each call, so a tool that needs [sampling](https://modelcontextprotocol.io/specification/2025-06-18/client/sampling) or [roots](https://modelcontextprotocol.io/specification/2025-06-18/client/roots) fails with a `ToolException`, which `createAgent` returns to the model as an error `ToolMessage`. See [Sampling and roots](https://docs.langchain.com/oss/javascript/migrate/langchain-mcp-adapters.md#sampling-and-roots).

> [!NOTE]
>
> Interrupt-driven elicitation answers a server that returns its request as an `InputRequiredResult`. A server that only pushes elicitation over a legacy handshake session cannot be answered this way.

## See also

* [Content blocks](https://docs.langchain.com/oss/javascript/langchain/messages.md#standard-content-blocks)

* [Tools](https://docs.langchain.com/oss/javascript/langchain/tools.md)

* [Human-in-the-loop](https://docs.langchain.com/oss/javascript/langchain/human-in-the-loop.md)

* [MCP elicitation specification](https://modelcontextprotocol.io/specification/draft/client/elicitation)

* [MCP tool annotations](https://modelcontextprotocol.io/specification/draft/server/tools)

***

[Connect these docs](https://docs.langchain.com/use-these-docs.md) to your agent of choice via MCP for real-time answers.

[Edit this page on GitHub](https://github.com/langchain-ai/docs/edit/main/src/oss/langchain/mcp/tools.mdx) or [file an issue](https://github.com/langchain-ai/docs/issues/new/choose).

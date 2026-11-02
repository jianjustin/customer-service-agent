> ## Documentation Index
> Fetch the complete documentation index at: https://docs.langchain.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Agents

> Build a LangChain agent: a model calling tools in a loop until a task is complete, shaped by a harness of prompt, tools, and middleware.

An agent is a model calling tools in a loop until a given task is complete.

![Core agent loop diagram](https://mintcdn.com/langchain-5e9cc07a/jtty0O--UJOKG0nK/oss/images/core_agent_loop.svg?fit=max\&auto=format\&n=jtty0O--UJOKG0nK\&q=85\&s=4b4cbb497b6273758a565de1bc90ece0)

A harness is everything around that loop: the prompt, the tools, and any middleware that shapes the model's behavior.

> [!NOTE]
>
> **Agent = Model + Harness**
>
> The job of a harness: get the model the right context at the right time for the given task.

[`create_agent`](https://reference.langchain.com/javascript/langchain/index/createAgent) is a highly configurable harness. At its simplest, you can create one with:

```ts Google theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";

var agent = createAgent({ model: "google:gemini-3.6-flash", tools });
```

```ts OpenAI theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";

var agent = createAgent({ model: "openai:gpt-5.5", tools });
```

```ts Anthropic theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";

var agent = createAgent({ model: "anthropic:claude-sonnet-5", tools });
```

```ts OpenRouter theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";

var agent = createAgent({ model: "openrouter:z-ai/glm-5.2", tools });
```

```ts Fireworks theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";

var agent = createAgent({ model: "fireworks:accounts/fireworks/models/glm-5p2", tools });
```

```ts Baseten theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";

var agent = createAgent({ model: "baseten:zai-org/GLM-5.2", tools });
```

```ts Ollama theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";

var agent = createAgent({ model: "ollama:north-mini-code-1.0", tools });
```

Building on that, you can configure the basics directly with the `model=`, `tools=`, and `system_prompt=` parameters. For more advanced capabilities, extend the harness with [middleware](#configure-the-harness).

> [!TIP]
>
> [Managed Deep Agents](https://docs.langchain.com/langsmith/javascript/managed-deep-agents-overview.md) builds on `create_agent` and comes with commonly useful capabilities already assembled, such as planning, file system tools, subagents, and memory. For maximum flexibility while using the same Deep Agents harness, use [Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview.md) and host agents yourself, or run a custom [LangSmith Deployment](https://docs.langchain.com/langsmith/deployment.md). Use `create_agent` when you need to configure a smaller harness yourself.

## Core components

![Agent model and harness components diagram](https://mintcdn.com/langchain-5e9cc07a/jtty0O--UJOKG0nK/oss/images/agent_model_harness.svg?fit=max\&auto=format\&n=jtty0O--UJOKG0nK\&q=85\&s=5ac6a7e0343af7cb5ba3ca632e2224af)

### Model

Pass a model identifier string (`"provider:model"`) or an initialized model instance to select the model for your agent. See [Models](https://docs.langchain.com/oss/javascript/langchain/models.md) for parameters, provider setup, and dynamic model selection.

```ts Google theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";

var agent = createAgent({ model: "google:gemini-3.6-flash", tools });
```

```ts OpenAI theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";

var agent = createAgent({ model: "openai:gpt-5.5", tools });
```

```ts Anthropic theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";

var agent = createAgent({ model: "anthropic:claude-sonnet-5", tools });
```

```ts OpenRouter theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";

var agent = createAgent({ model: "openrouter:z-ai/glm-5.2", tools });
```

```ts Fireworks theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";

var agent = createAgent({ model: "fireworks:accounts/fireworks/models/glm-5p2", tools });
```

```ts Baseten theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";

var agent = createAgent({ model: "baseten:zai-org/GLM-5.2", tools });
```

```ts Ollama theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";

var agent = createAgent({ model: "ollama:north-mini-code-1.0", tools });
```

### Tools

To provide the agent with tools, pass any Python callable, LangChain tool, or tool dict. See [Tools](https://docs.langchain.com/oss/javascript/langchain/tools.md) for tool definition, context access, and dynamic tool selection.

```ts Google theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { tool } from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Results for: ${query}`, {
  name: "search",
  description: "Search for information",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({ model: "google:gemini-3.6-flash", tools: [search] });
```

```ts OpenAI theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { tool } from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Results for: ${query}`, {
  name: "search",
  description: "Search for information",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({ model: "openai:gpt-5.5", tools: [search] });
```

```ts Anthropic theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { tool } from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Results for: ${query}`, {
  name: "search",
  description: "Search for information",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({ model: "anthropic:claude-sonnet-5", tools: [search] });
```

```ts OpenRouter theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { tool } from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Results for: ${query}`, {
  name: "search",
  description: "Search for information",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({ model: "openrouter:z-ai/glm-5.2", tools: [search] });
```

```ts Fireworks theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { tool } from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Results for: ${query}`, {
  name: "search",
  description: "Search for information",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({ model: "fireworks:accounts/fireworks/models/glm-5p2", tools: [search] });
```

```ts Baseten theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { tool } from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Results for: ${query}`, {
  name: "search",
  description: "Search for information",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({ model: "baseten:zai-org/GLM-5.2", tools: [search] });
```

```ts Ollama theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { tool } from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Results for: ${query}`, {
  name: "search",
  description: "Search for information",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({ model: "ollama:north-mini-code-1.0", tools: [search] });
```

### System prompt

Shape how the agent approaches tasks. The system prompt parameter accepts a string or `SystemMessage`. For dynamic prompts at runtime, use [middleware](https://docs.langchain.com/oss/javascript/langchain/middleware.md).

```ts Google theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
var agent = createAgent({
  model: "google:gemini-3.6-flash",
  tools,
  systemPrompt: "You are a helpful assistant. Be concise and accurate.",
});
```

```ts OpenAI theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
var agent = createAgent({
  model: "openai:gpt-5.5",
  tools,
  systemPrompt: "You are a helpful assistant. Be concise and accurate.",
});
```

```ts Anthropic theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
var agent = createAgent({
  model: "anthropic:claude-sonnet-5",
  tools,
  systemPrompt: "You are a helpful assistant. Be concise and accurate.",
});
```

```ts OpenRouter theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
var agent = createAgent({
  model: "openrouter:z-ai/glm-5.2",
  tools,
  systemPrompt: "You are a helpful assistant. Be concise and accurate.",
});
```

```ts Fireworks theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
var agent = createAgent({
  model: "fireworks:accounts/fireworks/models/glm-5p2",
  tools,
  systemPrompt: "You are a helpful assistant. Be concise and accurate.",
});
```

```ts Baseten theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
var agent = createAgent({
  model: "baseten:zai-org/GLM-5.2",
  tools,
  systemPrompt: "You are a helpful assistant. Be concise and accurate.",
});
```

```ts Ollama theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
var agent = createAgent({
  model: "ollama:north-mini-code-1.0",
  tools,
  systemPrompt: "You are a helpful assistant. Be concise and accurate.",
});
```

### Structured output

Return a validated schema from the agent using `response_format=`. See [Structured output](https://docs.langchain.com/oss/javascript/langchain/structured-output.md) for strategies and examples.

```ts Google theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
const Answer = z.object({ summary: z.string(), confidence: z.number() });

var agent = createAgent({
  model: "google:gemini-3.6-flash",
  tools,
  responseFormat: Answer,
});
const result = await agent.invoke({
  messages: [{ role: "user", content: "Summarize AI trends" }],
});
result.structuredResponse; // { summary: ..., confidence: ... }
```

```ts OpenAI theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
const Answer = z.object({ summary: z.string(), confidence: z.number() });

var agent = createAgent({
  model: "openai:gpt-5.5",
  tools,
  responseFormat: Answer,
});
const result = await agent.invoke({
  messages: [{ role: "user", content: "Summarize AI trends" }],
});
result.structuredResponse; // { summary: ..., confidence: ... }
```

```ts Anthropic theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
const Answer = z.object({ summary: z.string(), confidence: z.number() });

var agent = createAgent({
  model: "anthropic:claude-sonnet-5",
  tools,
  responseFormat: Answer,
});
const result = await agent.invoke({
  messages: [{ role: "user", content: "Summarize AI trends" }],
});
result.structuredResponse; // { summary: ..., confidence: ... }
```

```ts OpenRouter theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
const Answer = z.object({ summary: z.string(), confidence: z.number() });

var agent = createAgent({
  model: "openrouter:z-ai/glm-5.2",
  tools,
  responseFormat: Answer,
});
const result = await agent.invoke({
  messages: [{ role: "user", content: "Summarize AI trends" }],
});
result.structuredResponse; // { summary: ..., confidence: ... }
```

```ts Fireworks theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
const Answer = z.object({ summary: z.string(), confidence: z.number() });

var agent = createAgent({
  model: "fireworks:accounts/fireworks/models/glm-5p2",
  tools,
  responseFormat: Answer,
});
const result = await agent.invoke({
  messages: [{ role: "user", content: "Summarize AI trends" }],
});
result.structuredResponse; // { summary: ..., confidence: ... }
```

```ts Baseten theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
const Answer = z.object({ summary: z.string(), confidence: z.number() });

var agent = createAgent({
  model: "baseten:zai-org/GLM-5.2",
  tools,
  responseFormat: Answer,
});
const result = await agent.invoke({
  messages: [{ role: "user", content: "Summarize AI trends" }],
});
result.structuredResponse; // { summary: ..., confidence: ... }
```

```ts Ollama theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
const Answer = z.object({ summary: z.string(), confidence: z.number() });

var agent = createAgent({
  model: "ollama:north-mini-code-1.0",
  tools,
  responseFormat: Answer,
});
const result = await agent.invoke({
  messages: [{ role: "user", content: "Summarize AI trends" }],
});
result.structuredResponse; // { summary: ..., confidence: ... }
```

### Agent state

Every agent manages its execution context through an `AgentState` object that holds the current conversation history and any custom fields your tools and middleware need.

The built-in field is:

| Field | Type | Description |
| - | - | - |
| `messages` | `BaseMessage[]` | The full conversation history for the current thread. Append-only: new messages are added, never replaced. |

`AgentState` is also the type passed to every node-style middleware hook (`beforeModel`, `afterModel`, and similar). Hooks receive the current state and can return an object of updates to merge back into it.

To add custom fields, define a state schema on your middleware using `stateSchema` with a `StateSchema` or Zod object:

```ts Google theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, createMiddleware } from "langchain";
import { StateSchema } from "@langchain/langgraph";
import * as z from "zod";

const MyState = new StateSchema({
  userId: z.string(),
  callCount: z.number().default(0),
});

const stateMiddleware = createMiddleware({
  name: "StateExtension",
  stateSchema: MyState, // [!code highlight]
});

const agent = createAgent({
  model: "google:gemini-3.6-flash",
  tools: [],
  middleware: [stateMiddleware],
});
```

```ts OpenAI theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, createMiddleware } from "langchain";
import { StateSchema } from "@langchain/langgraph";
import * as z from "zod";

const MyState = new StateSchema({
  userId: z.string(),
  callCount: z.number().default(0),
});

const stateMiddleware = createMiddleware({
  name: "StateExtension",
  stateSchema: MyState, // [!code highlight]
});

const agent = createAgent({
  model: "openai:gpt-5.5",
  tools: [],
  middleware: [stateMiddleware],
});
```

```ts Anthropic theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, createMiddleware } from "langchain";
import { StateSchema } from "@langchain/langgraph";
import * as z from "zod";

const MyState = new StateSchema({
  userId: z.string(),
  callCount: z.number().default(0),
});

const stateMiddleware = createMiddleware({
  name: "StateExtension",
  stateSchema: MyState, // [!code highlight]
});

const agent = createAgent({
  model: "anthropic:claude-sonnet-5",
  tools: [],
  middleware: [stateMiddleware],
});
```

```ts OpenRouter theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, createMiddleware } from "langchain";
import { StateSchema } from "@langchain/langgraph";
import * as z from "zod";

const MyState = new StateSchema({
  userId: z.string(),
  callCount: z.number().default(0),
});

const stateMiddleware = createMiddleware({
  name: "StateExtension",
  stateSchema: MyState, // [!code highlight]
});

const agent = createAgent({
  model: "openrouter:z-ai/glm-5.2",
  tools: [],
  middleware: [stateMiddleware],
});
```

```ts Fireworks theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, createMiddleware } from "langchain";
import { StateSchema } from "@langchain/langgraph";
import * as z from "zod";

const MyState = new StateSchema({
  userId: z.string(),
  callCount: z.number().default(0),
});

const stateMiddleware = createMiddleware({
  name: "StateExtension",
  stateSchema: MyState, // [!code highlight]
});

const agent = createAgent({
  model: "fireworks:accounts/fireworks/models/glm-5p2",
  tools: [],
  middleware: [stateMiddleware],
});
```

```ts Baseten theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, createMiddleware } from "langchain";
import { StateSchema } from "@langchain/langgraph";
import * as z from "zod";

const MyState = new StateSchema({
  userId: z.string(),
  callCount: z.number().default(0),
});

const stateMiddleware = createMiddleware({
  name: "StateExtension",
  stateSchema: MyState, // [!code highlight]
});

const agent = createAgent({
  model: "baseten:zai-org/GLM-5.2",
  tools: [],
  middleware: [stateMiddleware],
});
```

```ts Ollama theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, createMiddleware } from "langchain";
import { StateSchema } from "@langchain/langgraph";
import * as z from "zod";

const MyState = new StateSchema({
  userId: z.string(),
  callCount: z.number().default(0),
});

const stateMiddleware = createMiddleware({
  name: "StateExtension",
  stateSchema: MyState, // [!code highlight]
});

const agent = createAgent({
  model: "ollama:north-mini-code-1.0",
  tools: [],
  middleware: [stateMiddleware],
});
```

For full details, examples, and middleware-level state schemas, see [Short-term memory](https://docs.langchain.com/oss/javascript/langchain/short-term-memory.md#customizing-agent-memory) and [Custom middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/custom.md#state-updates).

## Invocation

> [!TIP]
>
> Trace each step of this loop, debug tool calls, and evaluate agent outputs with [LangSmith](https://smith.langchain.com?utm_source=docs\&utm_medium=cta\&utm_campaign=langsmith-signup\&utm_content=oss-langchain-agents). Follow the [tracing quickstart](https://docs.langchain.com/langsmith/trace-with-langchain.md) to get set up. We recommend you also set up [LangSmith Engine](https://docs.langchain.com/langsmith/engine.md) which monitors your traces, detects issues, and proposes fixes.

You can invoke an agent with a message. Behind the scenes that passes an update to the agent's [`State`](https://docs.langchain.com/oss/javascript/langgraph/graph-api#state). All agents include a [sequence of messages](https://docs.langchain.com/oss/javascript/langgraph/use-graph-api.md#messagesvalue) in their state; to invoke the agent, pass a new message along with a `thread_id` so the agent can persist and resume conversation history:

```ts Google theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { AIMessage } from "@langchain/core/messages";
import { uuid7 } from "langsmith";
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";

const agent = createAgent({
  model: "google:gemini-3.6-flash",
  tools: [],
  checkpointer: new MemorySaver(),
});

const config = { configurable: { thread_id: uuid7() } };

let result = await agent.invoke(
  {
    messages: [
      { role: "user", content: "What's the weather in San Francisco?" },
    ],
  },
  config,
);

// A follow-up turn on the same conversation: reuse the same thread_id to keep history
result = await agent.invoke(
  { messages: [{ role: "user", content: "What about tomorrow?" }] },
  config,
);
```

```ts OpenAI theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { AIMessage } from "@langchain/core/messages";
import { uuid7 } from "langsmith";
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";

const agent = createAgent({
  model: "openai:gpt-5.5",
  tools: [],
  checkpointer: new MemorySaver(),
});

const config = { configurable: { thread_id: uuid7() } };

let result = await agent.invoke(
  {
    messages: [
      { role: "user", content: "What's the weather in San Francisco?" },
    ],
  },
  config,
);

// A follow-up turn on the same conversation: reuse the same thread_id to keep history
result = await agent.invoke(
  { messages: [{ role: "user", content: "What about tomorrow?" }] },
  config,
);
```

```ts Anthropic theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { AIMessage } from "@langchain/core/messages";
import { uuid7 } from "langsmith";
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";

const agent = createAgent({
  model: "anthropic:claude-sonnet-5",
  tools: [],
  checkpointer: new MemorySaver(),
});

const config = { configurable: { thread_id: uuid7() } };

let result = await agent.invoke(
  {
    messages: [
      { role: "user", content: "What's the weather in San Francisco?" },
    ],
  },
  config,
);

// A follow-up turn on the same conversation: reuse the same thread_id to keep history
result = await agent.invoke(
  { messages: [{ role: "user", content: "What about tomorrow?" }] },
  config,
);
```

```ts OpenRouter theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { AIMessage } from "@langchain/core/messages";
import { uuid7 } from "langsmith";
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";

const agent = createAgent({
  model: "openrouter:z-ai/glm-5.2",
  tools: [],
  checkpointer: new MemorySaver(),
});

const config = { configurable: { thread_id: uuid7() } };

let result = await agent.invoke(
  {
    messages: [
      { role: "user", content: "What's the weather in San Francisco?" },
    ],
  },
  config,
);

// A follow-up turn on the same conversation: reuse the same thread_id to keep history
result = await agent.invoke(
  { messages: [{ role: "user", content: "What about tomorrow?" }] },
  config,
);
```

```ts Fireworks theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { AIMessage } from "@langchain/core/messages";
import { uuid7 } from "langsmith";
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";

const agent = createAgent({
  model: "fireworks:accounts/fireworks/models/glm-5p2",
  tools: [],
  checkpointer: new MemorySaver(),
});

const config = { configurable: { thread_id: uuid7() } };

let result = await agent.invoke(
  {
    messages: [
      { role: "user", content: "What's the weather in San Francisco?" },
    ],
  },
  config,
);

// A follow-up turn on the same conversation: reuse the same thread_id to keep history
result = await agent.invoke(
  { messages: [{ role: "user", content: "What about tomorrow?" }] },
  config,
);
```

```ts Baseten theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { AIMessage } from "@langchain/core/messages";
import { uuid7 } from "langsmith";
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";

const agent = createAgent({
  model: "baseten:zai-org/GLM-5.2",
  tools: [],
  checkpointer: new MemorySaver(),
});

const config = { configurable: { thread_id: uuid7() } };

let result = await agent.invoke(
  {
    messages: [
      { role: "user", content: "What's the weather in San Francisco?" },
    ],
  },
  config,
);

// A follow-up turn on the same conversation: reuse the same thread_id to keep history
result = await agent.invoke(
  { messages: [{ role: "user", content: "What about tomorrow?" }] },
  config,
);
```

```ts Ollama theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { AIMessage } from "@langchain/core/messages";
import { uuid7 } from "langsmith";
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";

const agent = createAgent({
  model: "ollama:north-mini-code-1.0",
  tools: [],
  checkpointer: new MemorySaver(),
});

const config = { configurable: { thread_id: uuid7() } };

let result = await agent.invoke(
  {
    messages: [
      { role: "user", content: "What's the weather in San Francisco?" },
    ],
  },
  config,
);

// A follow-up turn on the same conversation: reuse the same thread_id to keep history
result = await agent.invoke(
  { messages: [{ role: "user", content: "What about tomorrow?" }] },
  config,
);
```

> [card] [View example trace](https://smith.langchain.com/public/6fa3df5b-9637-4afc-8c5d-90eaddc9ef87/r)
>
> Open a public LangSmith run for this example.

> [!NOTE]
>
> Persisting conversation history with `thread_id` requires the agent to be configured with a [checkpointer](https://docs.langchain.com/oss/javascript/langchain/long-term-memory.md). When deployed on [LangSmith](https://docs.langchain.com/langsmith/deployment.md), a checkpointer is provisioned automatically. Locally, pass one explicitly, for example `create_agent(..., checkpointer=InMemorySaver())`.

If you also need to pass per-run configuration (such as a user ID, API keys, or feature flags) to tools and middleware, pass it as `context` alongside the config. Define the shape of that data with `contextSchema` and access it through `runtime.context`:

```ts Google theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import * as z from "zod";
import { uuid7 } from "langsmith";
import { AIMessage } from "@langchain/core/messages";
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";

const contextSchema = z.object({
  user_id: z.string(),
});

const agent = createAgent({
  model: "google:gemini-3.6-flash",
  tools: [],
  contextSchema,
  checkpointer: new MemorySaver(),
});

const result = await agent.invoke(
  {
    messages: [
      { role: "user", content: "What's the weather in San Francisco?" },
    ],
  },
  {
    configurable: { thread_id: uuid7() },
    context: { user_id: "user-123" },
  },
);
```

```ts OpenAI theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import * as z from "zod";
import { uuid7 } from "langsmith";
import { AIMessage } from "@langchain/core/messages";
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";

const contextSchema = z.object({
  user_id: z.string(),
});

const agent = createAgent({
  model: "openai:gpt-5.5",
  tools: [],
  contextSchema,
  checkpointer: new MemorySaver(),
});

const result = await agent.invoke(
  {
    messages: [
      { role: "user", content: "What's the weather in San Francisco?" },
    ],
  },
  {
    configurable: { thread_id: uuid7() },
    context: { user_id: "user-123" },
  },
);
```

```ts Anthropic theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import * as z from "zod";
import { uuid7 } from "langsmith";
import { AIMessage } from "@langchain/core/messages";
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";

const contextSchema = z.object({
  user_id: z.string(),
});

const agent = createAgent({
  model: "anthropic:claude-sonnet-5",
  tools: [],
  contextSchema,
  checkpointer: new MemorySaver(),
});

const result = await agent.invoke(
  {
    messages: [
      { role: "user", content: "What's the weather in San Francisco?" },
    ],
  },
  {
    configurable: { thread_id: uuid7() },
    context: { user_id: "user-123" },
  },
);
```

```ts OpenRouter theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import * as z from "zod";
import { uuid7 } from "langsmith";
import { AIMessage } from "@langchain/core/messages";
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";

const contextSchema = z.object({
  user_id: z.string(),
});

const agent = createAgent({
  model: "openrouter:z-ai/glm-5.2",
  tools: [],
  contextSchema,
  checkpointer: new MemorySaver(),
});

const result = await agent.invoke(
  {
    messages: [
      { role: "user", content: "What's the weather in San Francisco?" },
    ],
  },
  {
    configurable: { thread_id: uuid7() },
    context: { user_id: "user-123" },
  },
);
```

```ts Fireworks theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import * as z from "zod";
import { uuid7 } from "langsmith";
import { AIMessage } from "@langchain/core/messages";
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";

const contextSchema = z.object({
  user_id: z.string(),
});

const agent = createAgent({
  model: "fireworks:accounts/fireworks/models/glm-5p2",
  tools: [],
  contextSchema,
  checkpointer: new MemorySaver(),
});

const result = await agent.invoke(
  {
    messages: [
      { role: "user", content: "What's the weather in San Francisco?" },
    ],
  },
  {
    configurable: { thread_id: uuid7() },
    context: { user_id: "user-123" },
  },
);
```

```ts Baseten theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import * as z from "zod";
import { uuid7 } from "langsmith";
import { AIMessage } from "@langchain/core/messages";
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";

const contextSchema = z.object({
  user_id: z.string(),
});

const agent = createAgent({
  model: "baseten:zai-org/GLM-5.2",
  tools: [],
  contextSchema,
  checkpointer: new MemorySaver(),
});

const result = await agent.invoke(
  {
    messages: [
      { role: "user", content: "What's the weather in San Francisco?" },
    ],
  },
  {
    configurable: { thread_id: uuid7() },
    context: { user_id: "user-123" },
  },
);
```

```ts Ollama theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import * as z from "zod";
import { uuid7 } from "langsmith";
import { AIMessage } from "@langchain/core/messages";
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";

const contextSchema = z.object({
  user_id: z.string(),
});

const agent = createAgent({
  model: "ollama:north-mini-code-1.0",
  tools: [],
  contextSchema,
  checkpointer: new MemorySaver(),
});

const result = await agent.invoke(
  {
    messages: [
      { role: "user", content: "What's the weather in San Francisco?" },
    ],
  },
  {
    configurable: { thread_id: uuid7() },
    context: { user_id: "user-123" },
  },
);
```

> [card] [View example trace](https://smith.langchain.com/public/9a9908d5-1083-4419-a89f-8b580668a54a/r)
>
> Open a public LangSmith run for this example.

`thread_id` scopes the *conversation* (message history, checkpoints), while `context` carries *per-run* data your tools and middleware read at invocation time. Both are commonly passed together. See [tool context](https://docs.langchain.com/oss/javascript/langchain/tools.md#context) and [Runtime](https://docs.langchain.com/oss/javascript/langchain/runtime.md) for more.

## Streaming

`invoke` returns the final response at the end of a run. If an agent executes multiple tool calls, users often need progress updates before completion. Use streaming to surface intermediate messages and tool activity as they happen.

```ts theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
const stream = await agent.streamEvents(
  {
    messages: [
      {
        role: "user",
        content: "Search for AI news and summarize the findings",
      },
    ],
  },
  { version: "v3" },
);

for await (const snapshot of stream.values) {
  // Each snapshot contains the full state at that point
  const latestMessage = snapshot.messages.at(-1);
  if (latestMessage?.content) {
    if (latestMessage.type === "human") {
      console.log(`User: ${latestMessage.content}`);
    } else if (latestMessage.type === "ai") {
      console.log(`Agent: ${latestMessage.content}`);
    }
  } else if (latestMessage?.tool_calls?.length) {
    const toolCallNames = latestMessage.tool_calls.map((tc) => tc.name);
    console.log(`Calling tools: ${toolCallNames.join(", ")}`);
  }
}
```

> [card] [View example trace](https://smith.langchain.com/public/26cab1f9-7af5-40b4-8e4d-156564142bd8/r)
>
> Open a public LangSmith run for this example.

> [!TIP]
>
> For streaming modes, event types, and UI patterns, see [Streaming](https://docs.langchain.com/oss/javascript/langchain/streaming.md).

## Configure the harness

`create_agent` is highly extensible. Middleware is the primitive for customization: each piece handles one concern, hooks into the agent loop at the right moment, and composes freely with any other. Take exactly what your use case needs and skip the rest.

Common patterns are prebuilt as first-class middleware. You can build anything else as [custom middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/custom.md).

![Agent harness capabilities by category](https://mintcdn.com/langchain-5e9cc07a/jtty0O--UJOKG0nK/oss/images/agent_harness_capabilities.svg?fit=max\&auto=format\&n=jtty0O--UJOKG0nK\&q=85\&s=0ff671d72badd0844826660dfcb04391)

As agents take on complex work, they need support across a few key areas. The middleware ecosystem provides:

> [card] [Execution environment](#execution-environment)
>
> Tools, filesystem, sandboxes, and code execution

> [card] [Context management](#context-management)
>
> Summarization, memory, skills, and prompt caching

> [card] [Planning and delegation](#planning-and-delegation)
>
> Todo lists and subagents for parallel, isolated work

> [card] [Fault tolerance](#fault-tolerance)
>
> Retries, fallbacks, and call limits

> [card] [Guardrails](#guardrails)
>
> PII detection and content controls

> [card] [Steering](#steering)
>
> Human-in-the-loop approval before high-impact actions

> [!TIP]
>
> `create_deep_agent` pre-assembles this stack for long-running coding and research tasks (filesystem, summarization, subagents, and prompt caching included by default). See [Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/harness.md) for the full prebuilt harness.

### Execution environment

Agents are especially useful when they can take action rather than just generate text. The execution environment gives the agent a workspace: tools it can call, a filesystem for reading and writing files across turns, and code execution for running scripts or shell commands.

```ts Google theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";
import { createFilesystemMiddleware, StateBackend } from "deepagents";

var agent = createAgent({
  model: "google:gemini-3.6-flash",
  tools: [search],
  middleware: [createFilesystemMiddleware({ backend: new StateBackend() })],
});
```

```ts OpenAI theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";
import { createFilesystemMiddleware, StateBackend } from "deepagents";

var agent = createAgent({
  model: "openai:gpt-5.5",
  tools: [search],
  middleware: [createFilesystemMiddleware({ backend: new StateBackend() })],
});
```

```ts Anthropic theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";
import { createFilesystemMiddleware, StateBackend } from "deepagents";

var agent = createAgent({
  model: "anthropic:claude-sonnet-5",
  tools: [search],
  middleware: [createFilesystemMiddleware({ backend: new StateBackend() })],
});
```

```ts OpenRouter theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";
import { createFilesystemMiddleware, StateBackend } from "deepagents";

var agent = createAgent({
  model: "openrouter:z-ai/glm-5.2",
  tools: [search],
  middleware: [createFilesystemMiddleware({ backend: new StateBackend() })],
});
```

```ts Fireworks theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";
import { createFilesystemMiddleware, StateBackend } from "deepagents";

var agent = createAgent({
  model: "fireworks:accounts/fireworks/models/glm-5p2",
  tools: [search],
  middleware: [createFilesystemMiddleware({ backend: new StateBackend() })],
});
```

```ts Baseten theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";
import { createFilesystemMiddleware, StateBackend } from "deepagents";

var agent = createAgent({
  model: "baseten:zai-org/GLM-5.2",
  tools: [search],
  middleware: [createFilesystemMiddleware({ backend: new StateBackend() })],
});
```

```ts Ollama theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";
import { createFilesystemMiddleware, StateBackend } from "deepagents";

var agent = createAgent({
  model: "ollama:north-mini-code-1.0",
  tools: [search],
  middleware: [createFilesystemMiddleware({ backend: new StateBackend() })],
});
```

See [`FilesystemMiddleware`](https://reference.langchain.com/javascript/deepagents/middleware/createFilesystemMiddleware), [Sandboxes](https://docs.langchain.com/oss/javascript/deepagents/sandboxes.md), [Interpreters](https://docs.langchain.com/oss/javascript/deepagents/interpreters.md).

> [!NOTE]
>
> This example imports from the `deepagents` package. Install it with:
>
> ```bash npm theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
> npm install deepagents
> ```
>
> ```bash yarn theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
> yarn add deepagents
> ```
>
> ```bash pnpm theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
> pnpm add deepagents
> ```

### Context management

Every model call has a fixed context window. As an agent runs, that window fills with accumulating history, tool results, and intermediate steps. Summarization compresses history before overflow hits; memory loads persistent instructions at startup so knowledge carries across sessions; skills surface domain knowledge on demand rather than loading everything upfront.

```ts Google theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";
import {
  StateBackend,
  createFilesystemMiddleware,
  createSkillsMiddleware,
  createSummarizationMiddleware,
} from "deepagents";

var backend = new StateBackend();
const model = "google:gemini-3.6-flash";

var agent = createAgent({
  model,
  tools: [search],
  middleware: [
    createFilesystemMiddleware({ backend }),
    createSummarizationMiddleware({ model, backend }),
    createSkillsMiddleware({ backend, sources: ["./skills/"] }),
  ],
});
```

```ts OpenAI theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";
import {
  StateBackend,
  createFilesystemMiddleware,
  createSkillsMiddleware,
  createSummarizationMiddleware,
} from "deepagents";

var backend = new StateBackend();
const model = "openai:gpt-5.5";

var agent = createAgent({
  model,
  tools: [search],
  middleware: [
    createFilesystemMiddleware({ backend }),
    createSummarizationMiddleware({ model, backend }),
    createSkillsMiddleware({ backend, sources: ["./skills/"] }),
  ],
});
```

```ts Anthropic theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";
import {
  StateBackend,
  createFilesystemMiddleware,
  createSkillsMiddleware,
  createSummarizationMiddleware,
} from "deepagents";

var backend = new StateBackend();
const model = "anthropic:claude-sonnet-5";

var agent = createAgent({
  model,
  tools: [search],
  middleware: [
    createFilesystemMiddleware({ backend }),
    createSummarizationMiddleware({ model, backend }),
    createSkillsMiddleware({ backend, sources: ["./skills/"] }),
  ],
});
```

```ts OpenRouter theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";
import {
  StateBackend,
  createFilesystemMiddleware,
  createSkillsMiddleware,
  createSummarizationMiddleware,
} from "deepagents";

var backend = new StateBackend();
const model = "openrouter:z-ai/glm-5.2";

var agent = createAgent({
  model,
  tools: [search],
  middleware: [
    createFilesystemMiddleware({ backend }),
    createSummarizationMiddleware({ model, backend }),
    createSkillsMiddleware({ backend, sources: ["./skills/"] }),
  ],
});
```

```ts Fireworks theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";
import {
  StateBackend,
  createFilesystemMiddleware,
  createSkillsMiddleware,
  createSummarizationMiddleware,
} from "deepagents";

var backend = new StateBackend();
const model = "fireworks:accounts/fireworks/models/glm-5p2";

var agent = createAgent({
  model,
  tools: [search],
  middleware: [
    createFilesystemMiddleware({ backend }),
    createSummarizationMiddleware({ model, backend }),
    createSkillsMiddleware({ backend, sources: ["./skills/"] }),
  ],
});
```

```ts Baseten theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";
import {
  StateBackend,
  createFilesystemMiddleware,
  createSkillsMiddleware,
  createSummarizationMiddleware,
} from "deepagents";

var backend = new StateBackend();
const model = "baseten:zai-org/GLM-5.2";

var agent = createAgent({
  model,
  tools: [search],
  middleware: [
    createFilesystemMiddleware({ backend }),
    createSummarizationMiddleware({ model, backend }),
    createSkillsMiddleware({ backend, sources: ["./skills/"] }),
  ],
});
```

```ts Ollama theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent } from "langchain";
import {
  StateBackend,
  createFilesystemMiddleware,
  createSkillsMiddleware,
  createSummarizationMiddleware,
} from "deepagents";

var backend = new StateBackend();
const model = "ollama:north-mini-code-1.0";

var agent = createAgent({
  model,
  tools: [search],
  middleware: [
    createFilesystemMiddleware({ backend }),
    createSummarizationMiddleware({ model, backend }),
    createSkillsMiddleware({ backend, sources: ["./skills/"] }),
  ],
});
```

See [`SummarizationMiddleware`](https://reference.langchain.com/javascript/langchain/index/summarizationMiddleware), [`MemoryMiddleware`](https://reference.langchain.com/javascript/deepagents/middleware/createMemoryMiddleware), [Skills](https://docs.langchain.com/oss/javascript/langchain/multi-agent/skills.md), [Context engineering](https://docs.langchain.com/oss/javascript/deepagents/context-engineering.md).

> [!NOTE]
>
> This example imports from the `deepagents` package. Install it with:
>
> ```bash npm theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
> npm install deepagents
> ```
>
> ```bash yarn theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
> yarn add deepagents
> ```
>
> ```bash pnpm theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
> pnpm add deepagents
> ```

### Planning and delegation

Complex tasks often exceed what one context window can handle. Delegation lets the main agent break work into pieces, hand them to subagents that each run in their own isolated context, and stay focused on coordination rather than execution. Work can run in parallel; the main agent's context stays clean.

```ts Google theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, todoListMiddleware, tool } from "langchain";
import {
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  StateBackend,
} from "deepagents";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var backend = new StateBackend();

var agent = createAgent({
  model: "google:gemini-3.6-flash",
  tools: [search],
  middleware: [
    createFilesystemMiddleware({ backend }),
    todoListMiddleware(),
    createSubAgentMiddleware({
      defaultModel: "anthropic:claude-sonnet-4-6",
      defaultTools: [],
      subagents: [
        {
          name: "researcher",
          description: "Searches and returns a structured summary.",
          systemPrompt:
            "Use the search tool to research the question and summarize key points.",
          tools: [search],
          model: "google:gemini-3.6-flash",
          middleware: [],
        },
      ],
    }),
  ],
});
```

```ts OpenAI theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, todoListMiddleware, tool } from "langchain";
import {
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  StateBackend,
} from "deepagents";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var backend = new StateBackend();

var agent = createAgent({
  model: "openai:gpt-5.5",
  tools: [search],
  middleware: [
    createFilesystemMiddleware({ backend }),
    todoListMiddleware(),
    createSubAgentMiddleware({
      defaultModel: "anthropic:claude-sonnet-4-6",
      defaultTools: [],
      subagents: [
        {
          name: "researcher",
          description: "Searches and returns a structured summary.",
          systemPrompt:
            "Use the search tool to research the question and summarize key points.",
          tools: [search],
          model: "openai:gpt-5.5",
          middleware: [],
        },
      ],
    }),
  ],
});
```

```ts Anthropic theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, todoListMiddleware, tool } from "langchain";
import {
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  StateBackend,
} from "deepagents";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var backend = new StateBackend();

var agent = createAgent({
  model: "anthropic:claude-sonnet-5",
  tools: [search],
  middleware: [
    createFilesystemMiddleware({ backend }),
    todoListMiddleware(),
    createSubAgentMiddleware({
      defaultModel: "anthropic:claude-sonnet-4-6",
      defaultTools: [],
      subagents: [
        {
          name: "researcher",
          description: "Searches and returns a structured summary.",
          systemPrompt:
            "Use the search tool to research the question and summarize key points.",
          tools: [search],
          model: "anthropic:claude-sonnet-5",
          middleware: [],
        },
      ],
    }),
  ],
});
```

```ts OpenRouter theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, todoListMiddleware, tool } from "langchain";
import {
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  StateBackend,
} from "deepagents";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var backend = new StateBackend();

var agent = createAgent({
  model: "openrouter:z-ai/glm-5.2",
  tools: [search],
  middleware: [
    createFilesystemMiddleware({ backend }),
    todoListMiddleware(),
    createSubAgentMiddleware({
      defaultModel: "anthropic:claude-sonnet-4-6",
      defaultTools: [],
      subagents: [
        {
          name: "researcher",
          description: "Searches and returns a structured summary.",
          systemPrompt:
            "Use the search tool to research the question and summarize key points.",
          tools: [search],
          model: "openrouter:z-ai/glm-5.2",
          middleware: [],
        },
      ],
    }),
  ],
});
```

```ts Fireworks theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, todoListMiddleware, tool } from "langchain";
import {
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  StateBackend,
} from "deepagents";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var backend = new StateBackend();

var agent = createAgent({
  model: "fireworks:accounts/fireworks/models/glm-5p2",
  tools: [search],
  middleware: [
    createFilesystemMiddleware({ backend }),
    todoListMiddleware(),
    createSubAgentMiddleware({
      defaultModel: "anthropic:claude-sonnet-4-6",
      defaultTools: [],
      subagents: [
        {
          name: "researcher",
          description: "Searches and returns a structured summary.",
          systemPrompt:
            "Use the search tool to research the question and summarize key points.",
          tools: [search],
          model: "fireworks:accounts/fireworks/models/glm-5p2",
          middleware: [],
        },
      ],
    }),
  ],
});
```

```ts Baseten theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, todoListMiddleware, tool } from "langchain";
import {
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  StateBackend,
} from "deepagents";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var backend = new StateBackend();

var agent = createAgent({
  model: "baseten:zai-org/GLM-5.2",
  tools: [search],
  middleware: [
    createFilesystemMiddleware({ backend }),
    todoListMiddleware(),
    createSubAgentMiddleware({
      defaultModel: "anthropic:claude-sonnet-4-6",
      defaultTools: [],
      subagents: [
        {
          name: "researcher",
          description: "Searches and returns a structured summary.",
          systemPrompt:
            "Use the search tool to research the question and summarize key points.",
          tools: [search],
          model: "baseten:zai-org/GLM-5.2",
          middleware: [],
        },
      ],
    }),
  ],
});
```

```ts Ollama theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, todoListMiddleware, tool } from "langchain";
import {
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  StateBackend,
} from "deepagents";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var backend = new StateBackend();

var agent = createAgent({
  model: "ollama:north-mini-code-1.0",
  tools: [search],
  middleware: [
    createFilesystemMiddleware({ backend }),
    todoListMiddleware(),
    createSubAgentMiddleware({
      defaultModel: "anthropic:claude-sonnet-4-6",
      defaultTools: [],
      subagents: [
        {
          name: "researcher",
          description: "Searches and returns a structured summary.",
          systemPrompt:
            "Use the search tool to research the question and summarize key points.",
          tools: [search],
          model: "ollama:north-mini-code-1.0",
          middleware: [],
        },
      ],
    }),
  ],
});
```

See [Subagents](https://docs.langchain.com/oss/javascript/langchain/multi-agent/subagents.md).

> [!NOTE]
>
> This example imports from the `deepagents` package. Install it with:
>
> ```bash npm theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
> npm install deepagents
> ```
>
> ```bash yarn theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
> yarn add deepagents
> ```
>
> ```bash pnpm theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
> pnpm add deepagents
> ```

### Name your agent

Optionally use an identifier for the agent. This is especially useful when embedding the agent as a subgraph in [multi-agent](https://docs.langchain.com/oss/javascript/langchain/multi-agent.md) systems.

```ts Google theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
var agent = createAgent({
  model: "google:gemini-3.6-flash",
  tools,
  name: "research_assistant",
});
```

```ts OpenAI theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
var agent = createAgent({
  model: "openai:gpt-5.5",
  tools,
  name: "research_assistant",
});
```

```ts Anthropic theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
var agent = createAgent({
  model: "anthropic:claude-sonnet-5",
  tools,
  name: "research_assistant",
});
```

```ts OpenRouter theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
var agent = createAgent({
  model: "openrouter:z-ai/glm-5.2",
  tools,
  name: "research_assistant",
});
```

```ts Fireworks theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
var agent = createAgent({
  model: "fireworks:accounts/fireworks/models/glm-5p2",
  tools,
  name: "research_assistant",
});
```

```ts Baseten theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
var agent = createAgent({
  model: "baseten:zai-org/GLM-5.2",
  tools,
  name: "research_assistant",
});
```

```ts Ollama theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
var agent = createAgent({
  model: "ollama:north-mini-code-1.0",
  tools,
  name: "research_assistant",
});
```

### Fault tolerance

Agents in production encounter failures that rarely appear in development: rate limits, model timeouts, transient API errors. Fault tolerance middleware handles these at the infrastructure level so your tools and business logic don't need try/catch around every call.

```ts Google theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import {
  createAgent,
  modelRetryMiddleware,
  tool,
  toolRetryMiddleware,
} from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({
  model: "google:gemini-3.6-flash",
  tools: [search],
  middleware: [
    modelRetryMiddleware({ maxRetries: 3 }),
    toolRetryMiddleware({ maxRetries: 2 }),
  ],
});
```

```ts OpenAI theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import {
  createAgent,
  modelRetryMiddleware,
  tool,
  toolRetryMiddleware,
} from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({
  model: "openai:gpt-5.5",
  tools: [search],
  middleware: [
    modelRetryMiddleware({ maxRetries: 3 }),
    toolRetryMiddleware({ maxRetries: 2 }),
  ],
});
```

```ts Anthropic theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import {
  createAgent,
  modelRetryMiddleware,
  tool,
  toolRetryMiddleware,
} from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({
  model: "anthropic:claude-sonnet-5",
  tools: [search],
  middleware: [
    modelRetryMiddleware({ maxRetries: 3 }),
    toolRetryMiddleware({ maxRetries: 2 }),
  ],
});
```

```ts OpenRouter theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import {
  createAgent,
  modelRetryMiddleware,
  tool,
  toolRetryMiddleware,
} from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({
  model: "openrouter:z-ai/glm-5.2",
  tools: [search],
  middleware: [
    modelRetryMiddleware({ maxRetries: 3 }),
    toolRetryMiddleware({ maxRetries: 2 }),
  ],
});
```

```ts Fireworks theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import {
  createAgent,
  modelRetryMiddleware,
  tool,
  toolRetryMiddleware,
} from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({
  model: "fireworks:accounts/fireworks/models/glm-5p2",
  tools: [search],
  middleware: [
    modelRetryMiddleware({ maxRetries: 3 }),
    toolRetryMiddleware({ maxRetries: 2 }),
  ],
});
```

```ts Baseten theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import {
  createAgent,
  modelRetryMiddleware,
  tool,
  toolRetryMiddleware,
} from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({
  model: "baseten:zai-org/GLM-5.2",
  tools: [search],
  middleware: [
    modelRetryMiddleware({ maxRetries: 3 }),
    toolRetryMiddleware({ maxRetries: 2 }),
  ],
});
```

```ts Ollama theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import {
  createAgent,
  modelRetryMiddleware,
  tool,
  toolRetryMiddleware,
} from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({
  model: "ollama:north-mini-code-1.0",
  tools: [search],
  middleware: [
    modelRetryMiddleware({ maxRetries: 3 }),
    toolRetryMiddleware({ maxRetries: 2 }),
  ],
});
```

See [`modelRetryMiddleware`](https://reference.langchain.com/javascript/langchain/index/modelRetryMiddleware), [`toolRetryMiddleware`](https://reference.langchain.com/javascript/langchain/index/toolRetryMiddleware), [Prebuilt middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/built-in.md).

### Guardrails

Some policies can't live in a prompt—they need to be enforced deterministically regardless of what the model does. Guardrails intercept data as it flows through the agent loop, applying compliance rules or content policies before tool results reach the model's context.

```ts Google theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, piiMiddleware, tool } from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({
  model: "google:gemini-3.6-flash",
  tools: [search],
  middleware: [piiMiddleware("email")],
});
```

```ts OpenAI theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, piiMiddleware, tool } from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({
  model: "openai:gpt-5.5",
  tools: [search],
  middleware: [piiMiddleware("email")],
});
```

```ts Anthropic theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, piiMiddleware, tool } from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({
  model: "anthropic:claude-sonnet-5",
  tools: [search],
  middleware: [piiMiddleware("email")],
});
```

```ts OpenRouter theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, piiMiddleware, tool } from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({
  model: "openrouter:z-ai/glm-5.2",
  tools: [search],
  middleware: [piiMiddleware("email")],
});
```

```ts Fireworks theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, piiMiddleware, tool } from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({
  model: "fireworks:accounts/fireworks/models/glm-5p2",
  tools: [search],
  middleware: [piiMiddleware("email")],
});
```

```ts Baseten theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, piiMiddleware, tool } from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({
  model: "baseten:zai-org/GLM-5.2",
  tools: [search],
  middleware: [piiMiddleware("email")],
});
```

```ts Ollama theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, piiMiddleware, tool } from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({
  model: "ollama:north-mini-code-1.0",
  tools: [search],
  middleware: [piiMiddleware("email")],
});
```

See [`piiMiddleware`](https://reference.langchain.com/javascript/langchain/index/piiMiddleware), [Prebuilt middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/built-in.md).

### Steering

Full autonomy isn't always appropriate. Steering lets you place humans at specific decision points—before destructive writes, expensive API calls, or anything requiring judgment—without restructuring your agent. The agent pauses and waits; a human approves, edits, or rejects; execution continues.

```ts Google theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({
  model: "google:gemini-3.6-flash",
  tools: [search],
  middleware: [humanInTheLoopMiddleware({ interruptOn: { writeFile: true } })],
});
```

```ts OpenAI theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({
  model: "openai:gpt-5.5",
  tools: [search],
  middleware: [humanInTheLoopMiddleware({ interruptOn: { writeFile: true } })],
});
```

```ts Anthropic theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({
  model: "anthropic:claude-sonnet-5",
  tools: [search],
  middleware: [humanInTheLoopMiddleware({ interruptOn: { writeFile: true } })],
});
```

```ts OpenRouter theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({
  model: "openrouter:z-ai/glm-5.2",
  tools: [search],
  middleware: [humanInTheLoopMiddleware({ interruptOn: { writeFile: true } })],
});
```

```ts Fireworks theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({
  model: "fireworks:accounts/fireworks/models/glm-5p2",
  tools: [search],
  middleware: [humanInTheLoopMiddleware({ interruptOn: { writeFile: true } })],
});
```

```ts Baseten theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({
  model: "baseten:zai-org/GLM-5.2",
  tools: [search],
  middleware: [humanInTheLoopMiddleware({ interruptOn: { writeFile: true } })],
});
```

```ts Ollama theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import * as z from "zod";

var search = tool(({ query }) => `Search results for: ${query}`, {
  name: "search",
  description: "Search for a query and return a short summary.",
  schema: z.object({ query: z.string() }),
});

var agent = createAgent({
  model: "ollama:north-mini-code-1.0",
  tools: [search],
  middleware: [humanInTheLoopMiddleware({ interruptOn: { writeFile: true } })],
});
```

See [`humanInTheLoopMiddleware`](https://reference.langchain.com/javascript/langchain/middleware/humanInTheLoopMiddleware), [Human-in-the-loop](https://docs.langchain.com/oss/javascript/langchain/human-in-the-loop.md).

### Middleware resources

> [card] [Middleware overview](https://docs.langchain.com/oss/javascript/langchain/middleware/overview.md)
>
> How the middleware stack works and when hooks fire

> [card] [Prebuilt middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/built-in.md)
>
> Full reference with configuration examples

> [card] [Custom middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/custom.md)
>
> Write your own hooks for business logic, PII scrubbing, and more

***

[Connect these docs](https://docs.langchain.com/use-these-docs.md) to your agent of choice via MCP for real-time answers.

[Edit this page on GitHub](https://github.com/langchain-ai/docs/edit/main/src/oss/langchain/agents.mdx) or [file an issue](https://github.com/langchain-ai/docs/issues/new/choose).

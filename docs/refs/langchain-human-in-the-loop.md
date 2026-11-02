> ## Documentation Index
> Fetch the complete documentation index at: https://docs.langchain.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Human-in-the-loop

The Human-in-the-Loop (HITL) [middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/built-in.md#human-in-the-loop) lets you add human oversight to agent tool calls.
When a model proposes an action that might require review—for example, writing to a file or executing SQL—the middleware can pause execution and wait for a decision.

It does this by checking each tool call against a configurable policy. If intervention is needed, the middleware issues an [interrupt](https://reference.langchain.com/javascript/langchain-langgraph/index/interrupt) that halts execution. The graph state is saved using LangGraph's [persistence layer](https://docs.langchain.com/oss/javascript/langgraph/persistence.md), so execution can pause safely and resume later.

A human decision then determines what happens next: the action can be approved as-is (`approve`), modified before running (`edit`), rejected with feedback (`reject`), or responded to directly (`respond`) for "ask user" style tools.

## Interrupt decision types

The [middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/built-in.md#human-in-the-loop) defines four built-in ways a human can respond to an interrupt:

| Decision Type | Description | Example Use Case |
| - | - | - |
| ✅ `approve` | Execute the tool with the original arguments as proposed by the agent. | Send an email draft exactly as written |
| ✏️ `edit` | Modify the tool arguments before execution. | Change the recipient before sending an email |
| ❌ `reject` | Skip executing this tool call entirely and return rejection feedback to the agent. | Deny file deletion and explain why |
| 💬 `respond` | Return the human's message directly as a synthetic tool result, skipping execution, for "ask user" style tools. | Answer an `"ask_user"` prompt with a direct reply |

The available decision types for each tool depend on the policy you configure in `interruptOn`.

When multiple tool calls are paused at the same time, each action requires a separate decision.

In the default batched mode, provide decisions in the same order as the actions appear in the interrupt request. In [per-call mode](#pause-once-per-tool-call), each tool call has its own interrupt and takes one decision.

Use `reject` when the human is denying the requested action. Use `respond` only when the human is acting as the tool, such as answering an `ask_user` prompt. Do not use `respond` to deny side-effecting tools, because its message is treated as a successful tool result.

> [!TIP]
>
> When **editing** tool arguments, make changes conservatively. Significant modifications to the original arguments may cause the model to re-evaluate its approach and potentially execute the tool multiple times or take unexpected actions.

## Configuring interrupts

To use HITL, add the [middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/built-in.md#human-in-the-loop) to the agent's `middleware` list when creating the agent.

You configure it with a mapping of tool actions to the decision types that are allowed for each action. The middleware will interrupt execution when a tool call matches an action in the mapping.

This example uses the default batched mode. To pause once per tool call, see [Set the interrupt mode](#set-the-interrupt-mode).

```ts theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, humanInTheLoopMiddleware } from "langchain"; // [!code highlight]
import { MemorySaver } from "@langchain/langgraph"; // [!code highlight]

const agent = createAgent({
    model: "gpt-5.5",
    tools: [writeFileTool, executeSQLTool, readDataTool],
    middleware: [
        humanInTheLoopMiddleware({
            interruptOn: {
                write_file: true, // All decisions (approve, edit, reject, respond) allowed
                execute_sql: {
                    allowedDecisions: ["approve", "reject"],
                    // No editing allowed
                    description: "🚨 SQL execution requires DBA approval",
                },
                // Safe operation, no approval needed
                read_data: false,
            },
            // Prefix for interrupt messages - combined with tool name and args to form the full message
            // e.g., "Tool execution pending approval: execute_sql with query='DELETE FROM...'"
            // Individual tools can override this by specifying a "description" in their interrupt config
            descriptionPrefix: "Tool execution pending approval",
        }),
    ],
    // Human-in-the-loop requires checkpointing to handle interrupts.
    // In production, use a persistent checkpointer like AsyncPostgresSaver or MongoDBSaver.
    checkpointer: new MemorySaver(), // [!code highlight]
});
```

> [!NOTE]
>
> You must configure a checkpointer to persist the graph state across interrupts.
>
> In production, use a persistent checkpointer like [`AsyncPostgresSaver`](https://reference.langchain.com/javascript/langchain-langgraph-checkpoint-postgres/index/PostgresSaver) or [`MongoDBSaver`](https://reference.langchain.com/javascript/langchain-langgraph-checkpoint-mongodb/MongoDBSaver). For testing or prototyping, use [`InMemorySaver`](https://reference.langchain.com/javascript/langchain-langgraph-checkpoint/index/MemorySaver).
>
> When invoking the agent, pass a `config` that includes the **thread ID** to associate execution with a conversation thread.
> See the [LangGraph interrupts documentation](https://docs.langchain.com/oss/javascript/langgraph/interrupts.md) for details.

> [accordion] Configuration options
>
> **interruptOn** `object` *required*
>
> Mapping of tool names to approval configs. Values can be `true` (interrupt with default config), `false` (auto-approve), or an `InterruptOnConfig` object.
>
> **descriptionPrefix** `string` (default: Tool execution requires approval)
>
> Prefix for action request descriptions
>
> **interruptMode** `string` (default: batched)
>
> How the agent pauses for review. `"batched"` raises one interrupt per model turn, answered with an ordered list. `"per_call"` raises one interrupt per gated call, answered by interrupt ID. `"per_call"` requires `langchain>=1.5.18`. See [Set the interrupt mode](#set-the-interrupt-mode).
>
> **editNotice** `string | null`
>
> In per-call mode, text added before the result of a call that a reviewer replaced with an `edit` decision, so the model knows the call changed. Defaults to a note that a human reviewer replaced the call. Pass `null` to add nothing.
>
> **`InterruptOnConfig` options:**
>
> **allowedDecisions** `string[]`
>
> List of allowed decisions: `'approve'`, `'edit'`, `'reject'`, or `'respond'`
>
> **description** `string | callable`
>
> Static string or callable function for custom description
>
> **when** `callable`
>
> Optional predicate that receives a [ToolCallRequest](https://reference.langchain.com/javascript/langchain/index/ToolCallRequest) and returns `true` to interrupt or `false` to auto-approve. Use it to gate interrupts on a call's arguments. Requires `langchain>=1.4.6`.

## Conditional interrupts

By default, every tool call listed in `interruptOn` pauses for review. To pause only some calls, add a `when` predicate to a tool's `InterruptOnConfig`. The predicate receives a `ToolCallRequest` and returns `true` to interrupt or `false` to auto-approve, so you can gate on the tool's arguments.

> [!NOTE]
>
> Conditional interrupts require `langchain>=1.4.6`.

```typescript theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { createAgent, humanInTheLoopMiddleware } from "langchain";
import type { ToolCallRequest } from "langchain";
import { MemorySaver } from "@langchain/langgraph";

// Pause writes to paths outside the workspace directory.
const writesOutsideWorkspace = (request: ToolCallRequest) =>
  !String(request.toolCall.args.path ?? "").startsWith("/workspace/");

// Pause SQL that isn't a read-only SELECT.
const isWriteQuery = (request: ToolCallRequest) =>
  !String(request.toolCall.args.query ?? "")
    .trimStart()
    .toUpperCase()
    .startsWith("SELECT");

const agent = createAgent({
  model: "gpt-5.5",
  tools: [writeFile, executeSql, readData],
  middleware: [
    humanInTheLoopMiddleware({
      interruptOn: {
        write_file: {
          allowedDecisions: ["approve", "edit", "reject"],
          when: writesOutsideWorkspace,
        },
        execute_sql: {
          allowedDecisions: ["approve", "reject"],
          when: isWriteQuery,
        },
      },
    }),
  ],
  checkpointer: new MemorySaver(),
});
```

When the `when` predicate returns `false`, the call runs without interrupting. When it returns `true`, or when you omit `when`, the call pauses as usual. Calls that evaluate to `false` never pause, so a reviewer only sees the actions that need a decision.

The predicate runs again when the agent resumes, so it must return the same result for the same call. If it returns `false` on resume, the tool runs and the reviewer's answer is ignored, even a `reject`. In batched mode, if the result changes for only some of the calls, the middleware throws an error.

## Set the interrupt mode

The middleware pauses in one of two modes, set with `interruptMode`:

* **`"per_call"`**: Each tool call that needs review raises its own interrupt as it starts. Each interrupt carries a [`response_schema`](https://docs.langchain.com/oss/javascript/langgraph/interrupts#define-an-interrupt-response-schema) of the answers it accepts. You answer it with one decision, keyed by the interrupt ID.
* **`"batched"`** (default): One interrupt per model turn lists every call that needs review. You answer with a list of decisions in the same order.

Use per-call mode for new agents. LangChain plans to make it the default in the next major release. For a side-by-side comparison and the problems per-call mode solves, see the [human-in-the-loop overview](https://docs.langchain.com/oss/javascript/concepts/human-in-the-loop.md).

## Pause once per tool call

> [!NOTE]
>
> Per-call interrupts require `langchain>=1.5.18` and `createAgent` version `"v2"`, the default.

Set `interruptMode: "per_call"` to review each tool call separately. This agent gates `write_file` and `execute_sql`, and lets `read_data` run without review:

```ts Google theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { MemorySaver } from "@langchain/langgraph";
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import * as z from "zod";

const writeFile = tool(
  ({ path, content }) => `Wrote ${content.length} characters to ${path}`,
  {
    name: "write_file",
    description: "Write content to a file.",
    schema: z.object({ path: z.string(), content: z.string() }),
  },
);

const executeSql = tool(() => "Deleted 42 rows", {
  name: "execute_sql",
  description: "Run a SQL query.",
  schema: z.object({ query: z.string() }),
});

const readData = tool(({ table }) => `3 rows from ${table}`, {
  name: "read_data",
  description: "Read rows from a table.",
  schema: z.object({ table: z.string() }),
});

let agent = createAgent({
  model: "google:gemini-3.6-flash",
  tools: [writeFile, executeSql, readData],
  middleware: [
    humanInTheLoopMiddleware({
      interruptOn: {
        write_file: true,
        execute_sql: { allowedDecisions: ["approve", "reject"] },
        read_data: false,
      },
      interruptMode: "per_call", // [!code highlight]
    }),
  ],
  checkpointer: new MemorySaver(),
});
```

```ts OpenAI theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { MemorySaver } from "@langchain/langgraph";
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import * as z from "zod";

const writeFile = tool(
  ({ path, content }) => `Wrote ${content.length} characters to ${path}`,
  {
    name: "write_file",
    description: "Write content to a file.",
    schema: z.object({ path: z.string(), content: z.string() }),
  },
);

const executeSql = tool(() => "Deleted 42 rows", {
  name: "execute_sql",
  description: "Run a SQL query.",
  schema: z.object({ query: z.string() }),
});

const readData = tool(({ table }) => `3 rows from ${table}`, {
  name: "read_data",
  description: "Read rows from a table.",
  schema: z.object({ table: z.string() }),
});

let agent = createAgent({
  model: "openai:gpt-5.5",
  tools: [writeFile, executeSql, readData],
  middleware: [
    humanInTheLoopMiddleware({
      interruptOn: {
        write_file: true,
        execute_sql: { allowedDecisions: ["approve", "reject"] },
        read_data: false,
      },
      interruptMode: "per_call", // [!code highlight]
    }),
  ],
  checkpointer: new MemorySaver(),
});
```

```ts Anthropic theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { MemorySaver } from "@langchain/langgraph";
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import * as z from "zod";

const writeFile = tool(
  ({ path, content }) => `Wrote ${content.length} characters to ${path}`,
  {
    name: "write_file",
    description: "Write content to a file.",
    schema: z.object({ path: z.string(), content: z.string() }),
  },
);

const executeSql = tool(() => "Deleted 42 rows", {
  name: "execute_sql",
  description: "Run a SQL query.",
  schema: z.object({ query: z.string() }),
});

const readData = tool(({ table }) => `3 rows from ${table}`, {
  name: "read_data",
  description: "Read rows from a table.",
  schema: z.object({ table: z.string() }),
});

let agent = createAgent({
  model: "anthropic:claude-sonnet-5",
  tools: [writeFile, executeSql, readData],
  middleware: [
    humanInTheLoopMiddleware({
      interruptOn: {
        write_file: true,
        execute_sql: { allowedDecisions: ["approve", "reject"] },
        read_data: false,
      },
      interruptMode: "per_call", // [!code highlight]
    }),
  ],
  checkpointer: new MemorySaver(),
});
```

```ts OpenRouter theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { MemorySaver } from "@langchain/langgraph";
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import * as z from "zod";

const writeFile = tool(
  ({ path, content }) => `Wrote ${content.length} characters to ${path}`,
  {
    name: "write_file",
    description: "Write content to a file.",
    schema: z.object({ path: z.string(), content: z.string() }),
  },
);

const executeSql = tool(() => "Deleted 42 rows", {
  name: "execute_sql",
  description: "Run a SQL query.",
  schema: z.object({ query: z.string() }),
});

const readData = tool(({ table }) => `3 rows from ${table}`, {
  name: "read_data",
  description: "Read rows from a table.",
  schema: z.object({ table: z.string() }),
});

let agent = createAgent({
  model: "openrouter:z-ai/glm-5.2",
  tools: [writeFile, executeSql, readData],
  middleware: [
    humanInTheLoopMiddleware({
      interruptOn: {
        write_file: true,
        execute_sql: { allowedDecisions: ["approve", "reject"] },
        read_data: false,
      },
      interruptMode: "per_call", // [!code highlight]
    }),
  ],
  checkpointer: new MemorySaver(),
});
```

```ts Fireworks theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { MemorySaver } from "@langchain/langgraph";
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import * as z from "zod";

const writeFile = tool(
  ({ path, content }) => `Wrote ${content.length} characters to ${path}`,
  {
    name: "write_file",
    description: "Write content to a file.",
    schema: z.object({ path: z.string(), content: z.string() }),
  },
);

const executeSql = tool(() => "Deleted 42 rows", {
  name: "execute_sql",
  description: "Run a SQL query.",
  schema: z.object({ query: z.string() }),
});

const readData = tool(({ table }) => `3 rows from ${table}`, {
  name: "read_data",
  description: "Read rows from a table.",
  schema: z.object({ table: z.string() }),
});

let agent = createAgent({
  model: "fireworks:accounts/fireworks/models/glm-5p2",
  tools: [writeFile, executeSql, readData],
  middleware: [
    humanInTheLoopMiddleware({
      interruptOn: {
        write_file: true,
        execute_sql: { allowedDecisions: ["approve", "reject"] },
        read_data: false,
      },
      interruptMode: "per_call", // [!code highlight]
    }),
  ],
  checkpointer: new MemorySaver(),
});
```

```ts Baseten theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { MemorySaver } from "@langchain/langgraph";
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import * as z from "zod";

const writeFile = tool(
  ({ path, content }) => `Wrote ${content.length} characters to ${path}`,
  {
    name: "write_file",
    description: "Write content to a file.",
    schema: z.object({ path: z.string(), content: z.string() }),
  },
);

const executeSql = tool(() => "Deleted 42 rows", {
  name: "execute_sql",
  description: "Run a SQL query.",
  schema: z.object({ query: z.string() }),
});

const readData = tool(({ table }) => `3 rows from ${table}`, {
  name: "read_data",
  description: "Read rows from a table.",
  schema: z.object({ table: z.string() }),
});

let agent = createAgent({
  model: "baseten:zai-org/GLM-5.2",
  tools: [writeFile, executeSql, readData],
  middleware: [
    humanInTheLoopMiddleware({
      interruptOn: {
        write_file: true,
        execute_sql: { allowedDecisions: ["approve", "reject"] },
        read_data: false,
      },
      interruptMode: "per_call", // [!code highlight]
    }),
  ],
  checkpointer: new MemorySaver(),
});
```

```ts Ollama theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { MemorySaver } from "@langchain/langgraph";
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import * as z from "zod";

const writeFile = tool(
  ({ path, content }) => `Wrote ${content.length} characters to ${path}`,
  {
    name: "write_file",
    description: "Write content to a file.",
    schema: z.object({ path: z.string(), content: z.string() }),
  },
);

const executeSql = tool(() => "Deleted 42 rows", {
  name: "execute_sql",
  description: "Run a SQL query.",
  schema: z.object({ query: z.string() }),
});

const readData = tool(({ table }) => `3 rows from ${table}`, {
  name: "read_data",
  description: "Read rows from a table.",
  schema: z.object({ table: z.string() }),
});

let agent = createAgent({
  model: "ollama:north-mini-code-1.0",
  tools: [writeFile, executeSql, readData],
  middleware: [
    humanInTheLoopMiddleware({
      interruptOn: {
        write_file: true,
        execute_sql: { allowedDecisions: ["approve", "reject"] },
        read_data: false,
      },
      interruptMode: "per_call", // [!code highlight]
    }),
  ],
  checkpointer: new MemorySaver(),
});
```

### Read the interrupts

When the model calls all three tools in one turn, `read_data` runs right away. The two gated calls each raise an interrupt:

```ts theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { isToolApprovalInterrupt } from "langchain";

let config = { configurable: { thread_id: "1" } };
let result = await agent.invoke(
  {
    messages: [
      { role: "user", content: "Archive old orders, then delete them." },
    ],
  },
  config,
);

// One interrupt per gated tool call, in no fixed order
const approvals = (result.__interrupt__ ?? []).filter(isToolApprovalInterrupt);
for (const interrupt of approvals) {
  console.log(interrupt.value);
}
// > {
// >   type: 'tool_approval',
// >   tool_call_id: 'call_write',
// >   name: 'write_file',
// >   args: { path: 'orders_archive.csv', content: 'id,total\n1,20\n' },
// >   description: 'Tool execution requires approval\n\nTool: write_file\nArgs: {\n  "path": "orders_archive.csv",\n  "content": "id,total\\n1,20\\n"\n}'
// > }
// > {
// >   type: 'tool_approval',
// >   tool_call_id: 'call_sql',
// >   name: 'execute_sql',
// >   args: { query: "DELETE FROM orders WHERE created_at < '2025-01-01'" },
// >   description: `Tool execution requires approval\n\nTool: execute_sql\nArgs: {\n  "query": "DELETE FROM orders WHERE created_at < '2025-01-01'"\n}`
// > }
```

Each interrupt value has `type: "tool_approval"`, so a client can tell it apart from other interrupts. The `isToolApprovalInterrupt` function checks for it and narrows the value's type. The `tool_call_id`, `name`, and `args` fields identify the call under review.

### Read the response schema

Each interrupt also carries a `response_schema`: a JSON schema with one branch per decision the tool allows, matched on the decision's `type`. The `execute_sql` schema has `approve` and `reject` branches. The `write_file` schema has all four. For a tool that allows one decision, `response_schema` is that decision's schema alone, with no `oneOf`.

Each tab shows one `write_file` branch, an answer that matches it, and the [ToolMessage](https://reference.langchain.com/javascript/langchain-core/messages/ToolMessage) the model receives. For readability, the branches below omit the `additionalProperties` fields.

> [tab] approve
>
> Run the call as proposed.
>
> ```json Schema branch theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
> {"type": "object", "properties": {"type": {"type": "string", "const": "approve"}}, "required": ["type"]}
> ```
>
> ```ts Answer theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
> { type: "approve" }
> ```
>
> ```text Model receives theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
> Wrote 14 characters to orders_archive.csv
> ```

> [tab] edit
>
> Run the call with new arguments. `edited_action.name` must stay `write_file`, and `edited_action.args` must match `write_file`'s argument schema. Arguments the tool does not declare are handled the same way as when the model sends them: a `z.object` schema drops them, and a `z.looseObject` schema keeps them.
>
> ```json Schema branch theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
> {
>   "type": "object",
>   "properties": {
>     "type": {"type": "string", "const": "edit"},
>     "edited_action": {
>       "type": "object",
>       "properties": {
>         "name": {"type": "string", "const": "write_file"},
>         "args": {
>           "type": "object",
>           "properties": {
>             "path": {"type": "string"},
>             "content": {"type": "string"}
>           },
>           "required": ["path", "content"]
>         }
>       },
>       "required": ["name", "args"]
>     }
>   },
>   "required": ["type", "edited_action"]
> }
> ```
>
> ```ts Answer theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
> {
>   type: "edit",
>   edited_action: {
>     name: "write_file",
>     args: { path: "archive/orders_2024.csv", content: "id,total\n1,20\n" },
>   },
> }
> ```
>
> The model receives the tool's result after a note that a reviewer replaced the call. Set `editNotice` on the middleware to change the note, or pass `null` to remove it.
>
> ```text Model receives theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
> Note: a human reviewer replaced this tool call before it ran. The call recorded in your message is the one you produced, not the one that executed. This was intentional and authorized. Do not re-issue your original call. Executed instead: write_file with arguments {"path":"archive/orders_2024.csv","content":"id,total\n1,20\n"}.
>
> Tool response:
> Wrote 14 characters to archive/orders_2024.csv
> ```

> [tab] reject
>
> Skip the call. The `message` is optional and tells the model why.
>
> ```json Schema branch theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
> {"type": "object", "properties": {"type": {"type": "string", "const": "reject"}, "message": {"type": "string"}}, "required": ["type"]}
> ```
>
> ```ts Answer theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
> { type: "reject", message: "Write to the archive/ folder instead." }
> ```
>
> ```text Model receives (error status) theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
> Write to the archive/ folder instead.
> ```

> [tab] respond
>
> Skip the call and answer in place of the tool. The `message` is required. The model receives it as a successful tool result, so use `reject` to deny a call.
>
> ```json Schema branch theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
> {"type": "object", "properties": {"type": {"type": "string", "const": "respond"}, "message": {"type": "string"}}, "required": ["type", "message"]}
> ```
>
> ```ts Answer theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
> { type: "respond", message: "Saved orders_archive.csv to the shared drive myself." }
> ```
>
> ```text Model receives theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
> Saved orders_archive.csv to the shared drive myself.
> ```

### Resume each call by ID

Answer each interrupt with one decision, keyed by its ID:

```ts theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { Command } from "@langchain/langgraph";

const decisions = Object.fromEntries(
  approvals.map((interrupt) => [
    interrupt.id,
    interrupt.value.name === "execute_sql"
      ? { type: "reject", message: "Archive the rows before deleting them." }
      : { type: "approve" },
  ]),
);

result = await agent.invoke(new Command({ resume: decisions }), config);
```

You can also answer interrupts one at a time. An interrupt you do not answer stays pending, and its tool runs once it gets an answer.

> [!WARNING]
>
> If one of several answers sent together is invalid, the tools for the others can run while their interrupts still show as pending. Answering them again runs those tools twice. Check answers against `response_schema` before you send them together, or send one at a time.

### Correct an invalid answer

LangGraph checks each answer against the interrupt's `response_schema` before it saves the answer. An invalid answer throws an error and nothing is saved, so you can send a corrected answer to the same interrupt ID. The middleware wraps the error in a `MiddlewareError`, and its `cause` is the Zod error with the list of issues. Here, the edit leaves out `content`:

```ts theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
const writeFileInterrupt = (result.__interrupt__ ?? [])
  .filter(isToolApprovalInterrupt)
  .find((interrupt) => interrupt.value.name === "write_file")!;
const args: Record<string, string> = { path: "archive/orders_2024.csv" };
const edit = { type: "edit", edited_action: { name: "write_file", args } };

try {
  await agent.invoke(
    new Command({ resume: { [writeFileInterrupt.id]: edit } }),
    config,
  );
} catch (error) {
  // The middleware wraps the error; its `cause` lists what failed
  if (!(error instanceof Error && error.cause instanceof z.core.$ZodError)) {
    throw error;
  }
  for (const issue of error.cause.issues) {
    console.log(`${issue.path.join(".")} ${issue.message}`);
  }
}
// > edited_action.args.content Invalid input: expected string, received undefined

// Nothing was saved, so answer the same interrupt again
args.content = "id,total\n1,20\n";
result = await agent.invoke(
  new Command({ resume: { [writeFileInterrupt.id]: edit } }),
  config,
);
```

Each issue names the field that failed, so you can show it to the reviewer. LangGraph checks edits only for tools with a Zod v4 object schema. For other tools, such as ones with a JSON schema, `response_schema` accepts any `args` object, and the tool checks the arguments when it runs.

### Order middleware for per-call review

In per-call mode, the review happens as the tool call starts, inside the tool-call middleware chain:

* List `humanInTheLoopMiddleware` before tool retry or error-handling middleware, such as [toolRetryMiddleware](https://reference.langchain.com/javascript/langchain/index/toolRetryMiddleware) and [toolErrorMiddleware](https://reference.langchain.com/javascript/langchain/index/toolErrorMiddleware), so it wraps them. Otherwise a retried call asks the reviewer again, and an invalid answer is retried or returned to the model as a tool error.
* When the agent resumes, middleware listed before `humanInTheLoopMiddleware` runs again up to the pause, so it must not have side effects before it calls its handler. The tool runs only after the answer.
* A [`when` predicate](#conditional-interrupts) runs as each call starts, so the [ToolCallRequest](https://reference.langchain.com/javascript/langchain/index/ToolCallRequest) it receives includes the tool.

## Responding to interrupts

When you invoke the agent, it runs until it either completes or an interrupt is raised. An interrupt is triggered when a tool call matches the policy you configured in `interruptOn`. The result has an `__interrupt__` field containing the actions that require review. You can then present those actions to a reviewer and resume execution once decisions are provided.

The examples in this section and the decision types below use the default batched mode. For per-call mode, see [Pause once per tool call](#pause-once-per-tool-call).

```typescript theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

// You must provide a thread ID to associate the execution with a conversation thread,
// so the conversation can be paused and resumed (as is needed for human review).
const config = { configurable: { thread_id: "some_id" } }; // [!code highlight]

// Run the graph until the interrupt is hit.
const result = await agent.invoke(
    {
        messages: [new HumanMessage("Delete old records from the database")],
    },
    config // [!code highlight]
);


// The interrupt contains the full HITL request with actionRequests and reviewConfigs
console.log(result.__interrupt__);
// > [
// >    Interrupt(
// >       value: {
// >          actionRequests: [
// >             {
// >                name: 'execute_sql',
// >                args: { query: 'DELETE FROM records WHERE created_at < NOW() - INTERVAL \'30 days\';' },
// >                description: 'Tool execution pending approval\n\nTool: execute_sql\nArgs: {...}'
// >             }
// >          ],
// >          reviewConfigs: [
// >             {
// >                actionName: 'execute_sql',
// >                allowedDecisions: ['approve', 'reject']
// >             }
// >          ]
// >       }
// >    )
// > ]

// Resume with approval decision
await agent.invoke(
    new Command({ // [!code highlight]
        resume: { decisions: [{ type: "approve" }] }, // or "reject" [!code highlight]
    }), // [!code highlight]
    config // Same thread ID to resume the paused conversation
);
```

### Decision types

> [tab] approve
>
> Use `approve` to approve the tool call as-is and execute it without changes.
>
> ```typescript theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
> await agent.invoke(
>     new Command({
>         // Decisions are provided as a list, one per action under review.
>         // The order of decisions must match the order of actions
>         // in the interrupt request.
>         resume: {
>             decisions: [
>                 {
>                     type: "approve",
>                 }
>             ]
>         }
>     }),
>     config  // Same thread ID to resume the paused conversation
> );
> ```

> [tab] edit
>
> Use `edit` to modify the tool call before execution.
> Provide the edited action with the new tool name and arguments.
>
> ```typescript theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
> await agent.invoke(
>     new Command({
>         // Decisions are provided as a list, one per action under review.
>         // The order of decisions must match the order of actions
>         // in the interrupt request.
>         resume: {
>             decisions: [
>                 {
>                     type: "edit",
>                     // Edited action with tool name and args
>                     editedAction: {
>                         // Tool name to call.
>                         // Will usually be the same as the original action.
>                         name: "new_tool_name",
>                         // Arguments to pass to the tool.
>                         args: { key1: "new_value", key2: "original_value" },
>                     }
>                 }
>             ]
>         }
>     }),
>     config  // Same thread ID to resume the paused conversation
> );
> ```
>
> > [!TIP]
> >
> > When **editing** tool arguments, make changes conservatively. Significant modifications to the original arguments may cause the model to re-evaluate its approach and potentially execute the tool multiple times or take unexpected actions.

> [tab] reject
>
> Use `reject` to deny the tool call and provide feedback instead of execution. The tool is not executed.
>
> ```typescript theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
> await agent.invoke(
>     new Command({
>         // Decisions are provided as a list, one per action under review.
>         // The order of decisions must match the order of actions
>         // in the interrupt request.
>         resume: {
>             decisions: [
>                 {
>                     type: "reject",
>                     // Optional: explain why the action was rejected
>                     // and whether the agent should retry a different approach.
>                     message: "User rejected this action. Do not retry this tool call.",
>                 }
>             ]
>         }
>     }),
>     config  // Same thread ID to resume the paused conversation
> );
> ```
>
> The `message` is added to the conversation as feedback to help the agent understand why the action was rejected and what it should do instead. When you omit `message`, the middleware uses a default rejection message that tells the model the tool was not executed and not to retry the same tool call unless the user asks. For side-effecting tools, provide a domain-specific message that is explicit about whether the agent should abandon the action, ask a follow-up question, or try a safer alternative.

> [tab] respond
>
> Use `respond` for "ask user" style tools where the tool's real implementation is the human's reply. The `message` content is returned directly as the tool result; the tool itself is not executed.
>
> ```typescript theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
> await agent.invoke(
>     new Command({
>         // Decisions are provided as a list, one per action under review.
>         // The order of decisions must match the order of actions
>         // in the interrupt request.
>         resume: {
>             decisions: [
>                 {
>                     type: "respond",
>                     // The human's reply, returned directly as the tool result
>                     message: "Blue.",
>                 }
>             ]
>         }
>     }),
>     config  // Same thread ID to resume the paused conversation
> );
> ```
>
> The `message` is returned to the agent as a successful `ToolMessage`. Use `respond` when the tool is intentionally a placeholder for human input, for example, an `ask_user` tool that prompts for clarification. Do not use `respond` to deny a proposed action, because it tells the model that the tool completed successfully.

***

### Multiple decisions

When multiple actions are under review, provide a decision for each action in the same order as they appear in the interrupt:

```typescript theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
{
    decisions: [
        { type: "approve" },
        {
            type: "edit",
            editedAction: {
                name: "tool_name",
                args: { param: "new_value" }
            }
        },
        {
            type: "reject",
            message: "This action is not allowed"
        }
    ]
}
```

## Streaming with human-in-the-loop

You can stream real-time updates while the agent runs and handles interrupts using `stream_events()`. Use `stream.messages` to stream LLM tokens and `stream.values` to check agent state snapshots for interrupts.

```typescript theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
import { Command } from "@langchain/langgraph";

const config = { configurable: { thread_id: "some_id" } };

// Stream agent progress and LLM tokens until interrupt
const stream = await agent.streamEvents(
    { messages: [{ role: "user", content: "Delete old records from the database" }] },
    { ...config, version: "v3" }  // [!code highlight]
);
for await (const message of stream.messages) {  // [!code highlight]
    for await (const token of message.text) {  // [!code highlight]
        process.stdout.write(token);
    }
}

// Check whether the run paused for human input
if (stream.interrupted) {  // [!code highlight]
    console.log(`\n\nInterrupt: ${JSON.stringify(stream.interrupts)}`);  // [!code highlight]
}

// Resume with streaming after human decision
const resumeStream = await agent.streamEvents(
    new Command({ resume: { decisions: [{ type: "approve" }] } }),
    { ...config, version: "v3" }  // [!code highlight]
);
for await (const message of resumeStream.messages) {  // [!code highlight]
    for await (const token of message.text) {
        process.stdout.write(token);
    }
}
```

In [per-call mode](#pause-once-per-tool-call), `stream.interrupts` holds one entry per gated tool call, with the interrupt value in `payload` and no `response_schema`. Resume with an object keyed by `interruptId`:

```ts theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
const streamDecisions = Object.fromEntries(
  stream.interrupts.map((interrupt) => [
    interrupt.interruptId,
    { type: "approve" },
  ]),
);
stream = await agent.streamEvents(new Command({ resume: streamDecisions }), {
  ...config,
  version: "v3",
});
for await (const message of stream.messages) {
  for await (const token of message.text) {
    process.stdout.write(token);
  }
}
```

See the [Streaming](https://docs.langchain.com/oss/javascript/langchain/streaming.md) guide for more details on stream modes.

## Execution lifecycle

The middleware defines an `afterModel` hook that runs after the model generates a response but before any tool calls are executed:

1. The agent invokes the model to generate a response.
2. The middleware inspects the response for tool calls.
3. If any calls require human input, the middleware builds a [HITLRequest](https://reference.langchain.com/javascript/langchain/index/HITLRequest) with `actionRequests` and `reviewConfigs` and calls [interrupt](https://reference.langchain.com/javascript/langchain-langgraph/index/interrupt).
4. The agent waits for human decisions.
5. Based on the `HITLResponse` decisions, the middleware executes approved or edited calls, synthesizes [ToolMessage](https://reference.langchain.com/javascript/langchain-core/messages/ToolMessage)'s for rejected calls, returns human replies directly as [ToolMessage](https://reference.langchain.com/javascript/langchain-core/messages/ToolMessage)'s for `respond` decisions, and resumes execution.

In [per-call mode](#pause-once-per-tool-call), the `afterModel` hook does nothing. The middleware instead pauses each gated call as it runs, with one [interrupt](https://reference.langchain.com/javascript/langchain-langgraph/index/interrupt) per call, and runs the tool once that call's decision arrives.

## Custom HITL logic

For more specialized workflows, you can build custom HITL logic directly using the [interrupt](https://reference.langchain.com/javascript/langchain-langgraph/index/interrupt) primitive and [middleware](https://docs.langchain.com/oss/javascript/langchain/middleware.md) abstraction.

Review the [execution lifecycle](#execution-lifecycle) above to understand how to integrate interrupts into the agent's operation.

***

[Connect these docs](https://docs.langchain.com/use-these-docs.md) to your agent of choice via MCP for real-time answers.

[Edit this page on GitHub](https://github.com/langchain-ai/docs/edit/main/src/oss/langchain/human-in-the-loop.mdx) or [file an issue](https://github.com/langchain-ai/docs/issues/new/choose).

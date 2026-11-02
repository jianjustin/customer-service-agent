# Spike 实证结论（Fable 在当前 node_modules 上实际运行验证，Spec 与实现直接采用）

## A. MCP 链路（spikes/mcp-server.ts + spikes/mcp-client.ts，已通过）

- 服务端写法（SDK v2）：
  ```ts
  import { McpServer } from "@modelcontextprotocol/server";
  import { serveStdio } from "@modelcontextprotocol/server/stdio";
  serveStdio(() => {
    const server = new McpServer({ name: "orders", version: "0.0.1" });
    server.registerTool("get_order", {
      title, description,
      inputSchema: z.object({ order_id: z.string(), customer_id: z.string(), context_token: z.string() }),
      outputSchema: z.object({...}), annotations: { readOnlyHint: true },
    }, async (args) => ({ content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out }));
    return server;
  });
  ```
  拒绝时返回 `{ isError: true, content: [{ type: "text", text: "..." }] }`。日志写 `process.stderr`（stdout 是协议通道，绝不能 console.log）。
- 客户端：
  ```ts
  const adapter = new MCPAdapter({ servers: { orders: {
    command: process.execPath,
    args: [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("mcp-server/index.ts")],
    env: { ...process.env, DB_PATH, MCP_SHARED_SECRET }, stderr: "inherit" } } });
  const mcpTools = await adapter.listTools(); // 名称带前缀：orders_get_order
  ```
  `mcpTools[i].metadata.annotations` 可读到 `readOnlyHint`。
- 包装工具（隐藏可信字段并注入）已验证可行：
  ```ts
  const wrapped = tool(async (args, runtime) => {
    const customerId = runtime.context.customerId;              // 来自 createAgent contextSchema + invoke 的 context
    const token = hmacSha256(SECRET, customerId);
    return raw.invoke({ ...args, customer_id: customerId, context_token: token },
                      { toolCall: { id: runtime.toolCall?.id ?? "x", name: raw.name, args } });
  }, { name: "get_order", description, schema: z.object({ order_id: z.string() }) });
  ```
  关键点：以带 `toolCall` 的 config 调用 `raw.invoke` 时，MCP 的 `isError` 结果会以 **ToolMessage(status="error", text=服务端拒绝文案)** 返回而不是抛异常，包装工具直接把它返回即可，Agent 会把它作为工具消息给模型。若以纯参数调用 `raw.invoke(args)`（无 toolCall config），成功返回 content 文本字符串，失败抛 `ToolException`（`error.result` 为 MCP 结果）。
- 成功结果：`ToolMessage.artifact` 为数组，含 `{ type: "mcp_structured_content", data }`（结构化输出）与 `{ type: "mcp_meta", ... }`。错误时仅有 `mcp_meta`。
- `createAgent({ model, tools: [wrapped], contextSchema })` + `agent.invoke({ messages }, { context: { customerId } })` 可用；`FakeToolCallingModel`（从 `langchain` 导出）构造参数 `{ toolCalls: ToolCall[][] }`，每次调用消费一组 tool_calls，空数组表示结束。它把历史文本拼成回复，仅适合测试，不适合演示；Mock 模式仍需自写规则型 `MockChatModel`。
- 可据此断言“确实经过 MCP”：MCP 进程 stderr 有调用日志；ToolMessage.artifact 含 `mcp_meta`/`mcp_structured_content`；测试里可让 MCP server 在 `DB_PATH` 同库写 `execution_logs(scope='mcp')` 以便断言。

## B. LangGraph 中断与恢复（spikes/graph-resume.ts，已通过）

- `new StateSchema({ requestId: z.string(), phase: z.string().default("init"), signal: z.unknown().optional() })` + `new StateGraph(State).addNode(...).compile({ checkpointer: SqliteSaver.fromConnString(path) })`。
- config 统一为 `{ configurable: { thread_id }, durability: "sync" }`。
- 首次 `invoke(input, cfg)` 命中 `interrupt(payload)` 后返回值含 `__interrupt__: [{ id, value }]`。
- “重启”= 用同一 db 文件新建 `SqliteSaver` 与新 compile 的 graph：`getState(cfg)` 得到 `next=['await_decision']`，`tasks[0].interrupts=[{id,value}]`。
- `invoke(new Command({ resume }), cfg)` 后 **await_decision 节点从头重跑一次**（executed 序列为 register, await_decision, await_decision, execute, ...），因此 interrupt 之前的代码必须幂等。
- 后续节点抛异常（模拟崩溃）后：`getState` 为 `next=['notify']`、`values.phase='executed'`、无 interrupts；重启后 `invoke(null, cfg)` 从 notify 继续并正常结束，`next=[]`，`tasks.length=0`。
- 判定规则（恢复器据此实现）：
  - `tasks.some(t => t.interrupts.length)` → 等待人工；若 DB 已有决定则 `Command({resume})`。
  - `next.length > 0 && 无 interrupts` → `invoke(null, cfg)`。
  - `next.length === 0` 且业务状态非终态 → 以新 attempt/新 thread 重新进入（节点幂等）。
  - 对已结束的 graph 再次 resume 前先 `getState` 检查，无 interrupt 则不调用。

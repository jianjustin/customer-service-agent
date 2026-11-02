# 架构约束（Fable 制定，Spec 与实现必须遵守）

本文件是设计 Spec 的上位约束。Spec 可以细化，不能违背。需求原文见 `docs/REQUIREMENTS.md`。

## 0. 已锁定的依赖与 API 事实（从 node_modules 实际核对）

| 包 | 版本 | 用法事实 |
| - | - | - |
| langchain | 1.6.0 | `createAgent({ model, tools, systemPrompt, checkpointer, contextSchema })`；`tool(fn, { name, description, schema })`；`initChatModel`；`FakeToolCallingModel`、`fakeModel` 可作 Mock 参考；`ToolMessage.isInstance` |
| @langchain/core | 1.3.2 | `BaseChatModel`（`@langchain/core/language_models/chat_models`）、消息类、`ToolRuntime`（`runtime.context`） |
| @langchain/langgraph | 1.6.0 | `StateGraph`、`StateSchema`、`ReducedValue`、`START/END`、`interrupt()`、`Command({ resume })`、`isInterrupted`、`graph.getState(config)` → `{ values, next, tasks[].interrupts }`；`invoke(null, config)` 从上一 checkpoint 继续；`durability: "sync"` |
| @langchain/langgraph-checkpoint-sqlite | 1.1.0 | `SqliteSaver.fromConnString(path)` 或 `new SqliteSaver(db)`；依赖 better-sqlite3 ^12 |
| @langchain/mcp-adapters | 2.0.1 | **`MCPAdapter`**（不是 1.x 的 `MultiServerMCPClient`）：`new MCPAdapter({ servers: { orders: { command, args, env, cwd, stderr } } })`；`await adapter.listTools()` 返回 `DynamicStructuredTool[]`，工具名默认带前缀 `orders_xxx`；`adapter.close()`；structured content 在 `ToolMessage.artifact[]` 的 `mcp_structured_content` 条目 |
| @modelcontextprotocol/server | 2.4.0 | `McpServer`（`{ name, version }`），`server.registerTool(name, { title, description, inputSchema: z.object(...), outputSchema?, annotations }, async (args, ctx) => ({ content, structuredContent }))`；stdio 入口 `import { serveStdio } from "@modelcontextprotocol/server/stdio"`，`serveStdio(() => server)` |
| @modelcontextprotocol/client,core | 2.4.0 | 由 adapter 使用；仅在需要类型时 import |
| better-sqlite3 | 12.11.1 | 同步 API；业务库与 checkpoint 库分文件 |
| express 5.3.0 / cors / dotenv 18 | | REST + 轮询，不用 websocket |
| react 19.3.1 / vite 8.3.5 / @vitejs/plugin-react 6.2.0 | | 单页三路由（hash 路由即可），无 UI 库，手写 CSS |
| vitest 5.0.5 / tsx 4.23.15 / typescript 5.9.3 / zod 4.6.7 | | 测试与运行 |

禁止：MemorySaver 作为持久化；1.x adapter API；`@modelcontextprotocol/sdk`（未安装）；任何未在 package.json 中的依赖。参考文档已离线保存于 `docs/refs/*.md`。

## 1. 目录结构（单 package，非 workspace）

```
server/
  index.ts                 启动：加载 env → 打开 DB → 迁移 → 幂等种子 → 启动 MCPAdapter → 构建 agent 与 refund graph → 恢复中断流程 → 启动 outbox worker → 监听 HTTP
  config.ts                环境变量解析（zod 校验）
  db/connection.ts         better-sqlite3 打开、WAL、外键开启
  db/migrate.ts            按序执行 server/db/migrations/*.sql，记录 schema_migrations
  db/migrations/0001_init.sql ...
  db/seed.ts               幂等初始化（INSERT OR IGNORE / upsert）：3 客户、3 席位、1 审核员、≥6 订单、知识库
  repos/*.ts               数据访问层接口 + SQLite 实现（Repository 接口独立文件，便于换业务 API / 多维表格）
  services/
    assignment.ts          轮询分配、离线/满员跳过、等待队列、入队/出队
    tickets.ts             建单、去重、状态流转、转派、结束
    conversation.ts        会话、消息、有序处理（每会话串行锁）、AI run 生命周期与抑制
    handover.ts            接管 / 恢复 AI
    knowledge.ts           知识加载与检索（本地打分，无外部服务）
    refunds.ts             提交申请（幂等键、唯一约束）、决定登记、恢复、重试、查询进度
    outbox.ts              持久化发送队列 + worker（幂等投递，通知不触发退款）
    locks.ts               keyed async mutex
  agent/
    model.ts               模型工厂：provider = anthropic | openai | mock
    mock-model.ts          规则型 MockChatModel（BaseChatModel 子类，支持 bindTools）
    tools/knowledge.ts     search_knowledge 本地工具
    tools/mcp.ts           MCPAdapter 启动 + 可信上下文注入包装（见 §4）
    tools/refund.ts        submit_refund_request、get_refund_progress（本地工具，调用 services）
    tools/handover.ts      request_human_handover
    agent.ts               createAgent 工厂（SqliteSaver + contextSchema）
    summary.ts             AI 排查摘要生成（mock 下为规则拼接）
  graphs/refund/
    state.ts graph.ts nodes.ts runner.ts   退款审批 StateGraph（见 §5）
  routes/
    auth.ts                身份解析中间件（x-role / x-actor-id）与权限守卫
    customer.ts agent.ts reviewer.ts bootstrap.ts
  channels/
    types.ts               ChannelAdapter 接口
    web.ts                 Web 渠道实现（写消息表）
    wechat.ts feishu.ts    预留桩，抛 NotImplemented
mcp-server/
  index.ts                 stdio 入口（serveStdio）
  server.ts                registerTool：list_orders / get_order / get_payment_status / get_refund_status
  auth.ts                  HMAC 上下文令牌校验
  repo.ts                  只读 SQLite 访问（独立连接）
web/
  index.html vite.config.ts src/main.tsx src/App.tsx src/api.ts
  src/pages/CustomerPage.tsx AgentPage.tsx ReviewerPage.tsx
  src/components/*.tsx src/styles.css
knowledge/entries.json     ≥10 条，字段 id/title/version/category/content/keywords
tests/                     vitest；每个测试用独立临时 DB 文件
docs/                      REQUIREMENTS / ARCHITECTURE / SPEC / SPIKE-FINDINGS / STATES / VERIFICATION
.env.example  data/        （db 文件不入库）
```

## 2. 身份与权限（仅后端可信）

- 请求头 `x-role: customer|agent|reviewer`，`x-actor-id`。中间件在 DB 中查实体，不存在即 401。身份切换仅前端下拉，后端每个路由都用守卫：
  - customer 只能访问 `customer_id = actor` 的工单、订单、退款；消息只能发到自己的会话。
  - agent 只能操作 `seat_id = actor` 的工单（转派目标除外）；席位状态只能改自己。
  - reviewer 只能走 reviewer 路由；决定写入时记录 reviewer_id。
- thread_id 永不从客户端接收；由服务端按 conversation 查出。Agent 调用上下文（customerId、ticketId、conversationId）通过 `createAgent` 的 `contextSchema` + `invoke(..., { context })` 注入，工具用 `runtime.context` 读取，不接受模型参数覆盖。

## 3. 核心数据模型（SQLite，`data/app.db`；checkpoint 在 `data/checkpoints.db`）

必备表（Spec 给出完整 DDL）：
- `customers(id, name)`、`seats(id, name, online 0/1, capacity)`、`reviewers(id, name)`
- `orders(id, customer_id, title, amount_minor INTEGER, currency, payment_status unpaid|paid|refunded, paid_at, refunded_at, refund_note)`
- `payments(id, order_id, channel, status, amount_minor, paid_at, failure_reason)`
- `tickets(id, customer_id, seat_id NULL, status queued|assigned|closed, subject, ai_summary, created_at, closed_at)`
- `conversations(id, ticket_id UNIQUE, customer_id, channel, channel_session_id, thread_id UNIQUE, handling_mode ai|human, ai_generation INTEGER, created_at)`
  — 接待状态（handling_mode）与工单状态（tickets.status）与退款状态分表保存。
- `messages(id, conversation_id, seq, sender_type customer|ai|agent|system, sender_id, content, sources_json, created_at, client_message_id)`，`UNIQUE(conversation_id, client_message_id)` 用于去重。
- `ai_runs(id, conversation_id, trigger_message_id, generation, status queued|running|completed|suppressed|cancelled|failed, error, started_at, finished_at)`
- `refund_requests(id 'RF-...', customer_id, ticket_id, order_id, amount_minor, currency, reason, evidence_json, version, status submitted|pending_review|approved|rejected|executing|refunded|failed, idempotency_key UNIQUE, thread_id, attempt, failure_reason, created_at, updated_at)`；部分唯一索引：同一 order_id 只能有一条 status NOT IN ('rejected','failed') 的申请。
- `refund_decisions(id, refund_request_id UNIQUE, reviewer_id, decision approved|rejected, comment, decided_at)` —— 权威审批记录。
- `refund_executions(id, refund_request_id, attempt, status success|failed, failure_reason, executed_at)`，`UNIQUE(refund_request_id, attempt)`，部分唯一索引 success 每申请最多一条。
- `outbox(id, kind, dedupe_key UNIQUE, conversation_id, payload_json, status pending|sent|failed, attempts, next_attempt_at, created_at, sent_at, last_error)`
- `execution_logs(id, scope conversation|refund|outbox, ref_id, node, event, detail_json, created_at)`
- `assignment_state(key PRIMARY KEY, value)`（轮询游标）、`schema_migrations(version)`、`knowledge_entries`（可从 json 载入）
- 金额一律最小货币单位整数（分）。

## 4. LangChain Agent 与 MCP

- 每个会话一个 `thread_id = conv_<uuid>`；Agent 由 `createAgent` 构建，`checkpointer = SqliteSaver`（checkpoints.db），每次 `invoke({ messages:[human] }, { configurable:{ thread_id }, context })`。
- MCP Server 是独立进程（`mcp-server/index.ts`，stdio，SDK v2 `serveStdio`），由 `MCPAdapter` 以 `command: process.execPath, args: [tsx-cli, mcp-server/index.ts]`（或 `npx tsx`）启动，`env` 传入 `DB_PATH`、`MCP_SHARED_SECRET`。启动时 `listTools()`，进程退出时 `close()`。
- **可信上下文注入**：MCP 工具的 inputSchema 含 `customer_id` 与 `context_token`。服务端对 adapter 返回的每个 `DynamicStructuredTool` 包一层本地 `tool()`：模型可见 schema 去掉这两个字段；执行时从 `runtime.context.customerId` 取值，计算 `context_token = HMAC-SHA256(MCP_SHARED_SECRET, customer_id)`，再 `await mcpTool.invoke({...modelArgs, customer_id, context_token})`。MCP Server 校验 token，再校验 `orders.customer_id === customer_id`，不符返回 `isError: true` 的拒绝结果。模型传入的任何 customer_id 被忽略。调用链必须真实经过 stdio MCP（测试需断言 MCP 进程确实被调用，如通过 server 端 `execution_logs`/stderr 计数或 `ToolMessage.artifact` 含 `mcp_structured_content`）。
- MCP 工具：`list_orders`（本客户全部订单）、`get_order(order_id)`、`get_payment_status(order_id)`、`get_refund_status(order_id | refund_request_id)`。Adapter 前缀后为 `orders_list_orders` 等。
- 本地工具：`search_knowledge(query)` 返回 top-k `{title, version, snippet, score}`；低于阈值返回空并提示“无依据”。`submit_refund_request(order_id, reason)`；`get_refund_progress()`；`request_human_handover(reason)`。
- 系统提示要求：引用知识时输出来源“标题 vX”；无依据时说明并追问或建议转人工；退款必须先查订单/支付再提交；不得宣称已退款。
- 模型工厂：`MODEL_PROVIDER=mock|anthropic|openai`。anthropic → `initChatModel(MODEL_NAME, { modelProvider: "anthropic" })` 或 `new ChatAnthropic`；openai → `new ChatOpenAI({ model, configuration: { baseURL } })`。mock → `MockChatModel`（BaseChatModel 子类，实现 `_generate`、`_llmType`、`bindTools`），规则型决策，所有最终回复以 `[Mock 模式]` 开头。无凭据时自动落到 mock 并在 `/api/bootstrap` 暴露 `modelMode`，前端显示徽标。
- AI 排查摘要：每轮 AI 完成后更新 `tickets.ai_summary`（mock 下由规则拼接：客户诉求、查询到的订单/支付状态、已给出的知识来源、退款申请编号）。

## 5. 退款审批流程（LangGraph，独立 thread）

- `thread_id = refund:<requestId>:a<attempt>`，与对话 thread 无关。Graph 用 `StateSchema` 定义状态：`requestId, attempt, mode: 'initial'|'retry'|'recover', phase, decisionId?, executionId?, failureReason?`。节点返回更新，禁止在状态中携带“approved=true”作为执行依据。
- 节点与边：
  1. `validate_request`：重读 DB 申请与订单，校验归属/已支付/金额/状态；失败 → 写 failed + 原因 → `enqueue_notification` → END。
  2. `register_review`：`UPDATE refund_requests SET status='pending_review' WHERE id=? AND status='submitted'`（幂等）；写日志。
  3. `await_decision`：`interrupt({ requestId, orderId, amountMinor })`。恢复值仅作信号，不作依据。节点内 interrupt 之前不得有非幂等副作用。
  4. `verify_decision`：重读 `refund_decisions`；无记录 → 回到 `await_decision`；rejected → `record_rejection`；approved → `execute_refund`。
  5. `execute_refund`：单个 SQLite 事务：重读决定=approved、订单归属一致、`payment_status='paid'`、不存在 success 执行记录；插入 `refund_executions`（UNIQUE 防重）；`UPDATE orders SET payment_status='refunded', refund_note='已退款（模拟）'`；`UPDATE refund_requests SET status='refunded'`。支持注入失败（订单标记 `simulate_refund_failure` 或测试钩子）→ 记录 failed 执行与原因，请求 status='failed'。
  6. `record_result`：写 execution_logs。
  7. `enqueue_notification`：`INSERT OR IGNORE INTO outbox(dedupe_key='refund:<id>:<status>:a<attempt>')`，由 worker 投递为会话系统消息。END。
  - 重试：reviewer 调 `/retry`，服务端校验 status='failed' 且决定为 approved，attempt+1，新 thread_id，`mode='retry'`，入口路由直接到 `verify_decision → execute_refund`。
- 审核接口顺序：鉴权 → 事务写 `refund_decisions`（UNIQUE；重复则 409/幂等返回）与 `refund_requests.status` → 在该申请的 mutex 内 `graph.getState`，仅当 `tasks` 有 interrupt 时 `invoke(new Command({ resume: { decisionId } }), config)`，否则记录“无待恢复任务”。
- 启动恢复 `recoverRefundFlows()`：遍历 `flow_completed_at IS NULL` 的申请（含终态但通知未入队者）：读 `getState`；若有 interrupt 且 DB 已有决定 → resume；若有 interrupt 无决定 → 保持等待；若 `next` 非空且无 interrupt → `invoke(null, config)` 续跑；若 `next` 为空但业务状态未终态 → 以 recover 模式重新 invoke，入口直接路由到 verify_decision（节点均幂等）。
- 所有 graph 调用使用 `durability: "sync"`。测试通过依赖注入的 `crashPoints`（如 `before:execute_refund`、`after:execute_refund`）在节点中抛错模拟重启，然后用同一 DB 文件重新构建服务并调用恢复。

## 6. 会话、分配与并发

- 第一条非空消息：事务内建 ticket + conversation（thread_id）+ message；`client_message_id` 重复 → 返回已有结果，不重复建单也不重复触发 AI。显式 `newTicket: true` 才新建工单；否则沿用客户最近的未结束工单。
- 分配：`assignment_state.rr_cursor` 轮询 A→B→C；跳过 `online=0` 或 `当前 assigned 工单数 >= capacity`；全部不可用 → `status='queued'`，`seat_id NULL`；席位上线/结单/转派释放容量后按创建时间出队。AI 在 queued 状态下仍可回复。
- 每会话串行：`locks.withLock(conversationId)`；AI run 创建时记录 `generation = conversations.ai_generation`；接管时 `ai_generation += 1`、`handling_mode='human'`，并将 running/queued 的 ai_runs 置 cancelled。AI 完成写回时在事务内校验 `handling_mode='ai' AND run.status='running' AND run.generation = conversations.ai_generation`，否则置 suppressed、不插消息。恢复 AI：`handling_mode='ai'`。
- 不同会话并行；退款决定按 requestId 加锁；outbox worker 单实例轮询。

## 7. HTTP API（前缀 /api；Spec 给出完整请求/响应）

bootstrap：`GET /bootstrap`（身份列表、modelMode）。
customer：`POST /customer/messages`、`GET /customer/tickets`、`GET /customer/tickets/:id/messages?afterSeq=`、`GET /customer/orders`、`GET /customer/refunds`、`POST /customer/tickets/:id/handover`。
agent：`GET /agent/me`、`POST /agent/me/status`、`GET /agent/tickets`、`GET /agent/tickets/:id`、`POST /agent/tickets/:id/{takeover|resume-ai|reply|transfer|close}`、`GET /agent/seats`。
reviewer：`GET /reviewer/refunds`、`GET /reviewer/refunds/:id`（含订单、理由、证据、决定、执行、日志、graph 状态）、`POST /reviewer/refunds/:id/decide`、`POST /reviewer/refunds/:id/retry`。
前端 2 秒轮询；刷新后从服务端恢复全部记录。

## 8. 验证矩阵（tests/ 必须覆盖，均为 vitest 自动化，Mock 模型）

1. 三客户建单分配 A/B/C；跨客户读取工单/订单/消息 → 403/空。
2. 同一 client_message_id 重发不重复建单；席位离线、满员跳过；全部不可用进入队列并在上线后出队。
3. 知识命中返回来源标题与版本；未知政策问题回复含“无依据/转人工”，不编造。
4. 工具调用经真实 MCP（stdio 子进程）；越权 order_id 被 MCP 拒绝。
5. 未审批、被拒绝的申请订单保持 paid；批准后仅一条 success 执行、订单 refunded。
6. 等待审核期间同一会话仍可聊天并查询进度（get_refund_progress）。
7. 等待期间“重启”（重建服务）后 getState 仍在 interrupt，审批后正确完成。
8. 审批后执行前崩溃 / 执行后通知前崩溃，恢复后结果正确且唯一。
9. 重复 decide 回调、并发 decide、重复恢复不产生第二次退款；outbox 重试不触发退款。
10. 接管后 AI 不写回（suppressed）；恢复 AI 后恢复回复；消息列表接口可完整回放。

## 9. 交付文档

`README.md`（启动步骤、环境变量、演示脚本）、`docs/STATES.md`（对话与退款状态机图）、`docs/VERIFICATION.md`（Mock 与真实模型验证结果、未验证项、试点待补齐项）、`.env.example`。

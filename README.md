# 企业客服 Agent 演示系统

一个可以在本机完整运行的企业客服 Agent 演示系统：客户咨询与自动应答、席位分配与人工接管、知识库检索、通过真实 MCP Server 查询订单、带人工审核的整单模拟退款，以及可在重启后恢复的持久化退款流程。

- 技术栈：TypeScript、Node.js、Express 5、React 19 + Vite 8、SQLite（better-sqlite3）、LangChain 1.6、LangGraph 1.6。
- 仅本地运行，不部署、不连接真实支付平台；微信、飞书渠道只保留适配器桩。
- 没有模型凭据时自动使用规则型 **Mock 模式**（界面右上角橙色“Mock 模式”徽标），可离线完整演示；配置凭据后切换为真实模型。

## 目录

1. [架构](#1-架构)
2. [目录结构](#2-目录结构)
3. [依赖版本](#3-依赖版本)
4. [环境变量](#4-环境变量)
5. [本地启动](#5-本地启动)
6. [三个页面](#6-三个页面)
7. [浏览器演示步骤](#7-浏览器演示步骤)
8. [测试](#8-测试)
9. [数据库迁移与种子数据](#9-数据库迁移与种子数据)
10. [文档索引](#10-文档索引)
11. [已知限制](#11-已知限制)

---

## 1. 架构

```
浏览器（React 19 + Vite 8，hash 路由，每 2 秒轮询）
  #/customer 客户端   #/agent 客服工作台   #/reviewer 审核台
        │  HTTP /api（Vite 开发服务器 :5173 把 /api 代理到后端 :3001）
        │  请求头 x-role / x-actor-id（身份切换仅用于本地演示）
        ▼
Express 5 后端（server/，默认 :3001）
  路由层  身份中间件 + 角色守卫；资源归属（客户/席位）在服务层逐请求校验
  服务层  assignment 分配 · tickets 工单 · conversation 会话与 AI run
          handover 接管 · knowledge 知识检索 · refunds 退款 · outbox 通知队列与 worker
  渠道层  web（已实现） · wechat / feishu（适配器桩，未接入）

  ┌ 对话 Agent（LangChain createAgent）──────────┐  ┌ 退款流程（LangGraph StateGraph）────────┐
  │ 模型  Mock / Anthropic / OpenAI 兼容         │  │ validate_request → register_review       │
  │ 工具  search_knowledge（本地检索）           │  │ → await_decision（interrupt 等待审核）    │
  │       orders_*（MCP，服务端注入可信上下文）  │  │ → verify_decision（重读审批记录）         │
  │       submit_refund_request                  │  │ → execute_refund（事务内重读后执行）      │
  │       get_refund_progress                    │  │ → record_result → enqueue_notification    │
  │       request_human_handover                 │  │ thread_id = refund:<申请号>:a<尝试次数>   │
  │ thread_id = conv_<uuid>（每工单一个）        │  └──────────────────────────────────────────┘
  └──────────────────────────────────────────────┘
        │ 业务读写                         │ stdio（@langchain/mcp-adapters 的 MCPAdapter 拉起子进程）
        ▼                                  ▼
  SQLite 业务库 data/app.db          MCP Server 子进程（mcp-server/，只读订单库）
  SQLite checkpoint 库                 · 校验 HMAC 签名的可信客户上下文
  data/checkpoints.db                  · 再次校验订单归属，越权返回 FORBIDDEN
```

关键设计：

- **业务数据与执行状态分离**：工单、会话、审批、订单、执行日志都是业务表（`app.db`）；LangGraph 的 checkpoint（`checkpoints.db`，持久化的 `SqliteSaver`）只保存“执行到哪一步”，不代替权限和事务控制。
- **对话与退款是两条独立线程**：对话用工单对应的 `conv_<uuid>`，退款用 `refund:<申请号>:a<尝试次数>`。等待审核期间，客户仍可聊天、查询进度。
- **审批以数据库为准**：审核接口先落库决定，再向 Graph 提交恢复信号；恢复参数只是信号，`execute_refund` 重新读取审批记录、订单与支付状态后才执行。Agent 只能“提交申请”和“查进度”，不能审批、改审批人或绕过校验。
- **可信上下文**：模型看不到也无法指定 `customer_id`。服务端用 `createAgent` 的 `contextSchema` 注入当前客户，包装 MCP 工具时附带 HMAC 签名令牌；MCP Server 先验签，再校验订单归属。
- **接管不抢答**：每个会话有 `ai_generation`；接管、转人工、结单都会让它加一。AI 回复写回前在事务内校验模式、run 状态与 generation，不通过则丢弃（状态 `suppressed`），客户看不到。
- **通知经持久化 outbox**：通知只入队，由 worker 投递；以去重键保证幂等；outbox 模块不依赖退款服务，通知重试不可能再次触发退款。
- **可替换的数据访问层**：业务仓储接口在 `server/repos/interfaces.ts`，MCP 侧的只读接口 `OrderReadRepository` 在 `mcp-server/repo.ts`，可替换为业务 API 或多维表格实现。

各状态机、事务边界、崩溃点与恢复规则见 [`docs/STATES.md`](docs/STATES.md)。

---

## 2. 目录结构

```
customer-service-agent/
├── server/                         后端
│   ├── index.ts                    启动入口：加载 env → 装配容器 → 恢复 → 监听
│   ├── container.ts                依赖装配（DB、仓储、服务、Graph、MCP、Agent、outbox）
│   ├── app.ts / config.ts          Express 应用 / 环境变量解析（zod）
│   ├── routes/                     auth（身份与角色守卫）、customer、agent、reviewer、bootstrap
│   ├── services/                   assignment、tickets、conversation、handover、knowledge、
│   │                               refunds、outbox、locks
│   ├── agent/                      createAgent 工厂、模型工厂、Mock 模型、系统提示词、摘要、
│   │   └── tools/                  search_knowledge、MCP 接入与上下文注入、退款、转人工
│   ├── graphs/refund/              退款 LangGraph：state、graph、nodes、runner、crash（崩溃注入）
│   ├── channels/                   渠道适配接口；web 实现；wechat / feishu 桩
│   ├── repos/                      数据访问层：interfaces.ts + SQLite 实现
│   ├── db/                         connection、migrate、seed、migrations/0001_init.sql
│   ├── domain/                     领域类型与 DTO
│   └── scripts/init-db.ts          幂等初始化脚本（pnpm db:init）
├── mcp-server/                     真实 MCP Server（stdio，SDK v2）
│   ├── index.ts                    入口（serveStdio）
│   ├── server.ts                   四个订单只读工具
│   ├── auth.ts                     HMAC 上下文令牌签发与校验
│   └── repo.ts                     OrderReadRepository（独立只读连接）
├── web/                            前端
│   ├── vite.config.ts              端口 5173，/api 代理到后端
│   └── src/                        App.tsx、api.ts、pages/、components/、hooks/、styles.css
├── knowledge/entries.json          示例知识库（14 条，含标题与版本）
├── tests/                          vitest：01–10 验收矩阵 + 单元/批次测试 + helpers/
├── docs/                           REQUIREMENTS、ARCHITECTURE、SPEC、STATES、SPIKE-FINDINGS、
│                                   VERIFICATION、refs/（LangChain/LangGraph 离线参考）
├── data/                           运行时数据库（app.db、checkpoints.db，不入库）
├── .env.example                    环境变量模板
└── package.json
```

---

## 3. 依赖版本

所有依赖版本均已锁定（精确版本，见 `package.json` 与 `pnpm-lock.yaml`），并按实际安装版本实现。

运行环境：Node.js `>=22`（`engines`），包管理器 `pnpm@10.34.4`。本仓库在 macOS、Node 26.8.2、pnpm 10.34.4 上开发与验证。

| 包 | 版本 | 用途 |
| - | - | - |
| `langchain` | 1.6.0 | `createAgent`、`tool`、`initChatModel` |
| `@langchain/core` | 1.3.2 | 消息、`BaseChatModel`、工具运行时 |
| `@langchain/langgraph` | 1.6.0 | 退款流程 `StateGraph`、`interrupt`、`Command` |
| `@langchain/langgraph-checkpoint` | 1.2.2 | checkpoint 基础接口 |
| `@langchain/langgraph-checkpoint-sqlite` | 1.1.0 | 持久化 checkpointer（`SqliteSaver`） |
| `@langchain/mcp-adapters` | 2.0.1 | `MCPAdapter`：拉起 MCP 子进程并转成 LangChain 工具 |
| `@langchain/anthropic` | 1.6.0 | 真实模型：Anthropic |
| `@langchain/openai` | 1.8.0 | 真实模型：OpenAI 及兼容服务 |
| `@modelcontextprotocol/server` | 2.4.0 | MCP Server（`McpServer`、`serveStdio`） |
| `@modelcontextprotocol/client` | 2.4.0 | MCP 客户端，项目代码不直接引用，供 `@langchain/mcp-adapters` 使用 |
| `@modelcontextprotocol/core` | 2.4.0 | MCP 核心类型，项目代码不直接引用 |
| `@modelcontextprotocol/node` | 2.1.2 | MCP 的 Node 运行时支持，项目代码不直接引用 |
| `better-sqlite3` | 12.11.1 | SQLite（同步 API） |
| `express` | 5.3.0 | HTTP 服务 |
| `cors` | 2.8.6 | 跨域 |
| `dotenv` | 18.0.9 | 加载 `.env` |
| `zod` | 4.6.7 | 配置、请求体、工具参数校验 |
| `react` / `react-dom` | 19.3.1 | 前端 |
| `vite` | 8.3.5 | 前端开发服务器 |
| `@vitejs/plugin-react` | 6.2.0 | Vite 的 React 插件 |
| `typescript` | 5.9.3 | 类型检查 |
| `tsx` | 4.23.15 | 直接运行 TS（后端、MCP Server） |
| `vitest` | 5.0.5 | 测试 |
| `concurrently` | 10.0.6 | `pnpm dev` 同时起前后端 |
| `@types/node` | 26.6.6 | 类型 |
| `@types/express` | 5.0.6 | 类型 |
| `@types/cors` | 2.8.19 | 类型 |
| `@types/better-sqlite3` | 9.6.0 | 类型 |
| `@types/react` / `@types/react-dom` | 19.3.0 | 类型 |

不使用：`MemorySaver` 作为持久化；`@modelcontextprotocol/sdk`（未安装）；`MultiServerMCPClient`（1.x adapter API）。

---

## 4. 环境变量

复制模板：`cp .env.example .env`。`.env` 已被 `.gitignore` 忽略；所有变量都有默认值，不创建 `.env` 也能以 Mock 模式启动。空串视为未设置。已在 shell 中导出的变量优先于 `.env`（`dotenv` 不覆盖已有值）。

| 变量 | 默认值 | 说明 |
| - | - | - |
| `SERVER_PORT` | `3001` | 后端 HTTP 端口（Vite 把 `/api` 代理到这里）。优先于 `PORT`；`PORT` 仅作回退，避免与 Vite 或预览工具注入的 `PORT` 冲突 |
| `DB_PATH` | `data/app.db` | 业务库路径，相对项目根目录 |
| `CHECKPOINT_DB_PATH` | `data/checkpoints.db` | LangGraph checkpoint 库路径，相对项目根目录 |
| `MCP_SHARED_SECRET` | `change-me-local-demo-secret` | 主进程与 MCP Server 共享的 HMAC 密钥，至少 8 个字符；本地演示用，请自行修改 |
| `MODEL_PROVIDER` | `mock` | `mock` / `anthropic` / `openai` |
| `MODEL_NAME` | 空 | 真实模型名称，使用 `anthropic` 或 `openai` 时必填 |
| `ANTHROPIC_API_KEY` | 空 | `MODEL_PROVIDER=anthropic` 时必填 |
| `OPENAI_API_KEY` | 空 | `MODEL_PROVIDER=openai` 时必填 |
| `OPENAI_BASE_URL` | 空 | OpenAI 兼容服务地址（可选） |
| `OUTBOX_POLL_MS` | `1000` | outbox worker 轮询周期（毫秒，最小 10） |
| `OUTBOX_MAX_ATTEMPTS` | `8` | 通知最大投递次数，超过后标记 `failed` |
| `MOCK_DELAY_MS` | `0` | Mock 模型每次生成前的人为延迟（毫秒），用于演示“接管抢答被拦截” |

模型选择规则：

- `MODEL_PROVIDER=anthropic` 需要 `ANTHROPIC_API_KEY` 与 `MODEL_NAME`；`openai` 需要 `OPENAI_API_KEY` 与 `MODEL_NAME`。缺任何一项都会**自动回落 Mock 模式**，原因写入启动日志和 `/api/bootstrap`，界面保持橙色“Mock 模式”徽标（悬停可见原因）。
- Mock 模式下，所有 AI 回复都以 `[Mock 模式] ` 开头，便于与真实模型区分。
- 真实模型生效时，徽标显示为 `Anthropic · <模型名>` 或 `OpenAI 兼容 · <模型名>`，回复没有 Mock 前缀。

修改后端端口时请在 shell 中导出，例如 `SERVER_PORT=3002 pnpm dev`：Vite 的代理目标只读取进程环境变量中的 `SERVER_PORT`，不会读取 `.env` 文件；只改 `.env` 会导致后端换了端口而前端仍代理到 3001。

---

## 5. 本地启动

前置条件：Node.js >= 22、pnpm 10。

```bash
pnpm install              # 安装依赖（better-sqlite3 需要编译原生模块，已在 pnpm.onlyBuiltDependencies 中放行）
cp .env.example .env      # 可选；默认即 Mock 模式
pnpm db:init              # 迁移 + 幂等种子，打印各表行数；可重复执行
pnpm dev                  # 后端 :3001 + 前端 :5173（Vite 把 /api 代理到后端）
```

然后在浏览器打开 `http://localhost:5173/#/customer`。三个页面用顶部导航切换，也可直接访问：

- `http://localhost:5173/#/customer` 客户端
- `http://localhost:5173/#/agent` 客服工作台
- `http://localhost:5173/#/reviewer` 审核台

说明：

- `pnpm db:init` 不是必需的——后端启动时同样会执行迁移与种子——但它能在启动前确认数据库就绪，并打印行数（3 客户 / 3 席位 / 1 审核员 / 7 订单 / 7 支付 / 14 知识）。
- 后端启动成功时终端输出 `[server] 已启动 http://localhost:3001（模型模式：mock）`。首次启动会拉起 MCP 子进程，终端可见 `[orders-mcp] started pid=…`。
- 后端启动时先执行恢复（中断的 AI run、未完成的退款流程），再开始监听；有未完成流程时会打印 `[recovery] 退款流程恢复报告`。
- 本项目只提供开发模式（Vite 开发服务器 + `tsx`），没有生产构建与静态托管脚本。

脚本一览：

| 命令 | 作用 |
| - | - |
| `pnpm dev` | 同时启动后端（`tsx watch`，文件变化自动重启）与前端（Vite） |
| `pnpm dev:server` / `pnpm dev:web` | 单独启动后端 / 前端 |
| `pnpm start:server` | 只启动后端（不监听文件变化） |
| `pnpm mcp:server` | 单独启动 MCP stdio 服务，调试用；需要环境变量 `DB_PATH` 与 `MCP_SHARED_SECRET`；正常运行时由后端自动拉起，无需手动启动 |
| `pnpm db:init` | 迁移 + 幂等种子 |
| `pnpm test` | 运行全部 vitest 用例（见第 8 节） |
| `pnpm typecheck` | `tsc --noEmit` 类型检查 |

不经浏览器的冒烟检查：

```bash
curl http://localhost:3001/api/bootstrap      # 身份列表与 model.mode
```

### 重置演示数据

演示步骤会修改数据（订单变为已退款、席位与工单状态等）。需要回到初始状态时，先停止服务，再删除数据库文件并重新初始化：

```bash
rm -f data/app.db data/app.db-wal data/app.db-shm data/checkpoints.db data/checkpoints.db-wal data/checkpoints.db-shm
pnpm db:init
```

（macOS zsh 下 `rm data/*.db*` 在没有匹配文件时会报错，所以这里逐个列出并使用 `-f`。）两个库必须一起删除：checkpoint 库里保存着依赖业务库记录的线程。

### 配置真实模型（可选）

```dotenv
# .env 示例一：Anthropic
MODEL_PROVIDER=anthropic
MODEL_NAME=<你要使用的模型名>
ANTHROPIC_API_KEY=<你的密钥>

# .env 示例二：OpenAI 或兼容服务
MODEL_PROVIDER=openai
MODEL_NAME=<你要使用的模型名>
OPENAI_API_KEY=<你的密钥>
OPENAI_BASE_URL=<可选，兼容服务地址>
```

改完重启 `pnpm dev`，顶部徽标会从“Mock 模式”变为真实模型名称。第 7 节演示脚本里的固定回复文案是 Mock 模式的；真实模型的措辞会不同，但工具调用链、状态变化与页面现象应保持一致。

---

## 6. 三个页面

身份切换仅用于本地演示：前端在请求头里带 `x-role`（`customer` / `agent` / `reviewer`）与 `x-actor-id`，所选身份记在浏览器 localStorage（每个角色独立）。**后端对每个请求都重新查库校验角色，并在服务层校验客户归属与席位归属**，不依赖前端限制：身份不存在返回 401，角色不符或访问他人资源返回 403；`threadId` 等多余字段会被 422 拒绝，thread_id 永不从客户端接收。

初始身份：客户“客户甲 / 客户乙 / 客户丙”，客服席位“A / B / C”（默认在线，每席位最多同时接待 2 张工单），独立的“退款审核员”。

### 客户端 `#/customer`

- 顶部“当前客户”下拉切换身份。
- 左栏“我的咨询”：本人的工单列表和“新建咨询”按钮。发送第一条消息时后端自动建单并分配席位；后续消息保持原工单；点“新建咨询”后发送的下一条消息才会新开工单。
- 中栏：工单信息条（工单号、状态标签“排队中/已分配/已结束”、所属客服、接待状态标签“AI 接待中/人工接管中”、“申请转人工”按钮）和聊天区。
  - AI 回复带“AI 回复”徽标；人工回复带“人工回复 · 客服 X”徽标；系统通知带“系统”徽标。
  - 引用知识时，回复下方显示来源角标“来源《标题》v版本”。
  - AI 处理中显示“AI 正在回复…”。工单结束后输入框禁用，提示“该工单已结束，请点击‘新建咨询’”。
  - 不展示提示词、MCP 参数、thread_id 等内部实现细节。
- 右栏：“我的订单”（订单号、支付状态、物流状态、运单号）与“我的退款”（申请号、状态、金额、审核意见、说明）。
- 页面每 2 秒轮询；刷新页面后需在“我的咨询”里点选工单，即可从服务端恢复完整记录。

### 客服工作台 `#/agent`

- 顶部“当前席位”下拉切换为“客服 A / B / C”；显示本席位在线状态、接待数“接待 n/容量”和“上线 / 下线”按钮；还有三个席位的负载与“等待队列 N”。
- 左栏“我的工单”，可按“进行中 / 已结束 / 全部”过滤，只列本席位的工单。
- 中栏：客户名与工单号、状态与接待状态标签、“客户要求人工”红点；操作栏有“接管”“恢复 AI”“转派给…”下拉与“转派”（离线或已满席位不可选）、“结束服务”；下方是聊天记录和回复框。回复框仅在接管后可用（未接管提示“请先接管”）。
- 当 AI 回复因接管被拦截时，聊天区底部提示“有 N 条 AI 回复因人工接管已被拦截”。
- 右栏：“AI 排查摘要”（客户诉求、查到的订单/支付状态、已给出的知识来源、退款申请号）、该客户的订单、“本工单退款申请”，以及仅客服可见的 threadId。

### 审核台 `#/reviewer`

- 固定身份“退款审核员”。
- 左栏“退款申请”：按“全部 / 待审核 / 已退款 / 已拒绝 / 失败”过滤，列出申请号、金额、客户、订单和状态标签。
- 右侧详情：申请信息（客户、订单、金额、退款理由、版本与尝试次数、失败原因、审核决定）；“审核”区——“审核意见”必填（1–500 字），按钮“批准”“拒绝”；执行失败时出现“执行失败”区和“重试执行”按钮；“订单与支付快照”“证据：对话摘录”“执行记录”“通知（outbox）”“流程日志”；以及“Graph 状态”（threadId、checkpoint 有无、next、是否等待审核）。

---

## 7. 浏览器演示步骤

以下八步对应交付要求中的浏览器演示脚本，按 Mock 模式的实际界面文案编写。

**准备**：按第 5 节“重置演示数据”回到初始状态后执行 `pnpm dev`；浏览器打开三个标签页，分别访问 `#/customer`、`#/agent`、`#/reviewer`。下文的“客户端”“客服工作台”“审核台”即这三个标签页。种子订单（金额单位元）：

| 订单 | 客户 | 商品 | 金额 | 状态 |
| - | - | - | - | - |
| ORD-1001 | 客户甲 | 无线降噪耳机 | ¥599.00 | 已支付 |
| ORD-1002 | 客户甲 | 手机保护壳 | ¥39.00 | 未支付 |
| ORD-1003 | 客户乙 | 智能手表 | ¥1299.00 | 已支付（首次退款执行会模拟渠道失败） |
| ORD-1004 | 客户乙 | 快充充电器 | ¥99.00 | 已退款（模拟） |
| ORD-1005 | 客户丙 | 蓝牙音箱 | ¥299.00 | 已支付 |
| ORD-1006 | 客户丙 | 数据线 | ¥19.90 | 未支付 |
| ORD-1007 | 客户甲 | 年度会员 | ¥199.00 | 已退款（模拟） |

### ① 三个客户各发“你好”，看到分配到 A / B / C

1. 客户端“当前客户”选“客户甲”，发送 `你好`。
2. 切换到“客户乙”发送 `你好`，再切换到“客户丙”发送 `你好`。

预期：
- 每位客户的聊天区依次出现：客户消息、系统消息“已为您分配人工客服 A。”（乙为 B，丙为 C）、带“AI 回复”徽标的问候（以 `[Mock 模式] 您好，我是智能客服助手…` 开头）。
- 信息条显示“客服 A / B / C”“已分配”“AI 接待中”。
- 客服工作台切换“客服 A / B / C”，各自只看到对应客户的一张工单；切换客户后，客户端看不到其他客户的工单与订单。

### ② 客户甲问知识问题，看到来源角标

1. 客户端切回“客户甲”，发送 `怎么修改收货地址？`。

预期：AI 回复以 `[Mock 模式] 根据《修改收货地址》v2：…` 开头并以“来源：《修改收货地址》v2”结尾，气泡下方出现来源角标“来源《修改收货地址》v2”。

### ③ 问没有依据的政策，看到“无依据”而不是编造

1. 客户甲发送 `你们对宠物保险的理赔政策是什么？`。

预期：回复为“抱歉，目前没有找到可以支持回答该问题的依据，我不能凭猜测答复。您可以补充更多细节…或申请转人工客服。”，没有来源角标，也没有任何编造的理赔政策。

### ④ 越权查询订单被拒绝

1. 客户甲发送 `帮我查一下订单 ORD-1003`（ORD-1003 属于客户乙）。

预期：回复“抱歉，系统校验显示该订单不属于您当前登录的账户，无法为您查询或办理。…”，不出现智能手表或金额。这次查询真实经过 MCP 子进程，被 MCP 的归属校验拒绝（回复里看不到 MCP 参数）。想核对 MCP 审计日志，可在停服或另开终端后执行：

```bash
sqlite3 data/app.db "select event, ref_id from execution_logs where scope='mcp' order by id desc limit 5"
```

应能看到 `denied` 记录。

补充：发送 `我的订单` 会得到 ORD-1001 / 1002 / 1007 三笔，不含他人订单。

### ⑤ 退款：提交 → 审核台批准 → 客户端看到通知与“已退款（模拟）”

1. 客户甲发送 `我要申请退款 ORD-1001`。预期回复：“已核对订单 ORD-1001（无线降噪耳机，已支付 ¥599.00）。请告诉我退款理由，例如：‘原因是质量问题’。”
2. 发送 `原因是质量问题`。预期回复：“已为您提交退款申请 RF-…（订单 ORD-1001，金额 ¥599.00），当前状态：待审核。退款需经人工审核…在此之前退款尚未完成。”随后约一秒内出现系统通知“【退款进度】您的退款申请 RF-… 已提交，正在等待人工审核…”。客户端右栏“我的退款”出现状态“待审核”，订单仍为“已支付”。
3. （等待期间继续聊天）客户甲发送 `我的退款进度怎么样了`：AI 列出该申请及“待审核”；也可继续问 `怎么修改收货地址？` 得到正常回复。
4. 审核台：左栏出现该申请，状态“待审核”，点开后详情含订单快照、对话摘录、“Graph 状态”（next 为 `await_decision`，等待审核“是”）。填写“审核意见”（例如“同意”），点“批准”。
5. 审核台：状态变为“已退款（模拟）”，“执行记录”有 1 条“成功”，“通知（outbox）”两条均“已发送”，Graph 状态 next 为 `-`。
6. 客户端（约 1 秒内自动刷新）：聊天区出现系统通知“【退款进度】退款申请 RF-… 已审核通过并完成模拟退款，订单 ORD-1001 已更新为‘已退款（模拟）’，金额 ¥599.00。”；右栏订单 ORD-1001 的支付状态变为“已退款（模拟）”，“我的退款”显示“已退款（模拟）”和审核意见。

### ⑥ 退款执行失败 → 审核台重试 → 成功

1. 客户端切到“客户乙”，发送 `我要申请退款 ORD-1003`，再发送 `原因是不想要了`，得到申请 RF-… 待审核。
2. 审核台选中该申请，填写意见，点“批准”。
3. 预期：状态变为“退款失败”，失败原因“模拟支付渠道退款失败（演示用，可重试）”；“执行记录”有 1 条“失败”；页面出现“执行失败”区和“重试执行”按钮；订单仍为已支付。客户端收到系统通知“【退款进度】退款申请 RF-… 暂未执行成功，我们已记录原因并将由审核员跟进处理，请耐心等待。”（不向客户暴露内部失败原因）。
4. 在审核台点“重试执行”。预期：状态变为“已退款（模拟）”，“版本 / 尝试”显示“第 2 次”，“执行记录”共 2 条（1 失败 + 1 成功），Graph 状态的 threadId 以 `:a2` 结尾；客户端收到“已审核通过并完成模拟退款”通知，订单 ORD-1003 变为“已退款（模拟）”。

补充：用客户丙对 ORD-1005 提交退款并在审核台点“拒绝”（填写拒绝意见），订单保持“已支付”，客户收到“很抱歉，退款申请 … 未通过审核。审核意见：…”，且没有“重试执行”按钮。

### ⑦ 客服接管：AI 不再回复，人工回复带徽标，恢复 AI

1. 客服工作台选“客服 A”，在“我的工单”点开客户甲的工单，点“接管”。预期：聊天区追加系统消息“人工客服 A 已接入，AI 助手暂停自动回复。”，接待状态标签变为“人工接管中”，回复框可用。
2. 客户端（客户甲）：信息条标签变为“人工接管中”。发送 `在吗，我想再确认一下发货时间`。预期：消息出现，但**没有** AI 回复，也不显示“AI 正在回复…”。
3. 客服工作台在回复框输入 `您好，我是客服 A，马上为您核实`，点“发送回复”。客户端该条回复带徽标“人工回复 · 客服 A”。
4. 客服工作台点“恢复 AI”。预期：系统消息“AI 助手已恢复服务。”，标签回到“AI 接待中”。
5. 客户端再发送 `退款多久到账`。预期：AI 恢复回复，并带来源角标“来源《退款到账时间》v2”。

另有两个相关演示：

- 客户端点“申请转人工”：接待状态立即变为“人工接管中”，系统消息“已为您申请人工客服，请稍候，人工客服接入前 AI 助手将暂停自动回复。”；客服工作台该工单出现“客户要求人工”红点。
- **接管抢答被拦截**：停掉服务，改用 `MOCK_DELAY_MS=5000 pnpm dev` 重新启动（每次模型生成前延迟 5 秒）。客户丙发送 `怎么修改收货地址？`，看到“AI 正在回复…”时，立刻到客服工作台（客服 C）打开该工单点“接管”。预期：客户端始终没有出现 AI 回复；客服工作台聊天区底部提示“有 1 条 AI 回复因人工接管已被拦截”。

### ⑧ 刷新页面，记录完整恢复

1. 对三个页面分别按 F5 刷新。
2. 客户端：身份保持（localStorage），在“我的咨询”点开工单后，完整历史按原顺序出现——客户消息、系统消息、AI 回复及其来源角标、人工回复及徽标、各类“【退款进度】”通知；右栏订单与退款状态与刷新前一致。
3. 客服工作台：身份与在线状态保持，点开工单后记录、AI 排查摘要、threadId 与刷新前一致。
4. 审核台：申请列表、状态、执行记录、通知与流程日志与刷新前一致。
5. 进一步：停止并重新运行 `pnpm dev` 后再刷新，所有记录仍然存在（数据全部来自 SQLite）。

### 附加演示：审核等待期间重启服务

1. 客户丙发送 `我要申请退款 ORD-1005` 和 `原因是不想要了`，审核台看到该申请“待审核”（Graph 状态：next 为 `await_decision`，等待审核“是”）。
2. 在终端 Ctrl+C 停止 `pnpm dev`，再重新执行 `pnpm dev`。终端会打印 `[recovery] 退款流程恢复报告`，其中该申请的 `outcome.status` 为 `waiting`。
3. 刷新审核台：申请仍是“待审核”且仍在等待；客户端发送 `我的退款进度怎么样了` 仍能得到“待审核”。
4. 审核台点“批准”：正常完成，订单变“已退款（模拟）”，只有一条成功执行记录，客户只收到一条完成通知。

---

## 8. 测试

```bash
pnpm test         # 运行全部 vitest 用例
pnpm typecheck    # 类型检查
pnpm test tests/05-refund-approval.test.ts   # 只跑某个文件
```

- 当前结果：15 个测试文件、129 个用例全部通过（含 `tests/11-review-fixes.test.ts` 的 15 个代码审查修复回归用例），约 40 秒。
- 全部使用 **Mock 模型**，并启动**真实的 MCP stdio 子进程**（终端里的 `[orders-mcp] started pid=…` 是正常输出）；只测纯业务的用例以 `startMcp: false` 加速。
- 每个用例使用独立的临时目录与独立的 SQLite 文件（业务库 + checkpoint 库），无共享状态；“重启”通过关闭容器后在同一组数据库文件上重建来模拟。崩溃场景通过 `crashPoints` 注入（`before:<节点>` / `after:<节点>` / `mid:execute_refund`），不会修改 `data/` 下的演示数据。
- 真实模型不在自动化测试内，需手工按第 7 节验证，结果见 [`docs/VERIFICATION.md`](docs/VERIFICATION.md)。

### 验收矩阵

`tests/01` 至 `tests/10` 与需求 §7 的十条验收项一一对应：

| 测试文件 | 用例数 | 需求 §7 验收项 | 主要断言 |
| - | - | - | - |
| `01-assignment-isolation` | 9 | 三个客户发起咨询后分配到 A/B/C，历史与订单互相隔离 | 首条消息依次分配 A、B、C；thread_id 互不相同；跨客户读工单/消息被拒绝；订单只含本人；401/403/422 校验；各客户 Agent 线程互相独立 |
| `02-dedupe-queue` | 10 | 重复消息不重复建单；离线、满员和排队规则有效 | 同一 `clientMessageId` 不重复建单/入库/建 run；离线席位被跳过；满员后排队、结单后出队、席位上线后出队；后续消息保持原分配；`newTicket` 才新建 |
| `03-knowledge` | 3 | 知识回答有来源；未知政策不编造 | 命中时回复含标题与版本且 `sources` 一致；无依据时明确说明并建议转人工，无来源 |
| `04-mcp` | 8 | 查询经过真实 MCP，越权访问被拒绝 | 工具结果来自另一进程（`mcp_structured_content` 的 pid 不同）；他人订单 `FORBIDDEN`；模型伪造 `customer_id`/令牌被丢弃；错误令牌 `UNAUTHORIZED`；模型可见 schema 不含可信字段 |
| `05-refund-approval` | 9 | 未审批和被拒绝的申请不能退款；批准后只执行一次 | 对话式提交、`interrupt` 等待；伪造 `resume({approved:true})` 无效；拒绝不退款且不可重试；批准后订单已退款、success 恰 1 条；失败后重试成功；重复/无效申请的边界结果 |
| `06-chat-during-review` | 1 | 等待审核期间，对话仍可继续，客户能够查询进度 | 待审核时同一工单继续问答、`get_refund_progress` 查进度；退款 Graph 仍停在 interrupt，两条线程互相独立 |
| `07-restart-waiting` | 2 | 审核等待期间重启，能够恢复正确的退款流程 | 重启后 interrupt 保留、恢复报告为 `waiting`，批准后只执行一次；变体：决定已落库但恢复失败，重启恢复后只退款一次 |
| `08-crash-recovery` | 6 | 审批后执行前、执行后通知前分别重启，结果仍正确 | 参数化 5 个崩溃点（`before:execute_refund`、`mid:execute_refund`、`after:execute_refund`、`before:enqueue_notification`、`after:enqueue_notification`）+ `after:register_review`；重启恢复后 success 恰 1 条、通知恰 1 条 |
| `09-idempotency-concurrency` | 8 | 重复回调、并发审批、节点恢复不会重复退款 | 重复 `decide` 幂等；并发批准/批准与拒绝；重复恢复与伪造 resume 不改变执行行数；outbox 重试与投递幂等，通知重试不触发退款；超过最大次数后标记 `failed` |
| `10-takeover` | 5 | 人工接管后 AI 不抢答；刷新页面恢复真实记录 | 慢回复期间接管，AI 结果被抑制（`suppressed`）；未接管不能回复；接管→人工回复→恢复 AI 的完整回放顺序固定，重启后与之前完全一致；客户转人工；AI 工具转人工 |

其余测试：

| 测试文件 | 用例数 | 内容 |
| - | - | - |
| `batch1-mcp-server` | 10 | 真实 MCP 子进程：四个 `orders_*` 工具与只读标注、令牌签名与校验、归属校验、订单不存在、`scope='mcp'` 审计日志 |
| `batch1-repos` | 12 | 迁移与种子幂等且不覆盖运行期修改、事务回滚、各仓储的条件更新与唯一约束、`KeyedMutex` |
| `unit-knowledge` | 18 | 知识库数据（14 条、id 唯一）、检索命中与不命中样例、`topK` 与排序的确定性、摘要截断 |
| `unit-mock-model` | 13 | Mock 模型的意图判定与工具调用步骤 |

---

## 9. 数据库迁移与种子数据

- **迁移**：`server/db/migrations/*.sql` 按文件名顺序执行，已执行的版本记录在 `schema_migrations` 表，每个迁移文件在单个事务内执行。当前只有 `0001_init.sql`（全部业务表、约束与索引）。新增结构变更请新增 `0002_xxx.sql`，不要修改已发布的迁移。
- **幂等种子**：`server/db/seed.ts` 在一个事务内执行；业务数据全部用 `INSERT OR IGNORE`，**不会覆盖运行期修改**（如席位在线状态、订单的退款状态）；知识库按 `id` upsert，修改 `knowledge/entries.json` 后重启或再次 `pnpm db:init` 即可更新。
- **何时执行**：`pnpm db:init` 手动执行；后端启动（`buildContainer`）也会自动执行迁移与种子。两者都可重复执行，行数不变。
- **种子内容**：客户 3（`cust_a/b/c`：客户甲/乙/丙）、客服席位 3（`seat_A/B/C`，默认在线，容量 2）、审核员 1（`reviewer_1`：退款审核员）、订单 7 与支付记录 7（覆盖未支付、已支付、已退款；ORD-1003 带一次性的退款失败注入标记）、知识 14 条（产品使用、支付异常、退款政策等，每条含标题与版本）。
- **两个库**：业务库 `data/app.db` 与 LangGraph checkpoint 库 `data/checkpoints.db`（路径由 `DB_PATH`、`CHECKPOINT_DB_PATH` 配置）；SQLite 启用 WAL 与外键，运行时会出现 `-wal`、`-shm` 附属文件。数据库文件不入库（`.gitignore`）。
- 金额一律用最小货币单位整数（分）存储。

---

## 10. 文档索引

| 文档 | 内容 |
| - | - |
| [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) | 需求原文（逐字保留） |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 架构约束与已锁定的依赖/API 事实，是 SPEC 的上位约束 |
| [`docs/SPEC.md`](docs/SPEC.md) | 实现 Spec：文件清单与签名、完整 DDL 与种子、知识库与检索算法、HTTP API 契约（§D）、领域状态机（§E）、Agent 与 MCP（§F）、Mock 模型（§G）、退款 Graph（§H）、Outbox（§I）、前端（§J）、测试计划（§K）、环境变量与启动（§L）、实现批次与已知限制（§M 及附录） |
| [`docs/STATES.md`](docs/STATES.md) | 状态说明（定稿）：工单、会话接待与 AI run、退款申请、outbox 的状态机；退款 Graph 节点与边；interrupt/resume 时序；启动恢复判定表；崩溃点清单 |
| [`docs/VERIFICATION.md`](docs/VERIFICATION.md) | 验证记录：Mock 验证、真实模型验证、浏览器实测、未验证的外部依赖、企业试点仍需补齐的能力 |
| [`docs/SPIKE-FINDINGS.md`](docs/SPIKE-FINDINGS.md) | 对当前依赖版本的实测结论（MCP 链路、LangGraph 中断与恢复） |
| [`docs/refs/`](docs/refs/) | LangChain、LangGraph、MCP 接入文档的离线参考 |

---

## 11. 已知限制

来自 SPEC 附录：

- 被抑制（`suppressed`）的 AI 回复仍留在该会话的 Agent checkpoint 中（客户不可见）；真实模型在后续轮次可能“记得”它。试点需在接管时向线程追加说明，或裁剪线程。
- 人工接管期间的客户消息与客服消息不写入 Agent 线程；恢复 AI 后模型看不到人工对话的内容。
- 单进程内存锁（`KeyedMutex`）只保证单实例内串行；多实例部署需要分布式锁或数据库队列。
- 模拟退款不连接真实支付渠道；微信、飞书渠道仅有适配器桩（`server/channels/{wechat,feishu}.ts`）。

核对实现时补充的限制：

- 仅提供本地开发模式，没有生产构建、静态托管与部署脚本；身份切换仅用于演示，没有真实登录与会话管理。
- 排队中的工单没有席位，客服无法经 API 结束它；它需要先出队（席位上线或有容量释放）后才能结束。
- outbox 的 `failed` 是终态，不会自动再试，需要人工处理（审核台“通知（outbox）”表可见）。
- Vite 的 `/api` 代理目标只读取进程环境变量 `SERVER_PORT`（见第 4 节），不读取 `.env`。
- AI run 在进程重启时若处于 `running`，会被标记为 `failed`（`interrupted_by_restart`），不会自动重答，客户需再发一条消息。
- 自动化测试只覆盖 Mock 模型；真实模型的回复质量、工具调用稳定性与成本未纳入自动化验证。

企业试点仍需补齐的能力、未验证的外部依赖，见 [`docs/VERIFICATION.md`](docs/VERIFICATION.md)。

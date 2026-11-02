# 验证报告（2026-11-02）

本报告记录首版交付时实际执行过的验证、未验证的外部依赖，以及企业试点仍需补齐的能力。验证环境：macOS（Darwin 27.0.0）、Node v26.8.2、pnpm 10.34.4，模型为 **Mock 模式**（本机无模型凭据）。

## 1. 自动化测试（Mock 模型 + 真实 MCP 子进程）

命令：`pnpm typecheck && pnpm test`

| 结果 | 数值 |
| - | - |
| 类型检查 | 通过（server、mcp-server、web/src、tests 全部纳入 tsconfig） |
| 测试文件 | 15 个全部通过 |
| 测试用例 | 129 个全部通过，0 个跳过 |

需求 §7 验收项与测试文件的对应关系：

| 验收项 | 测试文件 | 关键断言 |
| - | - | - |
| 三客户分配到 A/B/C，历史与订单互相隔离 | `tests/01-assignment-isolation.test.ts` | 三张工单席位分别为 A/B/C；thread_id 互不相同；跨客户读工单 403、未知身份 401、角色不符 403；请求体带 `threadId` 被 422 拒绝；AI 回复与订单列表不泄露他人数据 |
| 重复消息不重复建单；离线、满员、排队 | `tests/02-dedupe-queue.test.ts` | 同一 clientMessageId 两次请求返回 201 + 200(duplicate)，工单/消息/AI run 各 1；离线席位被跳过；容量 2 满员后第 7 张进入队列，结单后出队；全部离线 → 排队 → 上线出队；后续消息沿用原工单 |
| 知识回答有来源；未知政策不编造 | `tests/03-knowledge.test.ts`、`tests/unit-knowledge.test.ts` | 命中时回复含“《修改收货地址》v2”且 `sources` 为 kb-001；宠物保险问题回复含“没有找到可以支持回答该问题的依据”“转人工”，`sources` 为空 |
| 查询经过真实 MCP，越权访问被拒绝 | `tests/04-mcp.test.ts`、`tests/batch1-mcp-server.test.ts` | ToolMessage 的 `artifact` 含 `mcp_structured_content`，`served_by.pid` 为另一进程；MCP 子进程写入 `execution_logs(scope='mcp')`；他人订单返回 `FORBIDDEN:`；模型伪造 `customer_id/context_token` 被服务端可信值覆盖；模型可见 schema 不含身份字段；错误 token → `UNAUTHORIZED:` |
| 未审批、被拒绝的申请不能退款；批准后只执行一次 | `tests/05-refund-approval.test.ts` | 伪造 `Command({resume:{approved:true}})` 不退款且仍在 interrupt；拒绝后订单保持 paid、retry 返回 409；批准后 `refund_executions` 恰 1 条 success、订单 refunded、outbox 1 行；ORD-1003 预置失败 → failed → 重试 attempt=2 成功 |
| 等待审核期间对话可继续、可查进度 | `tests/06-chat-during-review.test.ts` | 申请 pending_review 期间同一工单知识问答正常；“我的退款进度怎么样了”触发 `get_refund_progress` 并回复“待审核”；退款 Graph 仍在 interrupt；对话 thread 与退款 thread 不同 |
| 审核等待期间重启能恢复 | `tests/07-restart-waiting.test.ts` | 用同一组 db 文件重建容器后 `recoverRefundFlows` 返回 waiting，`inspect` 仍有 1 个 interrupt；之后批准正常完成；变体：决定已落库但恢复失败（崩溃于 `before:verify_decision`）→ 重启恢复 → 正确退款 |
| 审批后执行前、执行后通知前重启 | `tests/08-crash-recovery.test.ts` | 崩溃点 `before:execute_refund`、`mid:execute_refund`、`after:execute_refund`、`before:enqueue_notification`、`after:enqueue_notification`、`after:register_review` 六种，恢复后 success 执行记录恰 1 条、通知恰 1 条、`flow_completed_at` 非空 |
| 重复回调、并发审批、节点恢复不重复退款 | `tests/09-idempotency-concurrency.test.ts` | 重复 decide 返回 `idempotent:true`；并发 approve×2 仅 1 次执行；approve 与 reject 并发一个 409 `ALREADY_DECIDED`；完成后重复 drive / 直接 resume 执行行数不变；outbox 投递失败重试与“已发送重置为 pending”均不产生第二条通知，也不触碰订单 |
| 人工接管后 AI 不抢答；刷新恢复真实记录 | `tests/10-takeover.test.ts` | 慢回复（400ms）期间接管 → AI 结果 suppressed、无 AI 消息；接管期间客户消息不创建 AI run；未接管 reply 409；恢复 AI 后再次回复；消息 seq 连续，重启后列表完全一致 |

补充单元测试：`tests/unit-mock-model.test.ts`（Mock 规则引擎的意图判定、多轮工具步骤、确定性）、`tests/batch1-repos.test.ts`（迁移幂等、种子幂等、条件更新、唯一约束、KeyedMutex）、`tests/11-review-fixes.test.ts`（第 5 节代码审查修复项的回归，15 个用例）。

## 2. 浏览器实测（内置浏览器，`pnpm dev`，三个页面）

| 步骤 | 页面 | 观察到的结果 |
| - | - | - |
| 客户甲发“你好” | 客户端 | 自动建单 TK-…，系统消息“已为您分配人工客服 A。”，AI 回复以 `[Mock 模式]` 开头，徽标“AI 回复” |
| “怎么修改收货地址？” | 客户端 | 回复引用“《修改收货地址》v2”，气泡下方来源角标 |
| “你们对宠物保险的理赔政策是什么？” | 客户端 | 明确“没有找到可以支持回答该问题的依据”，建议转人工，无来源角标 |
| “帮我查一下订单 ORD-1003”（客户乙的订单） | 客户端 | “该订单不属于您当前登录的账户，无法为您查询或办理”，未泄露商品名与金额 |
| “我要申请退款 ORD-1001” → “原因是质量问题” | 客户端 | 先核对订单并追问理由，再提交 RF-20261102-E12582，状态“待审核”，并收到“【退款进度】…已提交”系统通知；右栏退款面板出现该申请 |
| “我的退款进度怎么样了” | 客户端 | 列出申请号与“待审核” |
| 打开申请详情并批准 | 审核台 | 详情含订单/支付快照、对话证据、outbox、流程日志、Graph 状态（next=await_decision，等待审核=是）；批准后执行记录 1 条成功、通知 2 条已发送、Graph 日志 claimed → executed → result_recorded → notified |
| 回到客户端刷新 | 客户端 | 系统通知“已审核通过并完成模拟退款”，订单 ORD-1001 显示“已退款（模拟）”，退款面板显示审核意见；刷新后历史完整 |
| 席位 A 接管工单 | 客服工作台 | 接待状态变为“人工接管中”，系统消息“人工客服 A 已接入，AI 助手暂停自动回复。” |
| 客户甲再发“退款多久到账？” | 客户端/API | 不创建 AI run（aiRunId=null），无 AI 回复 |
| 客服 A 回复、恢复 AI | 客服工作台 | 人工消息徽标“人工回复 · 客服 A”；恢复后系统消息“AI 助手已恢复服务。”；AI 排查摘要同步更新 |
| 恢复 AI 后客户再问“退款多久到账？” | 客户端/API | AI 回复引用“《退款到账时间》v2” |
| 客户乙“ORD-1003 申请退款，原因是不想要了” → 审核台批准 | 审核台 | 分配到席位 B；批准后状态“退款失败”，失败原因仅审核台可见，出现“重试执行”按钮 |
| 点击“重试执行” | 审核台 | 第 2 次尝试成功，状态“已退款（模拟）”，执行记录 1 失败 + 1 成功 |
| 客户丙“ORD-1005 申请退款，原因是尺寸不合适”后 **真实重启** 前后端进程 | 服务日志 / 审核台 | 分配到席位 C；重启日志打印恢复报告 `status: waiting`，Graph 仍 `next=await_decision`、checkpoint 存在；重启后批准成功，客户丙页面收到完成通知、订单 ORD-1005 变为“已退款（模拟）” |

界面始终显示橙色“Mock 模式”徽标；客户端不展示 thread_id、工具名、提示词或 MCP 参数。

## 3. 真实模型验证

**未验证。** 本机未配置 `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY`，系统按设计自动回落 Mock 模式。启用方式：在 `.env` 设置 `MODEL_PROVIDER=anthropic`（或 `openai`）、`MODEL_NAME` 与对应密钥（OpenAI 兼容服务可设 `OPENAI_BASE_URL`），重启后 `/api/bootstrap` 的 `model.mode` 与界面徽标会切换为真实模型；按 README 的演示脚本重走一遍即可。真实模型下系统提示词要求引用格式“来源：《标题》vX”，`sources` 角标依赖该格式被模型遵守，建议首轮验证重点观察知识引用与退款流程的工具调用顺序。

## 4. 未验证的外部依赖

- 真实支付渠道退款：第一阶段为模拟退款（订单置为“已退款（模拟）”），无支付平台调用。
- 微信、飞书渠道：仅有适配器桩（`server/channels/wechat.ts`、`feishu.ts`），未接入。
- 业务 API / 多维表格数据源：数据访问层接口已预留（`server/repos/interfaces.ts`、`mcp-server/repo.ts`），当前仅 SQLite 实现。
- 真实大模型的行为稳定性（见第 3 节）。
- 多进程 / 多实例部署下的并发：当前锁为单进程内存锁。

## 5. 开发过程中发现并修复的缺陷

- **退款 Graph 被当作 Agent 子图**：在 Agent 工具 `submit_refund_request` 内启动退款 Graph 时，LangGraph 通过 AsyncLocalStorage 继承了外层 Agent 的运行配置，interrupt 被作为异常抛出且 checkpoint 未写入；修复为在独立 ALS 上下文中驱动退款 Graph（`server/graphs/refund/runner.ts` 的 `isolated()`），并由 `tests/05`、`tests/06` 的对话路径用例守护。
- **后端端口与预览工具冲突**：工具注入的 `PORT` 环境变量导致后端抢占前端端口；改为 `SERVER_PORT` 优先。

### 5.1 独立代码审查（Opus，只读）结论与处置

审查范围：权限与隔离、可信上下文、退款流程正确性、并发与抑制、outbox、数据层约束。结论：**无高危问题**；双重退款由“success 部分唯一索引 × 条件更新 × 申请级互斥锁”三层阻断，权限隔离与可信上下文注入未发现绕过路径。中低风险发现及处置如下（均有 `tests/11-review-fixes.test.ts` 用例守护）：

| 发现 | 处置 |
| - | - |
| 接管/结单后在途 AI run 仍可执行有副作用的工具（提交退款、登记转人工） | 已修复：`server/agent/run-guard.ts` 守卫要求 run 为 running、generation 一致、接待状态为 ai；`RefundService.submit` 在写事务内再校验一次 |
| 被抑制的 AI 回复残留在 Agent 线程 checkpoint | 已修复：写回判定 suppressed 后用 `RemoveMessage` + `updateState` 移除该轮消息 |
| 进程在工具调用中途崩溃后线程留下悬空 tool_call，真实模型会拒绝后续请求 | 已修复：`recoverRuns` 为悬空 tool_call 补 error ToolMessage，并向客户写“请重新发送”的系统消息 |
| `retry` 不在申请锁内且不要求上一轮流程完成 | 已修复：retry 在 `refund:<id>` 锁内执行；`flow_completed_at` 为空时先补跑旧线程 |
| 执行节点未复核支付记录状态 | 已修复：tx-B 增加 `payment.status='succeeded'` 校验与 `markPaymentRefunded` 变更行数断言 |
| 本地工具内部异常原文进入模型上下文 | 已修复：统一返回 `UNAVAILABLE`，原始错误只写日志 |
| 模型生成的转人工原因暴露给客户 | 已修复：客户视角 DTO 的 `handoverReason` 固定为 null |
| MCP 子进程继承完整环境变量；共享密钥有默认值 | 已修复：子进程环境变量白名单；默认密钥启动告警 |
| CORS 允许任意来源，身份又靠请求头 | 已修复：origin 限定为 localhost / 127.0.0.1 |
| 重启时被中断的 run 静默失败 | 已修复：并入悬空 tool_call 修复，向客户写系统提示 |
| MCP 对他人订单返回 FORBIDDEN、不存在返回 NOT_FOUND，可被用于枚举订单号是否存在 | **有意保留**：需求要求演示“越权访问被拒绝”，FORBIDDEN 便于验收观察；试点可统一改为 NOT_FOUND，审计日志仍记录 not_owner |
| 校验失败（无审核决定）的申请与执行失败共用“审核员将跟进”文案，但前者不可重试 | **记录为已知限制**：试点需单独的状态/模板（如“申请未通过校验，可重新提交”） |
| 人工接管期间的客户/客服消息不进入 Agent 线程，恢复 AI 后模型看不到人工对话 | **记录为已知限制**（见第 6 节第 7 条） |

## 6. 企业试点仍需补齐的能力

1. 身份与鉴权：当前以请求头模拟身份，试点需接入真实登录（SSO/OAuth）与会话令牌，客服与审核员需 RBAC。
2. 渠道接入：实现微信/飞书适配器（消息入站签名校验、出站模板消息、会话映射持久化）。
3. 数据源：用业务订单/支付 API 或多维表格实现 `OrderRepo`/`OrderReadRepository`，并处理分页、超时与重试。
4. 真实退款执行：接入支付平台退款 API，执行节点需处理异步回调、部分退款与对账。
5. 模型治理：真实模型下的提示词评测、引用格式校验、敏感词与 PII 处理、调用成本与限流、LangSmith 追踪。
6. 运行形态：多实例部署需把 KeyedMutex 换成数据库/Redis 锁，outbox worker 需单实例或租约；checkpoint 库建议迁移到 Postgres。
7. 会话上下文：人工接管期间的客户/客服消息不进入 Agent 线程，恢复 AI 后模型看不到人工阶段的承诺与结论，试点需在恢复时把人工对话注入上下文（被抑制的 AI 回复已在抑制时从线程移除）。
8. 运维：审计日志归档、告警（outbox 持续失败、退款 failed）、数据备份与演示数据重置脚本的权限控制。
9. 前端：实时推送（WebSocket/SSE）替代 2 秒轮询，移动端适配，无障碍。

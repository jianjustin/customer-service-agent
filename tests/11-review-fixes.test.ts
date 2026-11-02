// 独立代码审查修复的回归测试：副作用守卫、被抑制回复清理、崩溃后线程修复、retry 加锁、
// 执行节点支付校验、工具异常脱敏、客户视角转人工原因、MCP 环境变量白名单、CORS。
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMcpChildEnv } from "../server/agent/tools/mcp";
import { DEFAULT_MCP_SHARED_SECRET, warnIfDefaultSecret } from "../server/config";
import { buildTestContainer, makeTestEnv, restart, sendAndWait, waitFor, type Container, type TestEnv } from "./helpers/env";
import { call, startHttp } from "./helpers/http";
import { REVIEWER, count, createPendingRefund, execCount, orderStatus, outboxRows } from "./helpers/refund";

let env: TestEnv;
let c: Container | null;
let http: { baseUrl: string; close(): Promise<void> } | null;

beforeEach(() => {
  env = makeTestEnv();
  c = null;
  http = null;
});
afterEach(async () => {
  await http?.close();
  await c?.close();
  env.cleanup();
});

/** 为构造 ai_run 单独插入一条客户消息（trigger_message_id 唯一） */
const triggerMessage = (cc: Container, conversationId: string, customerId: string) =>
  cc.repos.messages.insert({ conversationId, senderType: "customer", senderId: customerId, content: "触发消息", at: new Date().toISOString() });

const runStatus = (cc: Container, runId: number) => (cc.db.prepare("SELECT status FROM ai_runs WHERE id = ?").get(runId) as { status: string }).status;

describe("1. 接管后在途 AI run 不得执行副作用工具", () => {
  it("退款：AI 处理“ORD-1005 申请退款”期间被接管 → 无 refund_requests、无 submitted 通知、run 为 suppressed", async () => {
    c = await buildTestContainer(env, { mockDelayMs: 300 });
    // 方法：MockChatModel 每次 _generate 前等待 300ms。run 进入 running 后立刻接管（此时第一次模型调用还在等待），
    // 随后 Mock 依次调用 orders_get_order / orders_get_payment_status（只读，放行）再调用 submit_refund_request（被守卫拦截）。
    const r = c.services.conversation.handleCustomerMessage({
      customerId: "cust_c",
      content: "ORD-1005 申请退款，原因是尺寸不合适",
      clientMessageId: "g1",
    });
    expect(r.ticket.seat_id).not.toBeNull();
    await waitFor(() => runStatus(c!, r.aiRunId!) === "running");
    c.services.handover.takeover(r.ticket.seat_id!, r.ticket.id);

    const outcome = await r.aiRun!;
    expect(outcome.status).toBe("suppressed");
    expect(runStatus(c, r.aiRunId!)).toBe("suppressed");
    expect(count(c, "SELECT COUNT(*) AS n FROM refund_requests")).toBe(0);
    expect(count(c, "SELECT COUNT(*) AS n FROM outbox WHERE dedupe_key LIKE 'refund:%:submitted:%'")).toBe(0);
    expect(count(c, "SELECT COUNT(*) AS n FROM refund_executions")).toBe(0);
    expect(orderStatus(c, "ORD-1005")).toBe("paid");
    // 工具确实被调用过并被守卫拦截（而不是模型根本没走到那一步）
    expect(c.repos.logs.count("conversation", { node: "submit_refund_request", event: "run_cancelled" })).toBe(1);
    expect(c.repos.logs.count("conversation", { node: "submit_refund_request", event: "tool_call" })).toBe(0);
  });

  it("转人工：接管后在途 run 调用 request_human_handover → 不写 handover 标记", async () => {
    c = await buildTestContainer(env, { mockDelayMs: 300 });
    const r = c.services.conversation.handleCustomerMessage({ customerId: "cust_c", content: "我要转人工", clientMessageId: "g2" });
    await waitFor(() => runStatus(c!, r.aiRunId!) === "running");
    c.services.handover.takeover(r.ticket.seat_id!, r.ticket.id);
    expect((await r.aiRun!).status).toBe("suppressed");

    const ticket = c.repos.tickets.get(r.ticket.id)!;
    expect(ticket.handover_requested).toBe(0);
    expect(ticket.handover_reason).toBeNull();
    expect(c.repos.aiRuns.get(r.aiRunId!)!.handover_requested).toBe(0);
    expect(c.repos.logs.count("conversation", { event: "ai_request_ignored" })).toBe(1);
    expect(c.repos.logs.count("conversation", { event: "ai_request" })).toBe(0);
  });

  it("requestByAiTool 直接调用：run 非 running / generation 过期 / 模式非 ai 都返回 RUN_CANCELLED", async () => {
    c = await buildTestContainer(env, { startMcp: false });
    const r = c.services.conversation.handleCustomerMessage({ customerId: "cust_a", content: "你好", clientMessageId: "g3" });
    await r.aiRun; // agent=null → failed
    const ctx = { customerId: "cust_a", ticketId: r.ticket.id, conversationId: r.conversation.id, runId: r.aiRunId! };
    expect(c.services.handover.requestByAiTool(ctx, "x")).toMatchObject({ ok: false, code: "RUN_CANCELLED" });

    // 构造一个 running 且 generation 一致的 run → 放行
    const run = c.repos.aiRuns.insert(r.conversation.id, triggerMessage(c, r.conversation.id, "cust_a").id, r.conversation.ai_generation, new Date().toISOString());
    c.repos.aiRuns.markRunning(run.id, new Date().toISOString());
    expect(c.services.handover.requestByAiTool({ ...ctx, runId: run.id }, "客户要求")).toEqual({ ok: true });
    expect(c.repos.tickets.get(r.ticket.id)!.handover_requested).toBe(1);

    // 接管（generation+1、run 被取消）后再次调用 → 拦截
    c.repos.tickets.setHandoverRequested(r.ticket.id, "", new Date().toISOString());
    c.services.handover.takeover(c.repos.tickets.get(r.ticket.id)!.seat_id!, r.ticket.id);
    expect(c.services.handover.requestByAiTool({ ...ctx, runId: run.id }, "again")).toMatchObject({ ok: false, code: "RUN_CANCELLED" });
  });
});

describe("2. 被抑制的 AI 回复不残留在 Agent 线程", () => {
  it("慢回复期间接管 → 线程中不含该轮消息；恢复 AI 后下一轮只含新一轮", async () => {
    c = await buildTestContainer(env, { mockDelayMs: 300 });
    const r = c.services.conversation.handleCustomerMessage({ customerId: "cust_a", content: "怎么修改收货地址？", clientMessageId: "d1" });
    await waitFor(() => runStatus(c!, r.aiRunId!) === "running");
    c.services.handover.takeover(r.ticket.seat_id!, r.ticket.id);
    expect((await r.aiRun!).status).toBe("suppressed");

    const threadId = c.repos.conversations.get(r.conversation.id)!.thread_id;
    const msgs = await c.agent!.getThreadMessages(threadId);
    expect(msgs).toHaveLength(0);
    expect(c.repos.logs.count("conversation", { event: "discard_turn_failed" })).toBe(0);

    // 恢复 AI 后新的一轮正常工作，线程里只有新一轮
    c.services.handover.resumeAi(r.ticket.seat_id!, r.ticket.id);
    const next = await sendAndWait(c, "cust_a", "你好", { ticketId: r.ticket.id });
    expect(next.outcome?.status).toBe("completed");
    const after = await c.agent!.getThreadMessages(threadId);
    expect(after.filter((m) => HumanMessage.isInstance(m)).map((m) => m.text)).toEqual(["你好"]);
    expect(after.some((m) => m.text.includes("修改收货地址"))).toBe(false);
  });

  it("discardTurn 只移除指定 HumanMessage 及其之后的消息，保留更早的轮次", async () => {
    c = await buildTestContainer(env);
    const first = await sendAndWait(c, "cust_a", "你好");
    const second = await sendAndWait(c, "cust_a", "怎么修改收货地址？", { ticketId: first.ticket.id });
    const threadId = c.repos.conversations.get(first.conversation.id)!.thread_id;
    const before = await c.agent!.getThreadMessages(threadId);
    const removed = await c.agent!.discardTurn(threadId, "msg_" + second.message.id);
    expect(removed).toBeGreaterThanOrEqual(3); // human + ai(tool_calls) + tool + ai
    const after = await c.agent!.getThreadMessages(threadId);
    expect(after.length).toBe(before.length - removed);
    expect(after.map((m) => m.text)).toEqual(before.slice(0, after.length).map((m) => m.text));
    expect(await c.agent!.discardTurn(threadId, "msg_does_not_exist")).toBe(0);
  });
});

describe("3. 崩溃后线程的悬空 tool_call 与客户通知", () => {
  it("recoverRuns：补齐 error ToolMessage、写系统消息、run=failed；之后同会话可继续对话", async () => {
    c = await buildTestContainer(env);
    const first = await sendAndWait(c, "cust_a", "你好");
    const conv = c.repos.conversations.get(first.conversation.id)!;
    // 线程末尾写入悬空的 tool_calls（模拟 AI 发起工具调用后进程崩溃）
    await c.agent!.appendThreadMessages(
      conv.thread_id,
      [
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "dangling_1", name: "search_knowledge", args: { query: "x" }, type: "tool_call" },
            { id: "dangling_2", name: "get_refund_progress", args: {}, type: "tool_call" },
          ],
        }),
      ],
      "model_request",
    );
    // 把一条 ai_run 置为 running
    const at = new Date().toISOString();
    const run = c.repos.aiRuns.insert(conv.id, triggerMessage(c, conv.id, "cust_a").id, conv.ai_generation, at);
    expect(c.repos.aiRuns.markRunning(run.id, at)).toBe(1);

    c = await restart(c, env);
    await c.services.conversation.recoverRuns();

    const row = c.repos.aiRuns.get(run.id)!;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("interrupted_by_restart");
    const msgs = await c.agent!.getThreadMessages(conv.thread_id);
    const tail = msgs.slice(-2);
    expect(tail.every((m) => ToolMessage.isInstance(m))).toBe(true);
    expect(tail.map((m) => (m as ToolMessage).tool_call_id).sort()).toEqual(["dangling_1", "dangling_2"]);
    expect(tail.every((m) => (m as ToolMessage).status === "error")).toBe(true);
    expect(tail[0]!.text).toBe("工具调用因服务重启被中断");
    const sys = c.repos.messages.list(conv.id).filter((m) => m.sender_type === "system" && m.content.includes("因服务重启中断"));
    expect(sys).toHaveLength(1);
    expect(sys[0]!.content).toBe("抱歉，智能助手刚才的回复因服务重启中断，请重新发送您的问题。");

    // 修复后线程可继续使用
    const next = await sendAndWait(c, "cust_a", "怎么修改收货地址？", { ticketId: first.ticket.id });
    expect(next.outcome?.status).toBe("completed");
  });

  it("会话已由人工接管时：run 置为 failed，但不向客户写系统消息；无悬空时线程不变", async () => {
    c = await buildTestContainer(env);
    const first = await sendAndWait(c, "cust_a", "你好");
    const conv0 = c.repos.conversations.get(first.conversation.id)!;
    const at = new Date().toISOString();
    const run = c.repos.aiRuns.insert(conv0.id, triggerMessage(c, conv0.id, "cust_a").id, conv0.ai_generation, at);
    c.repos.aiRuns.markRunning(run.id, at);
    // 直接改库模拟接管（不取消 run，以构造“running 的 run 属于已接管会话”）
    c.repos.conversations.takeover(conv0.id, at);
    const before = (await c.agent!.getThreadMessages(conv0.thread_id)).length;
    const sysBefore = c.repos.messages.list(conv0.id).filter((m) => m.sender_type === "system").length;

    c = await restart(c, env);
    await c.services.conversation.recoverRuns();
    expect(c.repos.aiRuns.get(run.id)!.status).toBe("failed");
    expect(c.repos.messages.list(conv0.id).filter((m) => m.sender_type === "system")).toHaveLength(sysBefore);
    expect((await c.agent!.getThreadMessages(conv0.thread_id)).length).toBe(before);
  });
});

describe("4. retry 加锁并要求上一轮流程已完成", () => {
  it("failed 且流程已完成 → retry 成功；并发 retry 只有一个成功，另一个 409", async () => {
    c = await buildTestContainer(env, { startMcp: false });
    const id = await createPendingRefund(c, "cust_b", "ORD-1003");
    await c.services.refunds.decide(REVIEWER, id, "approved", "同意");
    expect(c.repos.refunds.get(id)!.status).toBe("failed");
    expect(c.repos.refunds.get(id)!.flow_completed_at).not.toBeNull();

    const [a, b] = await Promise.allSettled([c.services.refunds.retry(REVIEWER, id), c.services.refunds.retry(REVIEWER, id)]);
    const results = [a, b];
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409, code: "NOT_RETRYABLE" });
    const r = c.repos.refunds.get(id)!;
    expect(r.status).toBe("refunded");
    expect(r.attempt).toBe(2);
    expect(execCount(c, id, "success")).toBe(1);
  });

  it("flow_completed_at 为 NULL：retry 先补跑旧线程（补入队失败通知）再重试，最终 refunded 且通知不重复", async () => {
    c = await buildTestContainer(env, { startMcp: false });
    const id = await createPendingRefund(c, "cust_b", "ORD-1003");
    await c.services.refunds.decide(REVIEWER, id, "approved", "同意");
    expect(c.repos.refunds.get(id)!.status).toBe("failed");
    c.db.prepare("UPDATE refund_requests SET flow_completed_at = NULL WHERE id = ?").run(id);

    const out = await c.services.refunds.retry(REVIEWER, id);
    expect(out.flow.ok).toBe(true);
    const r = c.repos.refunds.get(id)!;
    expect(r.attempt).toBe(2);
    expect(r.status).toBe("refunded");
    expect(r.flow_completed_at).not.toBeNull();
    expect(orderStatus(c, "ORD-1003")).toBe("refunded");
    expect(execCount(c, id, "failed")).toBe(1);
    expect(execCount(c, id, "success")).toBe(1);
    // 旧线程补跑：a1 失败通知恰好 1 条；新线程 a2 成功通知 1 条
    expect(c.repos.outbox.listByDedupePrefix(`refund:${id}:failed:a1`)).toHaveLength(1);
    expect(c.repos.outbox.listByDedupePrefix(`refund:${id}:refunded:a2`)).toHaveLength(1);
    expect(outboxRows(c, id, "failed")).toBe(1);
  });
});

describe("5. 执行节点校验支付记录状态", () => {
  it("支付记录非 succeeded → 执行失败（支付记录状态异常），订单不变、不产生成功执行", async () => {
    c = await buildTestContainer(env, { startMcp: false });
    const id = await createPendingRefund(c, "cust_a", "ORD-1001");
    // 提交 / 校验之后，支付记录被外部篡改为 failed
    c.db.prepare("UPDATE payments SET status = 'failed' WHERE order_id = 'ORD-1001'").run();
    const out = await c.services.refunds.decide(REVIEWER, id, "approved", "同意");
    expect(out.flow.ok).toBe(true);
    const r = c.repos.refunds.get(id)!;
    expect(r.status).toBe("failed");
    expect(r.failure_reason).toBe("支付记录状态异常");
    expect(orderStatus(c, "ORD-1001")).toBe("paid");
    expect(execCount(c, id, "success")).toBe(0);
    expect(execCount(c, id, "failed")).toBe(1);
    expect((c.db.prepare("SELECT status FROM payments WHERE order_id = 'ORD-1001'").get() as { status: string }).status).toBe("failed");
  });
});

describe("6. 本地工具内部异常不进入模型上下文", () => {
  it("search_knowledge / submit_refund_request 抛错 → 模型只看到通用 UNAVAILABLE，原始错误写 execution_logs", async () => {
    c = await buildTestContainer(env);
    const secret = "SQLITE_ERROR: /Users/secret/path/app.db no such table";
    (c.services.knowledge as { search: unknown }).search = () => {
      throw new Error(secret);
    };
    (c.services.refunds as { submit: unknown }).submit = async () => {
      throw new Error(secret);
    };

    const k = await sendAndWait(c, "cust_a", "怎么修改收货地址？");
    const threadK = c.repos.conversations.get(k.conversation.id)!.thread_id;
    const kMsgs = await c.agent!.getThreadMessages(threadK);
    const kTool = kMsgs.find((m): m is ToolMessage => ToolMessage.isInstance(m) && m.name === "search_knowledge")!;
    expect(JSON.parse(kTool.text)).toEqual({ ok: false, code: "UNAVAILABLE", message: "服务暂时不可用，请稍后再试" });

    const f = await sendAndWait(c, "cust_a", "ORD-1001 申请退款，原因是质量问题", { newTicket: true });
    const threadF = c.repos.conversations.get(f.conversation.id)!.thread_id;
    const fMsgs = await c.agent!.getThreadMessages(threadF);
    const fTool = fMsgs.find((m): m is ToolMessage => ToolMessage.isInstance(m) && m.name === "submit_refund_request")!;
    expect(JSON.parse(fTool.text).code).toBe("UNAVAILABLE");

    for (const m of [...kMsgs, ...fMsgs]) expect(m.text).not.toContain("secret");
    for (const cid of [k.conversation.id, f.conversation.id]) {
      const logs = c.repos.logs.list("conversation", cid).filter((l) => l.event === "tool_error");
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!.detail_json).error).toContain("secret");
    }
    for (const m of c.repos.messages.list(k.conversation.id)) expect(m.content).not.toContain("secret");
  });
});

describe("7. 客户视角不暴露转人工原因", () => {
  it("AI 工具转人工后：客户接口 handoverReason=null，客服接口仍返回", async () => {
    c = await buildTestContainer(env);
    http = await startHttp(c);
    const r = await sendAndWait(c, "cust_a", "我要转人工");
    expect(r.outcome?.status).toBe("completed");
    const seatId = c.repos.tickets.get(r.ticket.id)!.seat_id!;

    const cust = { role: "customer" as const, id: "cust_a" };
    const list = await call(http.baseUrl, "GET", "/api/customer/tickets", cust);
    const t = list.body.tickets.find((x: any) => x.id === r.ticket.id);
    expect(t.handoverRequested).toBe(true);
    expect(t.handoverReason).toBeNull();
    const msgs = await call(http.baseUrl, "GET", `/api/customer/tickets/${r.ticket.id}/messages?afterSeq=0`, cust);
    expect(msgs.body.ticket.handoverReason).toBeNull();
    const btn = await call(http.baseUrl, "POST", `/api/customer/tickets/${r.ticket.id}/handover`, cust, { reason: "客户自填" });
    expect(btn.body.ticket.handoverReason).toBeNull();

    const agentList = await call(http.baseUrl, "GET", "/api/agent/tickets", { role: "agent", id: seatId });
    const at = agentList.body.tickets.find((x: any) => x.id === r.ticket.id);
    expect(at.handoverRequested).toBe(true);
    expect(typeof at.handoverReason).toBe("string");
    expect(at.handoverReason.length).toBeGreaterThan(0);
  });
});

describe("8. MCP 子进程环境变量白名单与默认密钥告警", () => {
  it("buildMcpChildEnv 只包含白名单变量", () => {
    const env = buildMcpChildEnv(
      { dbPath: "/tmp/x.db", mcpSharedSecret: "s3cret-value" },
      { PATH: "/usr/bin", HOME: "/home/u", NODE_OPTIONS: "--max-old-space-size=512", ANTHROPIC_API_KEY: "sk-xxx", OPENAI_API_KEY: "sk-yyy", FOO: "bar" },
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/u",
      NODE_OPTIONS: "--max-old-space-size=512",
      DB_PATH: "/tmp/x.db",
      MCP_SHARED_SECRET: "s3cret-value",
    });
    // NODE_OPTIONS 缺省时不出现
    expect(Object.keys(buildMcpChildEnv({ dbPath: "/d", mcpSharedSecret: "s" }, { PATH: "/p" })).sort()).toEqual(["DB_PATH", "MCP_SHARED_SECRET", "PATH"]);
  });

  it("共享密钥等于默认值时告警，自定义密钥不告警", () => {
    const logs: string[] = [];
    expect(warnIfDefaultSecret({ mcpSharedSecret: DEFAULT_MCP_SHARED_SECRET }, (m) => logs.push(m))).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("MCP_SHARED_SECRET");
    expect(warnIfDefaultSecret({ mcpSharedSecret: "another-secret-123" }, (m) => logs.push(m))).toBe(false);
    expect(logs).toHaveLength(1);
  });
});

describe("9. CORS 收紧", () => {
  it("非本机来源不返回 access-control-allow-origin；localhost / 127.0.0.1 任意端口放行", async () => {
    c = await buildTestContainer(env, { startMcp: false });
    http = await startHttp(c);
    const get = async (origin: string) => (await fetch(http!.baseUrl + "/api/bootstrap", { headers: { Origin: origin } })).headers.get("access-control-allow-origin");
    expect(await get("http://evil.example")).toBeNull();
    expect(await get("http://localhost.evil.example")).toBeNull();
    expect(await get("https://localhost:5173")).toBeNull();
    expect(await get("http://localhost:5173")).toBe("http://localhost:5173");
    expect(await get("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");

    // 预检请求同理
    const pre = await fetch(http.baseUrl + "/api/customer/messages", {
      method: "OPTIONS",
      headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "POST" },
    });
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  });
});

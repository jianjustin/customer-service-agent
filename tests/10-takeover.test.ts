// 验证矩阵 #10：接管后 AI 不抢答、恢复、可回放（SPEC §K.2 第 10 条）。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestContainer, makeTestEnv, restart, sendAndWait, waitFor, type Container, type TestEnv } from "./helpers/env";
import { call, startHttp } from "./helpers/http";

let env: TestEnv;
let c: Container;
let http: { baseUrl: string; close(): Promise<void> };

const cust = (id: string) => ({ role: "customer" as const, id });
const seat = (id: string) => ({ role: "agent" as const, id });

async function boot(opts: Parameters<typeof buildTestContainer>[1] = {}) {
  c = await buildTestContainer(env, opts);
  http = await startHttp(c);
}

beforeEach(() => {
  env = makeTestEnv();
});
afterEach(async () => {
  await http?.close();
  await c?.close();
  env.cleanup();
});

const aiRows = (conversationId: string) => c.repos.messages.list(conversationId).filter((m) => m.sender_type === "ai");
const runStatus = (runId: number) => (c.db.prepare("SELECT status FROM ai_runs WHERE id = ?").get(runId) as { status: string }).status;

describe("人工接管", () => {
  it("慢回复期间接管：AI 结果被抑制（suppressed），客户看不到 AI 消息", async () => {
    await boot({ mockDelayMs: 400 });
    const r = c.services.conversation.handleCustomerMessage({ customerId: "cust_a", content: "怎么修改收货地址？", clientMessageId: "m1" });
    expect(r.aiRunId).not.toBeNull();
    await waitFor(() => runStatus(r.aiRunId!) === "running");

    const t = await call(http.baseUrl, "POST", `/api/agent/tickets/${r.ticket.id}/takeover`, seat("seat_A"), {});
    expect(t.status).toBe(200);
    expect(t.body.ticket.conversation.handlingMode).toBe("human");

    const outcome = await r.aiRun!;
    expect(outcome.status).toBe("suppressed");
    expect(outcome.replyMessageId).toBeNull();
    expect(aiRows(r.conversation.id)).toHaveLength(0);
    expect(runStatus(r.aiRunId!)).toBe("suppressed");
    expect(c.repos.logs.count("conversation", { event: "suppressed" })).toBe(1);

    // 客户端消息列表中也没有 AI 内容
    const list = await call(http.baseUrl, "GET", `/api/customer/tickets/${r.ticket.id}/messages?afterSeq=0`, cust("cust_a"));
    expect(list.body.messages.some((m: any) => m.senderType === "ai")).toBe(false);
  });

  it("未接管时客服 reply → 409 NOT_TAKEN_OVER", async () => {
    await boot();
    const r = await sendAndWait(c, "cust_a", "你好");
    const res = await call(http.baseUrl, "POST", `/api/agent/tickets/${r.ticket.id}/reply`, seat("seat_A"), {
      content: "您好，我是人工客服",
      clientMessageId: "r1",
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("NOT_TAKEN_OVER");
  });

  it("完整场景：接管 → 客户消息无 AI → 人工回复 → 恢复 AI → AI 回复；回放顺序固定且重启后一致", async () => {
    await boot({ mockDelayMs: 400 });
    // 1) 客户首条消息，AI 正在慢速生成时被接管
    const first = c.services.conversation.handleCustomerMessage({ customerId: "cust_a", content: "怎么修改收货地址？", clientMessageId: "m1" });
    await waitFor(() => runStatus(first.aiRunId!) === "running");
    const ticketId = first.ticket.id;
    expect((await call(http.baseUrl, "POST", `/api/agent/tickets/${ticketId}/takeover`, seat("seat_A"), {})).status).toBe(200);
    expect((await first.aiRun!).status).toBe("suppressed");

    // 2) 接管期间客户再发消息：不创建 ai_run，没有 AI 回复
    const second = c.services.conversation.handleCustomerMessage({ customerId: "cust_a", content: "有人在吗？我想改地址", clientMessageId: "m2" });
    expect(second.aiRunId).toBeNull();
    expect(second.aiRun).toBeNull();
    expect(aiRows(first.conversation.id)).toHaveLength(0);

    // 3) 人工回复
    const reply = await call(http.baseUrl, "POST", `/api/agent/tickets/${ticketId}/reply`, seat("seat_A"), {
      content: "您好，我是人工客服 A，马上帮您处理。",
      clientMessageId: "r1",
    });
    expect(reply.status).toBe(201);
    expect(reply.body.message.senderType).toBe("agent");
    // 非本席位不能回复
    expect((await call(http.baseUrl, "POST", `/api/agent/tickets/${ticketId}/reply`, seat("seat_B"), { content: "x", clientMessageId: "r2" })).status).toBe(403);

    // 4) 恢复 AI，客户提问后 AI 回复出现
    expect((await call(http.baseUrl, "POST", `/api/agent/tickets/${ticketId}/resume-ai`, seat("seat_A"), {})).status).toBe(200);
    const third = c.services.conversation.handleCustomerMessage({ customerId: "cust_a", content: "退款多久到账", clientMessageId: "m3" });
    expect(third.aiRunId).not.toBeNull();
    expect((await third.aiRun!).status).toBe("completed");
    expect(aiRows(first.conversation.id)).toHaveLength(1);

    // 5) 回放：顺序固定、seq 连续递增，senderLabel 正确
    const path = `/api/customer/tickets/${ticketId}/messages?afterSeq=0`;
    const before = await call(http.baseUrl, "GET", path, cust("cust_a"));
    const msgs = before.body.messages as Array<{ seq: number; senderType: string; senderLabel: string; content: string }>;
    expect(msgs.map((m) => m.seq)).toEqual(msgs.map((_, i) => msgs[0]!.seq + i));
    expect(msgs.map((m) => m.senderType)).toEqual(["customer", "system", "system", "customer", "agent", "system", "customer", "ai"]);
    expect(msgs[1]!.content).toBe("已为您分配人工客服 A。");
    expect(msgs[2]!.content).toBe("人工客服 A 已接入，AI 助手暂停自动回复。");
    expect(msgs[4]!.senderLabel).toBe("人工客服 A");
    expect(msgs[4]!.content).toBe("您好，我是人工客服 A，马上帮您处理。");
    expect(msgs[5]!.content).toBe("AI 助手已恢复服务。");
    expect(msgs[7]!.content.startsWith("[Mock 模式] ")).toBe(true);

    // 6) 重启后同一接口返回完全相同的列表（刷新恢复真实记录）
    await http.close();
    await c.close();
    c = await restart(c, env, { mockDelayMs: 400 });
    http = await startHttp(c);
    const after = await call(http.baseUrl, "GET", path, cust("cust_a"));
    expect(after.status).toBe(200);
    expect(after.body.messages).toEqual(before.body.messages);
  });

  it("客户按钮转人工：handling_mode=human，handoverRequested=true，之后客户消息不触发 AI", async () => {
    await boot();
    const r = await sendAndWait(c, "cust_a", "你好");
    const h = await call(http.baseUrl, "POST", `/api/customer/tickets/${r.ticket.id}/handover`, cust("cust_a"), {});
    expect(h.status).toBe(200);
    expect(h.body.ticket.conversation.handlingMode).toBe("human");
    expect(h.body.ticket.handoverRequested).toBe(true);
    const next = c.services.conversation.handleCustomerMessage({ customerId: "cust_a", content: "怎么修改收货地址？", clientMessageId: "m9", ticketId: r.ticket.id });
    expect(next.aiRunId).toBeNull();
  });

  it("AI 工具转人工：先回复确认，再切换为人工模式并追加系统消息", async () => {
    await boot();
    const r = await sendAndWait(c, "cust_a", "我要转人工");
    expect(r.outcome?.status).toBe("completed");
    const rows = c.repos.messages.list(r.conversation.id);
    expect(rows.map((m) => m.sender_type)).toEqual(["customer", "system", "ai", "system"]);
    expect(rows[2]!.content).toContain("已为您申请转接人工客服");
    expect(rows[3]!.content).toBe("已为您转接人工客服，请稍候。");
    expect(c.repos.conversations.get(r.conversation.id)!.handling_mode).toBe("human");
    const ticket = c.repos.tickets.get(r.ticket.id)!;
    expect(ticket.handover_requested).toBe(1);
    expect(ticket.ai_summary).toContain("【转人工】是");
    // 之后客户消息不再触发 AI
    const next = c.services.conversation.handleCustomerMessage({ customerId: "cust_a", content: "在吗", clientMessageId: "m8", ticketId: r.ticket.id });
    expect(next.aiRunId).toBeNull();
  });
});

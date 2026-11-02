// 验证矩阵 #1：三客户分配与隔离（SPEC §K.2 第 1 条）。
// 使用默认 startMcp:true（真实 MCP 子进程 + Mock 模型），含依赖 AI 回复的隔离断言。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestContainer, lastAiMessage, makeTestEnv, waitFor, type Container, type TestEnv } from "./helpers/env";
import { call, startHttp } from "./helpers/http";

let env: TestEnv;
let c: Container;
let http: { baseUrl: string; close(): Promise<void> };

const cust = (id: string) => ({ role: "customer" as const, id });

async function hello(customerId: string) {
  return call(http.baseUrl, "POST", "/api/customer/messages", cust(customerId), {
    content: "你好",
    clientMessageId: `hello-${customerId}`,
  });
}

beforeEach(async () => {
  env = makeTestEnv();
  c = await buildTestContainer(env);
  http = await startHttp(c);
});
afterEach(async () => {
  await http.close();
  await c.close();
  env.cleanup();
});

describe("三客户分配与隔离", () => {
  it("bootstrap 无需身份，返回身份列表与 mock 模式", async () => {
    const r = await call(http.baseUrl, "GET", "/api/bootstrap", null);
    expect(r.status).toBe(200);
    expect(r.body.customers.map((x: any) => x.id)).toEqual(["cust_a", "cust_b", "cust_c"]);
    expect(r.body.seats).toEqual([
      { id: "seat_A", name: "A", online: true, capacity: 2 },
      { id: "seat_B", name: "B", online: true, capacity: 2 },
      { id: "seat_C", name: "C", online: true, capacity: 2 },
    ]);
    expect(r.body.reviewers).toEqual([{ id: "reviewer_1", name: "退款审核员" }]);
    expect(r.body.model.mode).toBe("mock");
  });

  it("三个客户首条消息依次分配 A、B、C；thread_id 互不相同且以 conv_ 开头", async () => {
    const ra = await hello("cust_a");
    const rb = await hello("cust_b");
    const rc = await hello("cust_c");
    for (const r of [ra, rb, rc]) expect(r.status).toBe(201);
    expect([ra, rb, rc].map((r) => r.body.ticket.seatId)).toEqual(["seat_A", "seat_B", "seat_C"]);
    expect([ra, rb, rc].map((r) => r.body.ticket.seatName)).toEqual(["A", "B", "C"]);

    const threads = [ra, rb, rc].map((r) => c.repos.conversations.getByTicket(r.body.ticket.id)!.thread_id);
    expect(new Set(threads).size).toBe(3);
    for (const t of threads) expect(t.startsWith("conv_")).toBe(true);

    // 首条客户消息之后紧跟分配系统消息
    const msgs = c.repos.messages.list(c.repos.conversations.getByTicket(ra.body.ticket.id)!.id);
    expect(msgs[0]!.sender_type).toBe("customer");
    expect(msgs[1]).toMatchObject({ sender_type: "system", content: "已为您分配人工客服 A。" });
  });

  it("客户只能看到自己的工单、消息与订单", async () => {
    const ra = await hello("cust_a");
    const rb = await hello("cust_b");
    await hello("cust_c");

    const mine = await call(http.baseUrl, "GET", "/api/customer/tickets", cust("cust_a"));
    expect(mine.status).toBe(200);
    expect(mine.body.tickets).toHaveLength(1);
    expect(mine.body.tickets[0].id).toBe(ra.body.ticket.id);

    // 越权读他人工单 → 403；不存在 → 404
    const other = await call(http.baseUrl, "GET", `/api/customer/tickets/${rb.body.ticket.id}/messages`, cust("cust_a"));
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe("FORBIDDEN");
    const none = await call(http.baseUrl, "GET", "/api/customer/tickets/TK-NOPE/messages", cust("cust_a"));
    expect(none.status).toBe(404);

    // 自己的消息列表不含其他客户内容
    const own = await call(http.baseUrl, "GET", `/api/customer/tickets/${ra.body.ticket.id}/messages?afterSeq=0`, cust("cust_a"));
    expect(own.status).toBe(200);
    expect(own.body.messages.length).toBeGreaterThanOrEqual(2);
    expect(own.body.ticket.id).toBe(ra.body.ticket.id);
    const seqs = own.body.messages.map((m: any) => m.seq);
    expect(seqs).toEqual([...seqs].sort((x: number, y: number) => x - y));
    // afterSeq 增量
    const inc = await call(http.baseUrl, "GET", `/api/customer/tickets/${ra.body.ticket.id}/messages?afterSeq=1`, cust("cust_a"));
    expect(inc.body.messages.every((m: any) => m.seq > 1)).toBe(true);
    // 非法 afterSeq → 422
    expect((await call(http.baseUrl, "GET", `/api/customer/tickets/${ra.body.ticket.id}/messages?afterSeq=-1`, cust("cust_a"))).status).toBe(422);

    const orders = await call(http.baseUrl, "GET", "/api/customer/orders", cust("cust_a"));
    expect(orders.status).toBe(200);
    expect(orders.body.orders.map((o: any) => o.id).sort()).toEqual(["ORD-1001", "ORD-1002", "ORD-1007"]);
    expect(orders.body.orders.find((o: any) => o.id === "ORD-1001").paymentStatusText).toBe("已支付");
  });

  it("身份与角色校验：未知客户 401、缺头 401、客户访问 agent 路由 403", async () => {
    const x = await call(http.baseUrl, "GET", "/api/customer/tickets", cust("cust_x"));
    expect(x.status).toBe(401);
    expect(x.body.error.code).toBe("UNAUTHENTICATED");
    expect((await call(http.baseUrl, "GET", "/api/customer/tickets", null)).status).toBe(401);
    expect((await call(http.baseUrl, "GET", "/api/customer/tickets", { role: "bogus" as any, id: "cust_a" })).status).toBe(401);

    const forbidden = await call(http.baseUrl, "GET", "/api/agent/tickets", cust("cust_a"));
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe("FORBIDDEN");
    expect((await call(http.baseUrl, "GET", "/api/reviewer/refunds", cust("cust_a"))).status).toBe(403);
    expect((await call(http.baseUrl, "GET", "/api/customer/tickets", { role: "agent", id: "seat_A" })).status).toBe(403);
  });

  it("席位只能访问自己的工单", async () => {
    await hello("cust_a");
    const rb = await hello("cust_b");
    const r = await call(http.baseUrl, "GET", `/api/agent/tickets/${rb.body.ticket.id}`, { role: "agent", id: "seat_A" });
    expect(r.status).toBe(403);
    const ok = await call(http.baseUrl, "GET", `/api/agent/tickets/${rb.body.ticket.id}`, { role: "agent", id: "seat_B" });
    expect(ok.status).toBe(200);
    expect(ok.body.ticket.threadId).toMatch(/^conv_/); // threadId 仅客服可见
    expect(ok.body.orders.map((o: any) => o.id)).toEqual(["ORD-1004", "ORD-1003"]);
    // 客户侧 DTO 不含 threadId / aiSummary
    const cust1 = await call(http.baseUrl, "GET", "/api/customer/tickets", cust("cust_b"));
    expect(cust1.body.tickets[0]).not.toHaveProperty("threadId");
    expect(cust1.body.tickets[0]).not.toHaveProperty("aiSummary");
    // 我的工单列表只含本席位
    const list = await call(http.baseUrl, "GET", "/api/agent/tickets", { role: "agent", id: "seat_A" });
    expect(list.body.tickets).toHaveLength(1);
    expect(list.body.tickets[0].customerId).toBe("cust_a");
  });

  it("请求体带 threadId 或其它多余字段 → 422", async () => {
    const r = await call(http.baseUrl, "POST", "/api/customer/messages", cust("cust_a"), {
      content: "你好",
      clientMessageId: "x1",
      threadId: "conv_hack",
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("VALIDATION_ERROR");
    expect(c.db.prepare("SELECT COUNT(*) AS n FROM tickets").get()).toEqual({ n: 0 });
    // 其它校验：空内容、非法 clientMessageId
    expect((await call(http.baseUrl, "POST", "/api/customer/messages", cust("cust_a"), { content: "   ", clientMessageId: "x2" })).status).toBe(422);
    expect((await call(http.baseUrl, "POST", "/api/customer/messages", cust("cust_a"), { content: "hi", clientMessageId: "bad id!" })).status).toBe(422);
  });

  it("客户按钮转人工：handling_mode=human，handover_requested=1；重复调用幂等", async () => {
    const r = await hello("cust_a");
    const id = r.body.ticket.id;
    const h = await call(http.baseUrl, "POST", `/api/customer/tickets/${id}/handover`, cust("cust_a"), {});
    expect(h.status).toBe(200);
    expect(h.body.ticket.conversation.handlingMode).toBe("human");
    expect(h.body.ticket.handoverRequested).toBe(true);
    const again = await call(http.baseUrl, "POST", `/api/customer/tickets/${id}/handover`, cust("cust_a"), {});
    expect(again.status).toBe(200);
    // 他人不可操作
    expect((await call(http.baseUrl, "POST", `/api/customer/tickets/${id}/handover`, cust("cust_b"), {})).status).toBe(403);
  });

  // ---- 依赖 AI 回复的断言 ----
  it("各客户首条消息“你好”都收到 AI 问候回复", async () => {
    const rs = [await hello("cust_a"), await hello("cust_b"), await hello("cust_c")];
    for (const r of rs) {
      const conv = c.repos.conversations.getByTicket(r.body.ticket.id)!;
      await waitFor(() => lastAiMessage(c, conv.id) !== undefined);
      const ai = lastAiMessage(c, conv.id)!;
      expect(ai.content.startsWith("[Mock 模式] ")).toBe(true);
      expect(ai.content).toContain("请问有什么可以帮您");
    }
  });

  it("cust_a 的 AI 回复/订单查询不泄露 cust_b 的内容；各客户的 agent 线程互相独立", async () => {
    const post = (customerId: string, content: string, id: string) =>
      call(http.baseUrl, "POST", "/api/customer/messages", cust(customerId), { content, clientMessageId: id });
    const ra = await post("cust_a", "我的订单", "iso-a");
    const rb = await post("cust_b", "我的订单", "iso-b");
    const convA = c.repos.conversations.getByTicket(ra.body.ticket.id)!;
    const convB = c.repos.conversations.getByTicket(rb.body.ticket.id)!;
    await waitFor(() => lastAiMessage(c, convA.id) !== undefined && lastAiMessage(c, convB.id) !== undefined);

    const textA = lastAiMessage(c, convA.id)!.content;
    const textB = lastAiMessage(c, convB.id)!.content;
    expect(textA).toContain("ORD-1001");
    expect(textA).toContain("ORD-1007");
    expect(textA).not.toMatch(/ORD-1003|ORD-1004/);
    expect(textB).toContain("ORD-1003");
    expect(textB).toContain("ORD-1004");
    expect(textB).not.toMatch(/ORD-1001|ORD-1002|ORD-1007/);

    // 客户视角的消息列表同样不含对方订单
    const listA = await call(http.baseUrl, "GET", `/api/customer/tickets/${ra.body.ticket.id}/messages?afterSeq=0`, cust("cust_a"));
    expect(JSON.stringify(listA.body.messages)).not.toMatch(/ORD-1003|ORD-1004/);

    // 线程隔离：a 的线程里没有 b 的订单数据
    const threadA = await c.agent!.getThreadMessages(convA.thread_id);
    expect(JSON.stringify(threadA.map((m) => m.content))).not.toMatch(/ORD-1003|ORD-1004/);
  });
});

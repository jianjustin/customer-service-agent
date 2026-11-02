// 验证矩阵 #2：去重、离线跳过、满员、排队与出队（SPEC §K.2 第 2 条）。startMcp:false，AI run 记为 failed('agent_unavailable')。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestContainer, makeTestEnv, type Container, type TestEnv } from "./helpers/env";
import { call, startHttp } from "./helpers/http";

let env: TestEnv;
let c: Container;
let http: { baseUrl: string; close(): Promise<void> };

const cust = (id: string) => ({ role: "customer" as const, id });
const seat = (id: string) => ({ role: "agent" as const, id });

let seqNo = 0;
const cid = () => `cm-${Date.now().toString(36)}-${seqNo++}`;

/** 通过 HTTP 发消息，返回 {status, ticketId, body} */
async function say(customerId: string, content = "你好", extra: Record<string, unknown> = {}) {
  const r = await call(http.baseUrl, "POST", "/api/customer/messages", cust(customerId), {
    content,
    clientMessageId: cid(),
    ...extra,
  });
  return { status: r.status, body: r.body, ticketId: r.body?.ticket?.id as string, seatId: r.body?.ticket?.seatId as string | null };
}

beforeEach(async () => {
  env = makeTestEnv();
  c = await buildTestContainer(env, { startMcp: false });
  http = await startHttp(c);
});
afterEach(async () => {
  await http.close();
  await c.close();
  env.cleanup();
});

const count = (sql: string, ...args: unknown[]) => (c.db.prepare(sql).get(...args) as { n: number }).n;

describe("客户消息去重", () => {
  it("同一 clientMessageId 连发两次：201 + 200(duplicate)，不重复建单/入库/建 run", async () => {
    const body = { content: "你好", clientMessageId: "dup-1" };
    const r1 = await call(http.baseUrl, "POST", "/api/customer/messages", cust("cust_a"), body);
    const r2 = await call(http.baseUrl, "POST", "/api/customer/messages", cust("cust_a"), body);
    expect(r1.status).toBe(201);
    expect(r1.body.duplicate).toBe(false);
    expect(r2.status).toBe(200);
    expect(r2.body.duplicate).toBe(true);
    expect(r2.body.aiRunId).toBeNull();
    expect(r2.body.ticket.id).toBe(r1.body.ticket.id);
    expect(r2.body.message.id).toBe(r1.body.message.id);

    expect(count("SELECT COUNT(*) AS n FROM tickets")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE client_message_id = 'c:dup-1'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM ai_runs")).toBeLessThanOrEqual(1);
  });

  it("并发（同步连发）同一 clientMessageId 也只产生一条消息", async () => {
    const body = { content: "并发测试", clientMessageId: "dup-par" };
    const rs = await Promise.all([1, 2, 3].map(() => call(http.baseUrl, "POST", "/api/customer/messages", cust("cust_a"), body)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(2);
    expect(count("SELECT COUNT(*) AS n FROM tickets")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE client_message_id = 'c:dup-par'")).toBe(1);
  });

  it("无 agent 时 AI run 记为 failed('agent_unavailable')", async () => {
    const r = await say("cust_a");
    const conv = c.repos.conversations.getByTicket(r.ticketId)!;
    await c.services.conversation.idle(conv.id);
    const run = c.repos.aiRuns.get(r.body.aiRunId)!;
    expect(run.status).toBe("failed");
    expect(run.error).toBe("agent_unavailable");
  });
});

describe("分配、离线、满员、排队", () => {
  it("离线席位被跳过：seat_B 离线后 cust_a、cust_b 首条消息分配 A、C", async () => {
    const off = await call(http.baseUrl, "POST", "/api/agent/me/status", seat("seat_B"), { online: false });
    expect(off.status).toBe(200);
    expect(off.body.seat.online).toBe(false);
    expect(off.body.dequeued).toEqual([]);

    expect((await say("cust_a")).seatId).toBe("seat_A");
    expect((await say("cust_b")).seatId).toBe("seat_C");
  });

  it("满员后排队；A 关闭一张后出队给 A", async () => {
    const order: Array<[string, boolean]> = [
      ["cust_a", false], ["cust_b", false], ["cust_c", false],
      ["cust_a", true], ["cust_b", true], ["cust_c", true],
    ];
    const ticketIds: string[] = [];
    const seats: Array<string | null> = [];
    for (const [who, isNew] of order) {
      const r = await say(who, "咨询", isNew ? { newTicket: true } : {});
      expect(r.status).toBe(201);
      ticketIds.push(r.ticketId);
      seats.push(r.seatId);
    }
    expect(seats).toEqual(["seat_A", "seat_B", "seat_C", "seat_A", "seat_B", "seat_C"]);

    // 第 7 张：全部满员 → queued
    const seventh = await say("cust_a", "第七张", { newTicket: true });
    expect(seventh.body.ticket.status).toBe("queued");
    expect(seventh.seatId).toBeNull();
    const row = c.db.prepare("SELECT status, seat_id FROM tickets WHERE id = ?").get(seventh.ticketId) as { status: string; seat_id: string | null };
    expect(row).toEqual({ status: "queued", seat_id: null });
    // 排队提示是首条客户消息之后的系统消息
    const queuedConv = c.repos.conversations.getByTicket(seventh.ticketId)!;
    const queuedMsgs = c.repos.messages.list(queuedConv.id);
    expect(queuedMsgs[0]!.sender_type).toBe("customer");
    expect(queuedMsgs[1]!.content).toContain("等待队列");

    const seatsRes = await call(http.baseUrl, "GET", "/api/agent/seats", seat("seat_A"));
    expect(seatsRes.status).toBe(200);
    expect(seatsRes.body.queue.count).toBe(1);
    expect(seatsRes.body.queue.ticketIds).toEqual([seventh.ticketId]);
    expect(seatsRes.body.seats.map((s: any) => s.activeCount)).toEqual([2, 2, 2]);

    // A 关闭自己的第一张 → 第 7 张出队给 A
    const closed = await call(http.baseUrl, "POST", `/api/agent/tickets/${ticketIds[0]}/close`, seat("seat_A"), {});
    expect(closed.status).toBe(200);
    expect(closed.body.ticket.status).toBe("closed");
    const after = c.repos.tickets.get(seventh.ticketId)!;
    expect(after.status).toBe("assigned");
    expect(after.seat_id).toBe("seat_A");
    expect(c.repos.messages.list(queuedConv.id).map((m) => m.content)).toContain("已为您分配人工客服 A。");

    const seatsAfter = await call(http.baseUrl, "GET", "/api/agent/seats", seat("seat_A"));
    expect(seatsAfter.body.queue.count).toBe(0);
    // 已结束工单不占容量
    expect(seatsAfter.body.seats.find((s: any) => s.id === "seat_A").activeCount).toBe(2);
  });

  it("全部席位离线 → 新工单 queued → seat_C 上线后出队给 seat_C", async () => {
    for (const s of ["seat_A", "seat_B", "seat_C"]) {
      const r = await call(http.baseUrl, "POST", "/api/agent/me/status", seat(s), { online: false });
      expect(r.status).toBe(200);
    }
    const q = await say("cust_a");
    expect(q.body.ticket.status).toBe("queued");

    const on = await call(http.baseUrl, "POST", "/api/agent/me/status", seat("seat_C"), { online: true });
    expect(on.status).toBe(200);
    expect(on.body.dequeued).toContain(q.ticketId);
    const t = c.repos.tickets.get(q.ticketId)!;
    expect(t.status).toBe("assigned");
    expect(t.seat_id).toBe("seat_C");
  });

  it("席位下线不回收已分配工单", async () => {
    const r = await say("cust_a");
    expect(r.seatId).toBe("seat_A");
    await call(http.baseUrl, "POST", "/api/agent/me/status", seat("seat_A"), { online: false });
    expect(c.repos.tickets.get(r.ticketId)!.seat_id).toBe("seat_A");
  });
});

describe("后续消息保持原分配", () => {
  it("同客户第二条消息进入同一工单；newTicket 新建第二张", async () => {
    const first = await say("cust_a", "第一条");
    const second = await say("cust_a", "第二条");
    expect(second.ticketId).toBe(first.ticketId);
    expect(second.seatId).toBe(first.seatId);
    expect(count("SELECT COUNT(*) AS n FROM tickets WHERE customer_id = 'cust_a'")).toBe(1);

    const third = await say("cust_a", "另一件事", { newTicket: true });
    expect(third.ticketId).not.toBe(first.ticketId);
    expect(count("SELECT COUNT(*) AS n FROM tickets WHERE customer_id = 'cust_a'")).toBe(2);

    // 指定 ticketId 时进入指定工单
    const fourth = await say("cust_a", "回到第一张", { ticketId: first.ticketId });
    expect(fourth.ticketId).toBe(first.ticketId);
  });

  it("ticketId 与 newTicket 同时出现 → 422；已结束工单 → 409 TICKET_CLOSED", async () => {
    const first = await say("cust_a");
    const both = await say("cust_a", "x", { ticketId: first.ticketId, newTicket: true });
    expect(both.status).toBe(422);

    await call(http.baseUrl, "POST", `/api/agent/tickets/${first.ticketId}/close`, seat("seat_A"), {});
    const toClosed = await say("cust_a", "还有问题", { ticketId: first.ticketId });
    expect(toClosed.status).toBe(409);
    expect(toClosed.body.error.code).toBe("TICKET_CLOSED");
    // 不带 ticketId：自动新建（latestOpen 已无）
    const fresh = await say("cust_a", "新问题");
    expect(fresh.status).toBe(201);
    expect(fresh.ticketId).not.toBe(first.ticketId);
  });
});

describe("客服操作（无需 AI）", () => {
  it("接管 / 回复 / 去重 / 恢复 AI / 转派校验", async () => {
    const t = await say("cust_a");
    const base = `/api/agent/tickets/${t.ticketId}`;

    // 未接管回复 → 409 NOT_TAKEN_OVER
    const early = await call(http.baseUrl, "POST", `${base}/reply`, seat("seat_A"), { content: "hi", clientMessageId: "r1" });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("NOT_TAKEN_OVER");

    // 他人席位 → 403
    expect((await call(http.baseUrl, "POST", `${base}/takeover`, seat("seat_B"), {})).status).toBe(403);

    const tk = await call(http.baseUrl, "POST", `${base}/takeover`, seat("seat_A"), {});
    expect(tk.status).toBe(200);
    expect(tk.body.ticket.conversation.handlingMode).toBe("human");
    // 幂等
    expect((await call(http.baseUrl, "POST", `${base}/takeover`, seat("seat_A"), {})).status).toBe(200);

    const rp1 = await call(http.baseUrl, "POST", `${base}/reply`, seat("seat_A"), { content: "您好，我是客服 A", clientMessageId: "r2" });
    expect(rp1.status).toBe(201);
    expect(rp1.body.message.senderLabel).toBe("人工客服 A");
    const rp2 = await call(http.baseUrl, "POST", `${base}/reply`, seat("seat_A"), { content: "您好，我是客服 A", clientMessageId: "r2" });
    expect(rp2.status).toBe(200);
    expect(rp2.body.duplicate).toBe(true);
    expect(rp2.body.message.id).toBe(rp1.body.message.id);

    // 接管期间客户发消息：不创建 ai_run
    const more = await say("cust_a", "在吗");
    expect(more.body.aiRunId).toBeNull();

    // 转派：目标不存在 404、目标=自己 422、目标离线 409
    expect((await call(http.baseUrl, "POST", `${base}/transfer`, seat("seat_A"), { targetSeatId: "seat_Z" })).status).toBe(404);
    expect((await call(http.baseUrl, "POST", `${base}/transfer`, seat("seat_A"), { targetSeatId: "seat_A" })).status).toBe(422);
    await call(http.baseUrl, "POST", "/api/agent/me/status", seat("seat_B"), { online: false });
    const un = await call(http.baseUrl, "POST", `${base}/transfer`, seat("seat_A"), { targetSeatId: "seat_B" });
    expect(un.status).toBe(409);
    expect(un.body.error.code).toBe("SEAT_UNAVAILABLE");
    const ok = await call(http.baseUrl, "POST", `${base}/transfer`, seat("seat_A"), { targetSeatId: "seat_C" });
    expect(ok.status).toBe(200);
    expect(ok.body.ticket.seatId).toBe("seat_C");
    // 原席位已无权限
    expect((await call(http.baseUrl, "GET", base, seat("seat_A"))).status).toBe(403);
    expect((await call(http.baseUrl, "POST", `${base}/resume-ai`, seat("seat_C"), {})).status).toBe(200);

    // 结束：幂等；结束后接管/回复 → 409
    expect((await call(http.baseUrl, "POST", `${base}/close`, seat("seat_C"), {})).status).toBe(200);
    expect((await call(http.baseUrl, "POST", `${base}/close`, seat("seat_C"), {})).status).toBe(200);
    expect((await call(http.baseUrl, "POST", `${base}/takeover`, seat("seat_C"), {})).body.error.code).toBe("TICKET_CLOSED");
  });
});

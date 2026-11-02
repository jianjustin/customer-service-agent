import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, tx, type Db } from "../server/db/connection";
import { migrate } from "../server/db/migrate";
import { seed } from "../server/db/seed";
import { createRepos, type Repos } from "../server/repos";
import { KeyedMutex } from "../server/services/locks";
import { newRefundId, randomId } from "../server/util";
import { makeTestEnv, type TestEnv } from "./helpers/env";

let env: TestEnv;
let db: Db;
let repos: Repos;
const AT = "2026-10-30T01:00:00.000Z";

function newTicketAndConv(customerId = "cust_a", suffix = "1") {
  const ticketId = `TK-T${suffix}`;
  const convId = `CV-T${suffix}`;
  repos.tickets.insert({ id: ticketId, customer_id: customerId, seat_id: null, status: "queued", subject: "测试", created_at: AT, updated_at: AT });
  repos.conversations.insert({
    id: convId, ticket_id: ticketId, customer_id: customerId, channel: "web", channel_session_id: `web:${convId}`,
    thread_id: `conv_${suffix}`, handling_mode: "ai", ai_generation: 0, created_at: AT, updated_at: AT,
  });
  return { ticketId, convId };
}

beforeEach(() => {
  env = makeTestEnv();
  db = openDb(env.dbPath);
  migrate(db);
  seed(db);
  repos = createRepos(db);
});
afterEach(() => {
  db.close();
  env.cleanup();
});

describe("迁移与种子", () => {
  it("migrate 幂等；seed 可重复且不覆盖运行时修改", () => {
    expect(migrate(db)).toEqual([]);
    repos.identity.setSeatOnline("seat_B", false);
    repos.orders.markRefunded("ORD-1001", AT);
    seed(db);
    expect(repos.identity.getSeat("seat_B")?.online).toBe(0);
    expect(repos.orders.get("ORD-1001")?.payment_status).toBe("refunded");
    const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect([n("customers"), n("seats"), n("reviewers"), n("orders"), n("payments"), n("knowledge_entries")]).toEqual([3, 3, 1, 7, 7, 14]);
    expect(repos.assignmentState.get("rr_cursor")).toBe("");
    expect(repos.knowledge.listAll()).toHaveLength(14);
  });
  it("tx 内抛错整体回滚", () => {
    expect(() => tx(db, () => {
      repos.identity.setSeatOnline("seat_A", false);
      throw new Error("boom");
    })).toThrow("boom");
    expect(repos.identity.getSeat("seat_A")?.online).toBe(1);
  });
});

describe("repos", () => {
  it("identity / orders", () => {
    expect(repos.identity.listSeats().map((s) => s.id)).toEqual(["seat_A", "seat_B", "seat_C"]);
    expect(repos.orders.listByCustomer("cust_a").map((o) => o.id)).toEqual(["ORD-1007", "ORD-1002", "ORD-1001"]);
    expect(repos.orders.getPayment("ORD-1003")?.id).toBe("PAY-1003");
    expect(repos.orders.consumeSimulatedFailure("ORD-1003")).toBe(1);
    expect(repos.orders.consumeSimulatedFailure("ORD-1003")).toBe(0);
    expect(repos.orders.markRefunded("ORD-1002", AT)).toBe(0); // 未支付不可退
    expect(repos.orders.markRefunded("ORD-1005", AT)).toBe(1);
    expect(repos.orders.get("ORD-1005")).toMatchObject({ payment_status: "refunded", refunded_at: AT, refund_note: "已退款（模拟）" });
    expect(repos.orders.markPaymentRefunded("ORD-1005")).toBe(1);
  });

  it("tickets 条件更新与排队", () => {
    const { ticketId } = newTicketAndConv();
    expect(repos.tickets.listQueued().map((t) => t.id)).toEqual([ticketId]);
    expect(repos.tickets.assign(ticketId, "seat_A", AT, "queued")).toBe(1);
    expect(repos.tickets.assign(ticketId, "seat_B", AT, "queued")).toBe(0);
    expect(repos.tickets.countAssigned("seat_A")).toBe(1);
    expect(repos.tickets.assign(ticketId, "seat_B", AT, "assigned")).toBe(1);
    expect(repos.tickets.latestOpenForCustomer("cust_a")?.id).toBe(ticketId);
    expect(repos.tickets.listBySeat("seat_B", "assigned")).toHaveLength(1);
    expect(repos.tickets.setHandoverRequested(ticketId, "要人工", AT)).toBe(1);
    expect(repos.tickets.close(ticketId, AT)).toBe(1);
    expect(repos.tickets.close(ticketId, AT)).toBe(0);
    expect(repos.tickets.countAssigned("seat_B")).toBe(0);
    expect(repos.tickets.latestOpenForCustomer("cust_a")).toBeUndefined();
  });

  it("conversations 接管 / 恢复", () => {
    const { convId } = newTicketAndConv();
    expect(repos.conversations.takeover(convId, AT)).toBe(1);
    expect(repos.conversations.takeover(convId, AT)).toBe(0);
    expect(repos.conversations.get(convId)).toMatchObject({ handling_mode: "human", ai_generation: 1 });
    expect(repos.conversations.resumeAi(convId, AT)).toBe(1);
    expect(repos.conversations.bumpGeneration(convId, AT)).toBe(1);
    expect(repos.conversations.get(convId)?.ai_generation).toBe(2);
  });

  it("messages：seq 递增、客户消息去重、insertIgnoreByClientId", () => {
    const { convId } = newTicketAndConv();
    const m1 = repos.messages.insert({ conversationId: convId, senderType: "customer", senderId: "cust_a", content: "你好", clientMessageId: "c:x1", at: AT });
    const m2 = repos.messages.insert({ conversationId: convId, senderType: "ai", senderId: null, content: "您好", sources: [{ id: "kb-001", title: "修改收货地址", version: 2 }], at: AT });
    expect([m1.seq, m2.seq]).toEqual([1, 2]);
    expect(JSON.parse(m2.sources_json)).toHaveLength(1);
    expect(repos.messages.findCustomerMessageByClientId("cust_a", "c:x1")?.id).toBe(m1.id);
    expect(repos.messages.findCustomerMessageByClientId("cust_b", "c:x1")).toBeUndefined();
    const a = repos.messages.insertIgnoreByClientId({ conversationId: convId, senderType: "system", senderId: null, content: "通知", clientMessageId: "o:k1", at: AT });
    const b = repos.messages.insertIgnoreByClientId({ conversationId: convId, senderType: "system", senderId: null, content: "通知", clientMessageId: "o:k1", at: AT });
    expect([a.duplicate, b.duplicate]).toEqual([false, true]);
    expect(b.row.id).toBe(a.row.id);
    expect(repos.messages.list(convId)).toHaveLength(3);
    expect(repos.messages.list(convId, 2).map((m) => m.seq)).toEqual([3]);
    // 部分唯一索引：同一客户相同 client id 在另一会话也被拒绝
    const other = newTicketAndConv("cust_a", "2");
    expect(() => repos.messages.insert({ conversationId: other.convId, senderType: "customer", senderId: "cust_a", content: "x", clientMessageId: "c:x1", at: AT })).toThrow(/UNIQUE/);
  });

  it("aiRuns 状态机条件更新", () => {
    const { convId } = newTicketAndConv();
    const m = repos.messages.insert({ conversationId: convId, senderType: "customer", senderId: "cust_a", content: "q", clientMessageId: "c:1", at: AT });
    const run = repos.aiRuns.insert(convId, m.id, 0, AT);
    expect(run.status).toBe("queued");
    expect(repos.aiRuns.hasPending(convId)).toBe(true);
    expect(repos.aiRuns.complete(run.id, m.id, AT)).toBe(0); // 未 running
    expect(repos.aiRuns.markRunning(run.id, AT)).toBe(1);
    expect(repos.aiRuns.markHandoverRequested(run.id)).toBe(1);
    expect(repos.aiRuns.listActive()).toHaveLength(1);
    expect(repos.aiRuns.cancelActive(convId, AT)).toBe(1);
    expect(repos.aiRuns.suppress(run.id, AT)).toBe(1);
    expect(repos.aiRuns.get(run.id)?.status).toBe("suppressed");
    expect(repos.aiRuns.fail(run.id, "x", AT)).toBe(0);
    expect(repos.aiRuns.hasPending(convId)).toBe(false);
    expect(repos.aiRuns.listByConversation(convId, 5)).toHaveLength(1);
  });

  it("refunds：活跃唯一、转换、重试、决定、执行记录", () => {
    const { ticketId, convId } = newTicketAndConv();
    const mk = (id: string, version: number) => ({
      id, customer_id: "cust_a", ticket_id: ticketId, conversation_id: convId, order_id: "ORD-1001", amount_minor: 59900,
      currency: "CNY", reason: "质量问题", evidence_json: "{}", version, status: "submitted" as const,
      idempotency_key: `refund:ORD-1001:v${version}`, thread_id: `refund:${id}:a1`, attempt: 1, failure_reason: null,
      flow_completed_at: null, created_at: AT, updated_at: AT,
    });
    const id1 = newRefundId();
    repos.refunds.insert(mk(id1, 1));
    expect(() => repos.refunds.insert(mk(newRefundId(), 2))).toThrow(/UNIQUE/); // 同订单仅一条活跃
    expect(repos.refunds.findActiveByOrder("ORD-1001")?.id).toBe(id1);
    expect(repos.refunds.transition(id1, ["submitted"], "pending_review", AT)).toBe(1);
    expect(repos.refunds.transition(id1, ["submitted"], "approved", AT)).toBe(0);
    repos.refunds.insertDecision({ id: randomId("RD"), refund_request_id: id1, reviewer_id: "reviewer_1", decision: "approved", comment: "同意", decided_at: AT });
    expect(() => repos.refunds.insertDecision({ id: randomId("RD"), refund_request_id: id1, reviewer_id: "reviewer_1", decision: "rejected", comment: "x", decided_at: AT })).toThrow(/UNIQUE/);
    expect(repos.refunds.transition(id1, ["pending_review"], "approved", AT)).toBe(1);
    expect(repos.refunds.transition(id1, ["approved"], "executing", AT)).toBe(1);
    expect(repos.refunds.transition(id1, ["executing"], "failed", AT, { failureReason: "渠道失败" })).toBe(1);
    expect(repos.refunds.get(id1)).toMatchObject({ status: "failed", failure_reason: "渠道失败" });
    expect(repos.refunds.findActiveByOrder("ORD-1001")).toBeUndefined();
    repos.refunds.insertExecution({ id: randomId("RE"), refund_request_id: id1, order_id: "ORD-1001", attempt: 1, status: "failed", amount_minor: 59900, failure_reason: "渠道失败", executed_at: AT });
    expect(repos.refunds.sumSuccessByOrder("ORD-1001")).toBe(0);
    expect(repos.refunds.prepareRetry(id1, 2, "refund:x:a2", AT)).toBe(0); // attempt 不符
    expect(repos.refunds.prepareRetry(id1, 1, `refund:${id1}:a2`, AT)).toBe(1);
    expect(repos.refunds.get(id1)).toMatchObject({ status: "approved", attempt: 2, failure_reason: null });
    repos.refunds.insertExecution({ id: randomId("RE"), refund_request_id: id1, order_id: "ORD-1001", attempt: 2, status: "success", amount_minor: 59900, failure_reason: null, executed_at: AT });
    expect(repos.refunds.sumSuccessByOrder("ORD-1001")).toBe(59900);
    expect(repos.refunds.getSuccessExecution(id1)?.attempt).toBe(2);
    expect(repos.refunds.getExecution(id1, 1)?.status).toBe("failed");
    expect(repos.refunds.listExecutions(id1)).toHaveLength(2);
    expect(repos.refunds.listFlowOpen()).toHaveLength(1);
    expect(repos.refunds.markFlowCompleted(id1, AT)).toBe(1);
    expect(repos.refunds.markFlowCompleted(id1, AT)).toBe(0);
    expect(repos.refunds.listFlowOpen()).toHaveLength(0);
    expect(repos.refunds.countByOrder("ORD-1001")).toBe(1);
    expect(repos.refunds.listAll("approved")).toHaveLength(1);
    expect(repos.refunds.listByCustomer("cust_a")).toHaveLength(1);
    expect(repos.refunds.listByTicket(ticketId)).toHaveLength(1);
  });

  it("outbox：幂等入队、到期、重试、失败", () => {
    const { convId } = newTicketAndConv();
    const payload = { template: "refund_submitted" as const, requestId: "RF-1", orderId: "ORD-1001", amountMinor: 59900, text: "t" };
    expect(repos.outbox.enqueue({ dedupeKey: "refund:RF-1:submitted:a1", conversationId: convId, payload, at: AT }).inserted).toBe(true);
    expect(repos.outbox.enqueue({ dedupeKey: "refund:RF-1:submitted:a1", conversationId: convId, payload, at: AT }).inserted).toBe(false);
    expect(repos.outbox.due("2026-10-29T00:00:00.000Z", 10)).toHaveLength(0);
    const [row] = repos.outbox.due(AT, 10);
    expect(JSON.parse(row.payload_json).text).toBe("t");
    expect(repos.outbox.markRetry(row.id, 1, "2026-10-30T01:00:01.000Z", "e")).toBe(1);
    expect(repos.outbox.due(AT, 10)).toHaveLength(0);
    expect(repos.outbox.markSent(row.id, AT)).toBe(1);
    expect(repos.outbox.markSent(row.id, AT)).toBe(0);
    expect(repos.outbox.listByDedupePrefix("refund:RF-1:")).toHaveLength(1);
    expect(repos.outbox.listByConversation(convId)[0].status).toBe("sent");
    repos.outbox.enqueue({ dedupeKey: "k2", conversationId: convId, payload, at: AT });
    const k2 = repos.outbox.due(AT, 10)[0];
    expect(repos.outbox.markFailed(k2.id, 8, "x")).toBe(1);
    expect(repos.outbox.listByConversation(convId).map((r) => r.status)).toEqual(["sent", "failed"]);
  });

  it("logs：dedupeKey 去重与计数", () => {
    repos.logs.write({ scope: "refund", refId: "RF-1", node: "submit", event: "submitted", dedupeKey: "d1", detail: { a: 1 } });
    repos.logs.write({ scope: "refund", refId: "RF-1", node: "submit", event: "submitted", dedupeKey: "d1" });
    repos.logs.write({ scope: "refund", refId: "RF-1", node: "decide", event: "approved" });
    expect(repos.logs.list("refund", "RF-1")).toHaveLength(2);
    expect(JSON.parse(repos.logs.list("refund", "RF-1")[0].detail_json)).toEqual({ a: 1 });
    expect(repos.logs.count("refund")).toBe(2);
    expect(repos.logs.count("refund", { event: "approved" })).toBe(1);
    expect(repos.logs.count("refund", { node: "submit", event: "approved" })).toBe(0);
  });

  it("assignmentState get/set", () => {
    repos.assignmentState.set("rr_cursor", "seat_B");
    expect(repos.assignmentState.get("rr_cursor")).toBe("seat_B");
    expect(repos.assignmentState.get("nope")).toBeUndefined();
  });
});

describe("KeyedMutex", () => {
  it("同 key 串行 FIFO、异常不影响后续、不同 key 并行、idle 等待", async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    const slow = m.withLock("k", async () => { await new Promise((r) => setTimeout(r, 30)); order.push("a"); });
    const fail = m.withLock("k", async () => { order.push("b"); throw new Error("x"); });
    const last = m.withLock("k", async () => { order.push("c"); return 7; });
    const other = m.withLock("k2", async () => { order.push("other"); });
    expect(m.isLocked("k")).toBe(true);
    await expect(fail).rejects.toThrow("x");
    expect(await last).toBe(7);
    await slow; await other;
    await m.idle("k");
    expect(order).toEqual(["other", "a", "b", "c"]);
    expect(m.isLocked("k")).toBe(false);
    await m.idle("never-used");
  });
});

// 验证矩阵 #5：未审批/拒绝不退款、批准只执行一次（SPEC §K.2 第 5 条）。对话式申请块独立使用 startMcp:true，其余 startMcp:false。
import { Command } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestContainer, lastAiMessage, makeTestEnv, sendAndWait, type Container, type TestEnv } from "./helpers/env";
import { REVIEWER, count, createPendingRefund, execCount, orderStatus, outboxRows } from "./helpers/refund";

let env: TestEnv;
let c: Container;

beforeEach(async () => {
  env = makeTestEnv();
  c = await buildTestContainer(env, { startMcp: false });
});
afterEach(async () => {
  await c.close();
  env.cleanup();
});

const req = (id: string) => c.repos.refunds.get(id)!;

describe("对话式申请（真实 Mock 模型与 MCP）", () => {
  let cc: Container;
  let cenv: TestEnv;
  beforeEach(async () => {
    cenv = makeTestEnv();
    cc = await buildTestContainer(cenv, { startMcp: true });
  });
  afterEach(async () => {
    await cc.close();
    cenv.cleanup();
  });

  it("cust_a 发“我要申请退款 ORD-1001”→回复含“请告诉我退款理由”，此时尚无退款申请", async () => {
    const r = await sendAndWait(cc, "cust_a", "我要申请退款 ORD-1001");
    expect(r.outcome?.status).toBe("completed");
    expect(lastAiMessage(cc, r.conversation.id)!.content).toContain("请告诉我退款理由");
    expect(count(cc, "SELECT COUNT(*) AS n FROM refund_requests")).toBe(0);
  });

  it("再发“原因是质量问题”→回复含“已为您提交退款申请 RF-”与“退款尚未完成”，不含“已退款”", async () => {
    const first = await sendAndWait(cc, "cust_a", "我要申请退款 ORD-1001");
    const second = await sendAndWait(cc, "cust_a", "原因是质量问题", { ticketId: first.ticket.id });
    expect(second.outcome?.status).toBe("completed");
    const text = lastAiMessage(cc, second.conversation.id)!.content;
    expect(text).toContain("已为您提交退款申请 RF-");
    expect(text).toContain("退款尚未完成");
    expect(text).not.toContain("已退款");
  });

  it("对话路径下 refund_requests 1 行：pending_review/59900/version=1/idempotency_key=refund:ORD-1001:v1，且有 interrupt、订单仍 paid、无执行记录", async () => {
    const first = await sendAndWait(cc, "cust_a", "我要申请退款 ORD-1001");
    await sendAndWait(cc, "cust_a", "原因是质量问题", { ticketId: first.ticket.id });
    const rows = cc.db.prepare("SELECT * FROM refund_requests").all() as Array<Record<string, any>>;
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.order_id).toBe("ORD-1001");
    expect(r.status).toBe("pending_review");
    expect(r.amount_minor).toBe(59900);
    expect(r.version).toBe(1);
    expect(r.idempotency_key).toBe("refund:ORD-1001:v1");
    const insp = await cc.refundRunner.inspect(r.id);
    expect(insp.interrupts).toHaveLength(1);
    expect(orderStatus(cc, "ORD-1001")).toBe("paid");
    expect(execCount(cc, r.id)).toBe(0);
  });
});

describe("提交后的等待态", () => {
  it("pending_review、存在 interrupt、订单仍 paid、无执行记录、outbox 有 submitted 通知", async () => {
    const id = await createPendingRefund(c, "cust_a", "ORD-1001");
    const r = req(id);
    expect(r.status).toBe("pending_review");
    expect(r.amount_minor).toBe(59900);
    expect(r.version).toBe(1);
    expect(r.idempotency_key).toBe("refund:ORD-1001:v1");
    expect(r.thread_id).toBe(`refund:${id}:a1`);
    const insp = await c.refundRunner.inspect(id);
    expect(insp.hasCheckpoint).toBe(true);
    expect(insp.interrupts).toHaveLength(1);
    expect(insp.next).toContain("await_decision");
    expect(insp.interrupts[0].value).toMatchObject({ type: "refund_review", requestId: id, orderId: "ORD-1001", amountMinor: 59900, attempt: 1 });
    expect(orderStatus(c, "ORD-1001")).toBe("paid");
    expect(execCount(c, id)).toBe(0);
    expect(outboxRows(c, id, "submitted")).toBe(1);
  });
});

describe("未审批 / 拒绝不退款", () => {
  it("伪造 resume({approved:true}) 不会退款：仍 pending_review 且仍有 interrupt", async () => {
    const id = await createPendingRefund(c, "cust_a", "ORD-1001");
    const cfg = { configurable: { thread_id: req(id).thread_id }, durability: "sync" as const };
    await c.refundGraph.invoke(new Command({ resume: { approved: true } }), cfg);
    expect(orderStatus(c, "ORD-1001")).toBe("paid");
    expect(execCount(c, id)).toBe(0);
    expect(req(id).status).toBe("pending_review");
    const snap = await c.refundGraph.getState(cfg);
    expect(snap.tasks.flatMap((t) => t.interrupts).length).toBeGreaterThan(0);
    // 状态中不存在任何审批结论字段
    expect(Object.keys(snap.values)).not.toContain("approved");
  });

  it("拒绝：status=rejected、订单 paid、无执行；outbox 有 rejected 通知；retry → 409 NOT_RETRYABLE", async () => {
    const id = await createPendingRefund(c, "cust_c", "ORD-1005");
    const out = await c.services.refunds.decide(REVIEWER, id, "rejected", "不符合七天无理由");
    expect(out.flow.ok).toBe(true);
    expect(out.flow.outcome?.status).toBe("completed");
    expect(req(id).status).toBe("rejected");
    expect(orderStatus(c, "ORD-1005")).toBe("paid");
    expect(execCount(c, id)).toBe(0);
    expect(c.repos.outbox.listByDedupePrefix(`refund:${id}:rejected:a1`)).toHaveLength(1);
    expect(req(id).flow_completed_at).not.toBeNull();
    const row = c.repos.outbox.listByDedupePrefix(`refund:${id}:rejected:a1`)[0];
    expect(JSON.parse(row.payload_json).text).toContain("不符合七天无理由");
    await expect(c.services.refunds.retry(REVIEWER, id)).rejects.toMatchObject({ status: 409, code: "NOT_RETRYABLE" });
  });
});

describe("批准只执行一次", () => {
  it("批准：completed、refunded、订单与支付已退款、success 恰 1 行、outbox refunded 1 行；tick 后系统消息 1 条", async () => {
    const id = await createPendingRefund(c, "cust_a", "ORD-1001");
    const out = await c.services.refunds.decide(REVIEWER, id, "approved", "同意");
    expect(out.flow.ok).toBe(true);
    expect(out.flow.outcome?.status).toBe("completed");
    expect(req(id).status).toBe("refunded");
    const order = c.repos.orders.get("ORD-1001")!;
    expect(order.payment_status).toBe("refunded");
    expect(order.refund_note).toBe("已退款（模拟）");
    expect(c.repos.orders.getPayment("ORD-1001")!.status).toBe("refunded");
    expect(execCount(c, id, "success")).toBe(1);
    expect(execCount(c, id)).toBe(1);
    expect(outboxRows(c, id, "refunded")).toBe(1);
    expect(req(id).flow_completed_at).not.toBeNull();

    const tick = await c.outbox.tick();
    expect(tick.failed).toBe(0);
    const conv = req(id).conversation_id;
    const sys = c.repos.messages
      .list(conv)
      .filter((m) => m.sender_type === "system" && m.content.includes("已审核通过并完成模拟退款"));
    expect(sys).toHaveLength(1);
    expect(sys[0].content).toContain("【退款进度】");
    expect(sys[0].content).toContain(id);
  });

  it("失败与重试：ORD-1003 首次执行失败 → failed；retry → attempt=2、新 thread、refunded、执行共 2 行（1 failed + 1 success）", async () => {
    const id = await createPendingRefund(c, "cust_b", "ORD-1003");
    const out = await c.services.refunds.decide(REVIEWER, id, "approved", "同意");
    expect(out.flow.ok).toBe(true);
    let r = req(id);
    expect(r.status).toBe("failed");
    expect(r.failure_reason).toContain("模拟支付渠道退款失败");
    expect(execCount(c, id, "failed")).toBe(1);
    expect(execCount(c, id, "success")).toBe(0);
    expect(orderStatus(c, "ORD-1003")).toBe("paid");
    expect(outboxRows(c, id, "failed")).toBe(1);
    expect(c.repos.outbox.listByDedupePrefix(`refund:${id}:failed:a1`)).toHaveLength(1);
    expect(r.flow_completed_at).not.toBeNull();
    // 面向客户的失败通知不暴露内部原因
    const failedRow = c.repos.outbox.listByDedupePrefix(`refund:${id}:failed:a1`)[0];
    expect(JSON.parse(failedRow.payload_json).text).not.toContain("模拟支付渠道");

    const retried = await c.services.refunds.retry(REVIEWER, id);
    expect(retried.flow.ok).toBe(true);
    r = req(id);
    expect(r.attempt).toBe(2);
    expect(r.thread_id).toBe(`refund:${id}:a2`);
    expect(r.status).toBe("refunded");
    expect(r.failure_reason).toBeNull();
    expect(execCount(c, id)).toBe(2);
    expect(execCount(c, id, "failed")).toBe(1);
    expect(execCount(c, id, "success")).toBe(1);
    expect(orderStatus(c, "ORD-1003")).toBe("refunded");
    expect(c.repos.outbox.listByDedupePrefix(`refund:${id}:refunded:a2`)).toHaveLength(1);
    expect(r.flow_completed_at).not.toBeNull();
    // 再次重试不可行
    await expect(c.services.refunds.retry(REVIEWER, id)).rejects.toMatchObject({ status: 409, code: "NOT_RETRYABLE" });
  });
});

describe("提交的边界结果", () => {
  it("重复申请幂等返回已有申请；未支付 → NOT_PAID；他人订单 → ORDER_NOT_FOUND；已退款订单 → ALREADY_REFUNDED", async () => {
    const id = await createPendingRefund(c, "cust_a", "ORD-1001");
    const base = req(id);
    const ctx = { customerId: "cust_a", ticketId: base.ticket_id, conversationId: base.conversation_id };

    const dup = await c.services.refunds.submit({ ...ctx, orderId: "ORD-1001", reason: "质量问题" });
    expect(dup).toMatchObject({ ok: true, existing: true });
    if (dup.ok) expect(dup.request.id).toBe(id);
    expect(count(c, "SELECT COUNT(*) AS n FROM refund_requests WHERE order_id = 'ORD-1001'")).toBe(1);

    const unpaid = await c.services.refunds.submit({ ...ctx, orderId: "ORD-1002", reason: "质量问题" });
    expect(unpaid).toMatchObject({ ok: false, code: "NOT_PAID" });

    const others = await c.services.refunds.submit({ ...ctx, orderId: "ORD-1003", reason: "质量问题" });
    expect(others).toMatchObject({ ok: false, code: "ORDER_NOT_FOUND" });

    const refunded = await c.services.refunds.submit({ ...ctx, orderId: "ORD-1007", reason: "质量问题" });
    expect(refunded).toMatchObject({ ok: false, code: "ALREADY_REFUNDED" });

    expect(count(c, "SELECT COUNT(*) AS n FROM refund_requests")).toBe(1);
  });
});

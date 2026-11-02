// 验证矩阵 #9：重复回调、并发审批、重复恢复、outbox 重试与投递幂等（SPEC §K.2 第 9 条）。startMcp:false。
import { Command } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestContainer, makeTestEnv, type Container, type TestEnv } from "./helpers/env";
import { call, startHttp } from "./helpers/http";
import { REVIEWER, count, createPendingRefund, execCount, orderStatus, outboxRows, systemMessageCount } from "./helpers/refund";

let env: TestEnv;
let c: Container;
let http: { baseUrl: string; close(): Promise<void> } | null;

const reviewer = { role: "reviewer" as const, id: REVIEWER };
const BASE_CONFIG = { modelProvider: "mock" as const, mcpSharedSecret: "test-secret", outboxPollMs: 50, outboxMaxAttempts: 8 };

beforeEach(async () => {
  env = makeTestEnv();
  http = null;
});
afterEach(async () => {
  await http?.close();
  await c?.close();
  env.cleanup();
});

describe("重复回调与并发审批", () => {
  it("同一申请连续两次 HTTP decide(approved)：第二次 200 且 idempotent:true；success 执行 1 行", async () => {
    c = await buildTestContainer(env, { startMcp: false });
    http = await startHttp(c);
    const id = await createPendingRefund(c, "cust_a", "ORD-1001");
    const body = { decision: "approved", comment: "同意" };
    const r1 = await call(http.baseUrl, "POST", `/api/reviewer/refunds/${id}/decide`, reviewer, body);
    const r2 = await call(http.baseUrl, "POST", `/api/reviewer/refunds/${id}/decide`, reviewer, body);
    expect(r1.status).toBe(200);
    expect(r1.body.idempotent).toBe(false);
    expect(r2.status).toBe(200);
    expect(r2.body.idempotent).toBe(true);
    expect(execCount(c, id, "success")).toBe(1);
    expect(c.repos.refunds.get(id)!.status).toBe("refunded");
    expect(outboxRows(c, id, "refunded")).toBe(1);
  });

  it("并发 decide(approved) × 2 → 均成功，success 1 行", async () => {
    c = await buildTestContainer(env, { startMcp: false });
    const id = await createPendingRefund(c, "cust_a", "ORD-1001");
    const rs = await Promise.all([
      c.services.refunds.decide(REVIEWER, id, "approved", "同意"),
      c.services.refunds.decide(REVIEWER, id, "approved", "同意"),
    ]);
    expect(rs.filter((r) => r.idempotent)).toHaveLength(1);
    expect(rs.every((r) => r.flow.ok)).toBe(true);
    expect(execCount(c, id, "success")).toBe(1);
    expect(execCount(c, id)).toBe(1);
    expect(c.repos.refunds.get(id)!.status).toBe("refunded");
    expect(outboxRows(c, id, "refunded")).toBe(1);
  });

  it("并发 decide(approved) 与 decide(rejected)：一个成功一个 409 ALREADY_DECIDED；最终状态与成功者一致，执行 ≤ 1 行", async () => {
    c = await buildTestContainer(env, { startMcp: false });
    const id = await createPendingRefund(c, "cust_c", "ORD-1005");
    const settled = await Promise.allSettled([
      c.services.refunds.decide(REVIEWER, id, "approved", "同意"),
      c.services.refunds.decide(REVIEWER, id, "rejected", "拒绝"),
    ]);
    const ok = settled.filter((s): s is PromiseFulfilledResult<Awaited<ReturnType<typeof c.services.refunds.decide>>> => s.status === "fulfilled");
    const bad = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toMatchObject({ status: 409, code: "ALREADY_DECIDED" });
    const winner = ok[0].value.decision.decision;
    expect(c.repos.refunds.getDecision(id)!.decision).toBe(winner);
    expect(c.repos.refunds.get(id)!.status).toBe(winner === "approved" ? "refunded" : "rejected");
    expect(execCount(c, id)).toBeLessThanOrEqual(1);
    expect(execCount(c, id)).toBe(winner === "approved" ? 1 : 0);
    expect(orderStatus(c, "ORD-1005")).toBe(winner === "approved" ? "refunded" : "paid");
  });
});

describe("重复恢复", () => {
  it("完成后重复 drive(recovery) ×2、recoverRefundFlows、伪造 invoke(resume) 都不改变执行行数", async () => {
    c = await buildTestContainer(env, { startMcp: false });
    const id = await createPendingRefund(c, "cust_a", "ORD-1001");
    const out = await c.services.refunds.decide(REVIEWER, id, "approved", "同意");
    expect(out.flow.outcome?.status).toBe("completed");
    expect(execCount(c, id, "success")).toBe(1);

    expect((await c.refundRunner.drive(id, "recovery")).status).toBe("completed");
    expect((await c.refundRunner.drive(id, "recovery")).status).toBe("completed");
    const report = await c.refundRunner.recoverRefundFlows();
    expect(report.find((r) => r.requestId === id)).toBeUndefined(); // 已完成的流程不再被恢复器处理
    expect(execCount(c, id)).toBe(1);

    const cfg = { configurable: { thread_id: c.repos.refunds.get(id)!.thread_id }, durability: "sync" as const };
    const dec = c.repos.refunds.getDecision(id)!;
    try {
      await c.refundGraph.invoke(new Command({ resume: { decisionId: dec.id } }), cfg);
    } catch {
      // 无论是否抛错，都不应产生副作用
    }
    expect(execCount(c, id)).toBe(1);
    expect(execCount(c, id, "success")).toBe(1);
    expect(outboxRows(c, id, "refunded")).toBe(1);
    expect(orderStatus(c, "ORD-1001")).toBe("refunded");
  });

  it("并发 drive 被同一把锁串行化，不会重复执行", async () => {
    c = await buildTestContainer(env, { startMcp: false });
    const id = await createPendingRefund(c, "cust_a", "ORD-1001");
    // 先落决定但不驱动，再并发驱动多次
    c.repos.refunds.insertDecision({
      id: "RD-TESTONLY01",
      refund_request_id: id,
      reviewer_id: REVIEWER,
      decision: "approved",
      comment: "同意",
      decided_at: new Date().toISOString(),
    });
    c.repos.refunds.transition(id, ["pending_review"], "approved", new Date().toISOString());
    const outs = await Promise.all([c.refundRunner.drive(id, "decision"), c.refundRunner.drive(id, "decision"), c.refundRunner.drive(id, "recovery")]);
    expect(outs.every((o) => o.status === "completed")).toBe(true);
    expect(execCount(c, id, "success")).toBe(1);
    expect(outboxRows(c, id, "refunded")).toBe(1);
  });
});

describe("outbox 重试与投递幂等", () => {
  it("通知投递失败两次后重试成功：每个 dedupe_key 恰 1 条系统消息，退款不重复", async () => {
    c = await buildTestContainer(env, { startMcp: false, faults: { webChannelFailTimes: 2 } });
    const id = await createPendingRefund(c, "cust_a", "ORD-1001");
    await c.services.refunds.decide(REVIEWER, id, "approved", "同意");
    const pending = c.db.prepare("SELECT * FROM outbox WHERE status = 'pending'").all() as Array<{ dedupe_key: string }>;
    expect(pending).toHaveLength(2); // submitted、refunded

    const t1 = await c.outbox.tick();
    expect(t1).toMatchObject({ sent: 0, retried: 2, failed: 0 });
    const rows1 = c.db.prepare("SELECT attempts, next_attempt_at, status FROM outbox").all() as Array<{ attempts: number; next_attempt_at: string; status: string }>;
    for (const r of rows1) {
      expect(r.status).toBe("pending");
      expect(r.attempts).toBe(1);
      expect(r.next_attempt_at > new Date().toISOString()).toBe(true);
    }
    // 退避窗口内再 tick 不会投递
    expect(await c.outbox.tick()).toMatchObject({ sent: 0, retried: 0, failed: 0 });

    c.db.prepare("UPDATE outbox SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE status='pending'").run();
    const t2 = await c.outbox.tick();
    expect(t2).toMatchObject({ sent: 2, retried: 0, failed: 0 });
    const rows2 = c.db.prepare("SELECT dedupe_key, attempts, status FROM outbox").all() as Array<{ dedupe_key: string; attempts: number; status: string }>;
    expect(rows2).toHaveLength(2);
    for (const r of rows2) {
      expect(r.status).toBe("sent");
      expect(r.attempts).toBe(2);
      expect(systemMessageCount(c, r.dedupe_key)).toBe(1);
    }
    expect(execCount(c, id, "success")).toBe(1);
    expect(orderStatus(c, "ORD-1001")).toBe("refunded");
  });

  it("outboxMaxAttempts=2 且持续失败：两次 tick 后行状态为 failed", async () => {
    c = await buildTestContainer(env, {
      startMcp: false,
      config: { ...BASE_CONFIG, outboxMaxAttempts: 2 },
      faults: { webChannelFailTimes: 10 },
    });
    const id = await createPendingRefund(c, "cust_a", "ORD-1001");
    await c.services.refunds.decide(REVIEWER, id, "approved", "同意");
    await c.outbox.tick();
    c.db.prepare("UPDATE outbox SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE status='pending'").run();
    const t2 = await c.outbox.tick();
    expect(t2.failed).toBe(2);
    const rows = c.db.prepare("SELECT status, attempts, last_error FROM outbox").all() as Array<{ status: string; attempts: number; last_error: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "failed" && r.attempts === 2 && r.last_error.length > 0)).toBe(true);
    // 通知失败不影响退款结果，也不会触发再次执行
    expect(execCount(c, id, "success")).toBe(1);
    expect(count(c, "SELECT COUNT(*) AS n FROM messages WHERE client_message_id LIKE 'o:%'")).toBe(0); // 无 outbox 投递产生的系统消息
  });

  it("投递幂等：把已 sent 的行重置为 pending 再 tick，系统消息仍只有 1 条", async () => {
    c = await buildTestContainer(env, { startMcp: false });
    const id = await createPendingRefund(c, "cust_a", "ORD-1001");
    await c.services.refunds.decide(REVIEWER, id, "approved", "同意");
    await c.outbox.tick();
    const key = `refund:${id}:refunded:a1`;
    expect(systemMessageCount(c, key)).toBe(1);
    c.db.prepare("UPDATE outbox SET status = 'pending', sent_at = NULL WHERE dedupe_key = ?").run(key);
    const t = await c.outbox.tick();
    expect(t.sent).toBe(1);
    expect(systemMessageCount(c, key)).toBe(1);
    expect(execCount(c, id)).toBe(1);
  });
});

// 验证矩阵 #7：等待审核期间重启（SPEC §K.2 第 7 条）。startMcp:false。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestContainer, makeTestEnv, restart, type Container, type TestEnv } from "./helpers/env";
import { REVIEWER, createPendingRefund, execCount, orderStatus, outboxRows } from "./helpers/refund";

let env: TestEnv;
let c: Container | null;

beforeEach(async () => {
  env = makeTestEnv();
  c = null;
});
afterEach(async () => {
  await c?.close();
  env.cleanup();
});

describe("等待审核期间重启", () => {
  it("重启后恢复仍处于等待：interrupt 保留；批准后只执行一次并出通知", async () => {
    const c1 = await buildTestContainer(env, { startMcp: false });
    const id = await createPendingRefund(c1, "cust_a", "ORD-1001");
    expect(c1.repos.refunds.get(id)!.status).toBe("pending_review");
    expect((await c1.refundRunner.inspect(id)).interrupts).toHaveLength(1);

    const c2 = (c = await restart(c1, env, { startMcp: false }));
    const report = await c2.refundRunner.recoverRefundFlows();
    const item = report.find((r) => r.requestId === id)!;
    expect(item).toBeDefined();
    expect(item.error).toBeNull();
    expect(item.outcome?.status).toBe("waiting");
    expect(item.before).toMatchObject({ hasCheckpoint: true, interrupted: true });

    const insp = await c2.refundRunner.inspect(id);
    expect(insp.hasCheckpoint).toBe(true);
    expect(insp.interrupts).toHaveLength(1);
    expect(insp.next).toContain("await_decision");
    expect(orderStatus(c2, "ORD-1001")).toBe("paid");
    expect(execCount(c2, id)).toBe(0);

    const out = await c2.services.refunds.decide(REVIEWER, id, "approved", "同意");
    expect(out.flow.ok).toBe(true);
    expect(c2.repos.refunds.get(id)!.status).toBe("refunded");
    expect(execCount(c2, id, "success")).toBe(1);
    expect(outboxRows(c2, id, "refunded")).toBe(1);
    expect(orderStatus(c2, "ORD-1001")).toBe("refunded");
  });

  it("变体：决定已落库但恢复失败（before:verify_decision 崩溃）→ 重启恢复后 refunded 且 success 恰 1 行", async () => {
    const c1 = await buildTestContainer(env, { startMcp: false, crashPoints: ["before:verify_decision"] });
    const id = await createPendingRefund(c1, "cust_a", "ORD-1001");
    const out = await c1.services.refunds.decide(REVIEWER, id, "approved", "同意");
    expect(out.flow.ok).toBe(false);
    expect(out.flow.error).toContain("simulated crash");
    expect(c1.repos.refunds.get(id)!.status).toBe("approved");
    expect(orderStatus(c1, "ORD-1001")).toBe("paid");
    expect(execCount(c1, id)).toBe(0);

    const c2 = (c = await restart(c1, env, { startMcp: false }));
    const report = await c2.refundRunner.recoverRefundFlows();
    const item = report.find((r) => r.requestId === id)!;
    expect(item.error).toBeNull();
    expect(item.outcome?.status).toBe("completed");
    expect(c2.repos.refunds.get(id)!.status).toBe("refunded");
    expect(execCount(c2, id, "success")).toBe(1);
    expect(orderStatus(c2, "ORD-1001")).toBe("refunded");
    expect(outboxRows(c2, id, "refunded")).toBe(1);
  });
});

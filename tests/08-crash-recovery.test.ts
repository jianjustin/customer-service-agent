// 验证矩阵 #8：执行前 / 执行后通知前崩溃，重启恢复（SPEC §K.2 第 8 条，参数化）。startMcp:false。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CrashPointName } from "../server/graphs/refund/crash";
import { buildTestContainer, makeTestEnv, restart, type Container, type TestEnv } from "./helpers/env";
import { REVIEWER, createPendingRefund, execCount, orderStatus, outboxRows, systemMessageCount } from "./helpers/refund";

let env: TestEnv;
let c: Container | null;

beforeEach(() => {
  env = makeTestEnv();
  c = null;
});
afterEach(async () => {
  await c?.close();
  env.cleanup();
});

interface Case {
  point: CrashPointName;
  /** 崩溃后 DB 断言 */
  afterCrash: (c1: Container, id: string) => void;
}

const cases: Case[] = [
  {
    point: "before:execute_refund",
    afterCrash(c1, id) {
      expect(c1.repos.refunds.get(id)!.status).toBe("approved");
      expect(execCount(c1, id)).toBe(0);
      expect(orderStatus(c1, "ORD-1001")).toBe("paid");
    },
  },
  {
    point: "mid:execute_refund",
    afterCrash(c1, id) {
      expect(c1.repos.refunds.get(id)!.status).toBe("executing");
      expect(execCount(c1, id)).toBe(0);
      expect(orderStatus(c1, "ORD-1001")).toBe("paid");
    },
  },
  {
    point: "after:execute_refund",
    afterCrash(c1, id) {
      expect(c1.repos.refunds.get(id)!.status).toBe("refunded");
      expect(execCount(c1, id, "success")).toBe(1);
      expect(outboxRows(c1, id, "refunded")).toBe(0);
    },
  },
  {
    point: "before:enqueue_notification",
    afterCrash(c1, id) {
      const r = c1.repos.refunds.get(id)!;
      expect(r.status).toBe("refunded");
      expect(outboxRows(c1, id, "refunded")).toBe(0);
      expect(r.flow_completed_at).toBeNull();
    },
  },
  {
    point: "after:enqueue_notification",
    afterCrash(c1, id) {
      expect(outboxRows(c1, id, "refunded")).toBe(1);
      expect(c1.repos.refunds.get(id)!.flow_completed_at).not.toBeNull();
    },
  },
];

describe("崩溃点注入后重启恢复", () => {
  it.each(cases)("$point", async ({ point, afterCrash }) => {
    const c1 = await buildTestContainer(env, { startMcp: false, crashPoints: [point] });
    const id = await createPendingRefund(c1, "cust_a", "ORD-1001");

    const out = await c1.services.refunds.decide(REVIEWER, id, "approved", "同意");
    expect(out.flow.ok).toBe(false);
    expect(out.flow.error).toContain("simulated crash");
    expect(out.flow.error).toContain(point);
    afterCrash(c1, id);

    const c2 = (c = await restart(c1, env, { startMcp: false }));
    const report = await c2.refundRunner.recoverRefundFlows();
    const item = report.find((r) => r.requestId === id);
    if (point === "after:enqueue_notification") {
      // flow 已完成：不再被恢复器处理
      expect(item).toBeUndefined();
    } else {
      expect(item).toBeDefined();
      expect(item!.error).toBeNull();
      expect(item!.outcome?.status).toBe("completed");
    }

    const r = c2.repos.refunds.get(id)!;
    expect(r.status).toBe("refunded");
    expect(r.flow_completed_at).not.toBeNull();
    expect(execCount(c2, id)).toBe(1);
    expect(execCount(c2, id, "success")).toBe(1);
    expect(outboxRows(c2, id, "refunded")).toBe(1);
    expect(orderStatus(c2, "ORD-1001")).toBe("refunded");
    expect(c2.repos.orders.getPayment("ORD-1001")!.status).toBe("refunded");

    // 再次恢复 / 驱动都是幂等的（after:enqueue_notification 的残留 checkpoint 在此被吸收）
    expect((await c2.refundRunner.drive(id, "recovery")).status).toBe("completed");
    await c2.refundRunner.recoverRefundFlows();
    expect(execCount(c2, id)).toBe(1);
    expect(outboxRows(c2, id, "refunded")).toBe(1);

    await c2.outbox.tick();
    await c2.outbox.tick();
    expect(systemMessageCount(c2, `refund:${id}:refunded:a1`)).toBe(1);
  });

  it("after:register_review：登记后、进入等待前崩溃 → 重启恢复到等待态，之后批准正常完成", async () => {
    const c1 = await buildTestContainer(env, { startMcp: false, crashPoints: ["after:register_review"] });
    const intake = c1.services.conversation.handleCustomerMessage({ customerId: "cust_a", content: "你好", clientMessageId: "cm-reg-1" });
    if (intake.aiRun) await intake.aiRun;
    const sub = await c1.services.refunds.submit({
      customerId: "cust_a",
      ticketId: intake.ticket.id,
      conversationId: intake.conversation.id,
      orderId: "ORD-1001",
      reason: "质量问题",
    });
    expect(sub.ok).toBe(true);
    if (!sub.ok) return;
    const id = sub.request.id;
    // 崩溃被 submit 吞掉并记日志；状态已是 pending_review，但 Graph 尚未进入等待
    expect(c1.repos.refunds.get(id)!.status).toBe("pending_review");
    expect(c1.repos.logs.count("refund", { event: "drive_error" })).toBe(1);
    expect((await c1.refundRunner.inspect(id)).interrupts).toHaveLength(0);

    const c2 = (c = await restart(c1, env, { startMcp: false }));
    const report = await c2.refundRunner.recoverRefundFlows();
    expect(report.find((r) => r.requestId === id)?.outcome?.status).toBe("waiting");
    const insp = await c2.refundRunner.inspect(id);
    expect(insp.interrupts).toHaveLength(1);
    expect(insp.next).toContain("await_decision");

    const out = await c2.services.refunds.decide(REVIEWER, id, "approved", "同意");
    expect(out.flow.ok).toBe(true);
    expect(c2.repos.refunds.get(id)!.status).toBe("refunded");
    expect(execCount(c2, id, "success")).toBe(1);
    expect(outboxRows(c2, id, "refunded")).toBe(1);
  });
});

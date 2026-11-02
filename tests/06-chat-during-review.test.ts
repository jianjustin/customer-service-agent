// 验证矩阵 #6：退款等待审核期间可继续聊天并查进度（SPEC §K.2 第 6 条）。真实 MCP（startMcp:true）。
import { ToolMessage } from "@langchain/core/messages";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestContainer, lastAiMessage, makeTestEnv, sendAndWait, type Container, type TestEnv } from "./helpers/env";
import { count, execCount, orderStatus } from "./helpers/refund";

let env: TestEnv;
let c: Container;

beforeEach(async () => {
  env = makeTestEnv();
  c = await buildTestContainer(env, { startMcp: true });
});
afterEach(async () => {
  await c.close();
  env.cleanup();
});

describe("等待审核期间可聊天并查进度", () => {
  it("对话提交退款 → 同工单问知识（正常回复）→ 查进度（get_refund_progress）→ 退款 Graph 仍在 interrupt", async () => {
    // 1) 对话方式提交 ORD-1001 退款
    const first = await sendAndWait(c, "cust_a", "我要申请退款 ORD-1001");
    expect(first.outcome?.status).toBe("completed");
    expect(lastAiMessage(c, first.conversation.id)!.content).toContain("请告诉我退款理由");
    const ticketId = first.ticket.id;
    const second = await sendAndWait(c, "cust_a", "原因是质量问题", { ticketId });
    expect(second.outcome?.status).toBe("completed");
    expect(second.ticket.id).toBe(ticketId);

    expect(count(c, "SELECT COUNT(*) AS n FROM refund_requests")).toBe(1);
    const reqRow = c.db.prepare("SELECT id, status, thread_id FROM refund_requests WHERE order_id = 'ORD-1001'").get() as {
      id: string;
      status: string;
      thread_id: string;
    };
    expect(reqRow.status).toBe("pending_review");
    const refundId = reqRow.id;
    const convThreadId = c.repos.conversations.get(first.conversation.id)!.thread_id;

    // 2) 同一工单继续问知识：ai_run completed，含来源
    const kb = await sendAndWait(c, "cust_a", "怎么修改收货地址？", { ticketId });
    expect(kb.conversation.id).toBe(first.conversation.id);
    expect(kb.outcome?.status).toBe("completed");
    const kbReply = lastAiMessage(c, kb.conversation.id)!;
    expect(kbReply.content).toContain("《修改收货地址》v2");
    expect(JSON.parse(kbReply.sources_json)).toEqual([{ id: "kb-001", title: "修改收货地址", version: 2 }]);
    expect(kb.aiRunId).not.toBeNull();
    expect((c.db.prepare("SELECT status FROM ai_runs WHERE id = ?").get(kb.aiRunId!) as { status: string }).status).toBe("completed");

    // 3) 查询进度：agent 线程里有 get_refund_progress ToolMessage，回复含申请号与“待审核”
    const prog = await sendAndWait(c, "cust_a", "我的退款进度怎么样了", { ticketId });
    expect(prog.outcome?.status).toBe("completed");
    const msgs = await c.agent!.getThreadMessages(convThreadId);
    const tms = msgs.filter((m): m is ToolMessage => ToolMessage.isInstance(m) && m.name === "get_refund_progress");
    expect(tms.length).toBeGreaterThanOrEqual(1);
    expect(tms[tms.length - 1]!.status).not.toBe("error");
    const progText = lastAiMessage(c, prog.conversation.id)!.content;
    expect(progText).toContain(refundId);
    expect(progText).toContain("待审核");
    expect(progText).not.toContain("已退款");

    // 4) 退款 Graph 状态不受影响
    const insp = await c.refundRunner.inspect(refundId);
    expect(insp.hasCheckpoint).toBe(true);
    expect(insp.interrupts).toHaveLength(1);
    expect(insp.next).toContain("await_decision");
    expect(c.repos.refunds.get(refundId)!.status).toBe("pending_review");
    expect(orderStatus(c, "ORD-1001")).toBe("paid");
    expect(execCount(c, refundId)).toBe(0);

    // 5) 对话线程与退款线程不同
    const refundThreadId = c.repos.refunds.get(refundId)!.thread_id;
    expect(convThreadId).toMatch(/^conv_/);
    expect(refundThreadId).toBe(`refund:${refundId}:a1`);
    expect(convThreadId).not.toBe(refundThreadId);
  });
});

// 退款相关测试辅助（SPEC §K.1）。
import { expect } from "vitest";
import type { Container } from "./env";

let seq = 0;

/** 建工单（startMcp:false 下 ai_run 会 failed，无妨）后提交退款申请，返回 requestId，状态应为 pending_review */
export async function createPendingRefund(c: Container, customerId: string, orderId: string): Promise<string> {
  const intake = c.services.conversation.handleCustomerMessage({
    customerId,
    content: "你好",
    clientMessageId: `refund-helper-${Date.now().toString(36)}-${seq++}`,
    newTicket: true,
  });
  if (intake.aiRun) await intake.aiRun;
  const r = await c.services.refunds.submit({
    customerId,
    ticketId: intake.ticket.id,
    conversationId: intake.conversation.id,
    orderId,
    reason: "质量问题",
  });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(r.message);
  expect(r.existing).toBe(false);
  expect(c.repos.refunds.get(r.request.id)!.status).toBe("pending_review");
  return r.request.id;
}

export const REVIEWER = "reviewer_1";

export const count = (c: Container, sql: string, ...args: unknown[]): number =>
  (c.db.prepare(sql).get(...args) as { n: number }).n;

export const execCount = (c: Container, id: string, status?: "success" | "failed"): number =>
  status
    ? count(c, "SELECT COUNT(*) AS n FROM refund_executions WHERE refund_request_id = ? AND status = ?", id, status)
    : count(c, "SELECT COUNT(*) AS n FROM refund_executions WHERE refund_request_id = ?", id);

export const outboxRows = (c: Container, id: string, status: string) =>
  count(c, "SELECT COUNT(*) AS n FROM outbox WHERE dedupe_key LIKE ?", `refund:${id}:${status}:%`);

export const orderStatus = (c: Container, orderId: string): string =>
  (c.db.prepare("SELECT payment_status AS s FROM orders WHERE id = ?").get(orderId) as { s: string }).s;

/** 会话中某退款通知（按 outbox dedupe_key）对应的系统消息条数 */
export const systemMessageCount = (c: Container, dedupeKey: string): number =>
  count(c, "SELECT COUNT(*) AS n FROM messages WHERE client_message_id = ?", "o:" + dedupeKey);

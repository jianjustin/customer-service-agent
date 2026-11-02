// 审核台路由（SPEC §D.5）。reviewer 可读写全部退款申请；决定记录 reviewer_id = actor.id。
import { Router } from "express";
import { z } from "zod";
import type { Container } from "../container";
import type { RefundDecisionRow, RefundStatus } from "../domain/types";
import { AppError } from "../errors";
import { param, parseBody, refundDto } from "./shared";
import { toOrderDTO } from "../domain/dto";

const REFUND_STATUSES = ["submitted", "pending_review", "approved", "rejected", "executing", "refunded", "failed"] as const;
const listQuery = z.object({ status: z.enum(REFUND_STATUSES).optional() });
const decideBody = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    comment: z.string().trim().min(1).max(500),
  })
  .strict();
const retryBody = z.object({}).strict();

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function reviewerRouter(c: Container): Router {
  const r = Router();

  const decisionDto = (d: RefundDecisionRow) => ({
    id: d.id,
    reviewerId: d.reviewer_id,
    reviewerName: c.repos.identity.getReviewer(d.reviewer_id)?.name ?? d.reviewer_id,
    decision: d.decision,
    comment: d.comment,
    decidedAt: d.decided_at,
  });

  r.get("/refunds", (req, res) => {
    const { status } = listQuery.parse(req.query);
    const rows = c.repos.refunds.listAll(status as RefundStatus | undefined);
    res.json({
      refunds: rows.map((x) => ({
        ...refundDto(c, x, "staff"),
        customerName: c.repos.identity.getCustomer(x.customer_id)?.name ?? x.customer_id,
        orderTitle: c.repos.orders.get(x.order_id)?.title ?? x.order_id,
      })),
    });
  });

  r.get("/refunds/:id", async (req, res) => {
    const id = param(req, "id");
    const req0 = c.repos.refunds.get(id);
    if (!req0) throw new AppError(404, "NOT_FOUND", "退款申请不存在");
    const customer = c.repos.identity.getCustomer(req0.customer_id)!;
    const order = c.repos.orders.get(req0.order_id)!;
    const decision = c.repos.refunds.getDecision(id);

    let graph: { threadId: string; hasCheckpoint: boolean; next: string[]; waitingForReview: boolean };
    try {
      const g = await c.refundRunner.inspect(id);
      graph = { threadId: req0.thread_id, hasCheckpoint: g.hasCheckpoint, next: g.next, waitingForReview: g.interrupts.length > 0 };
    } catch (e) {
      console.error("[reviewer] inspect 失败：", e);
      graph = { threadId: req0.thread_id, hasCheckpoint: false, next: [], waitingForReview: false };
    }

    res.json({
      refund: refundDto(c, req0, "staff"),
      customer: { id: customer.id, name: customer.name },
      order: toOrderDTO(order, c.repos.orders.getPayment(order.id) ?? null),
      evidence: safeJson(req0.evidence_json),
      decision: decision ? decisionDto(decision) : null,
      executions: c.repos.refunds.listExecutions(id).map((e) => ({
        id: e.id,
        attempt: e.attempt,
        status: e.status,
        amountMinor: e.amount_minor,
        failureReason: e.failure_reason,
        executedAt: e.executed_at,
      })),
      logs: c.repos.logs.list("refund", id).map((l) => ({
        node: l.node,
        event: l.event,
        detail: safeJson(l.detail_json),
        createdAt: l.created_at,
      })),
      notifications: c.repos.outbox.listByDedupePrefix(`refund:${id}:`).map((o) => ({
        dedupeKey: o.dedupe_key,
        status: o.status,
        attempts: o.attempts,
        lastError: o.last_error,
        sentAt: o.sent_at,
      })),
      graph,
    });
  });

  r.post("/refunds/:id/decide", async (req, res) => {
    const body = parseBody(decideBody, req);
    const out = await c.services.refunds.decide(req.actor!.id, param(req, "id"), body.decision, body.comment);
    res.json({
      refund: refundDto(c, out.request, "staff"),
      decision: decisionDto(out.decision),
      idempotent: out.idempotent,
      flow: out.flow,
    });
  });

  r.post("/refunds/:id/retry", async (req, res) => {
    parseBody(retryBody, req);
    const out = await c.services.refunds.retry(req.actor!.id, param(req, "id"));
    res.json({ refund: refundDto(c, out.request, "staff"), flow: out.flow });
  });

  return r;
}

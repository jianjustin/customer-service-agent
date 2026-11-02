import type { Db } from "../db/connection";
import type { RefundDecisionRow, RefundExecutionRow, RefundRequestRow, RefundStatus } from "../domain/types";
import type { RefundRepo } from "./interfaces";

export function createRefundRepo(db: Db): RefundRepo {
  return {
    get: (id) => db.prepare("SELECT * FROM refund_requests WHERE id = ?").get(id) as RefundRequestRow | undefined,
    findActiveByOrder: (orderId) =>
      db
        .prepare("SELECT * FROM refund_requests WHERE order_id = ? AND status NOT IN ('rejected','failed') ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .get(orderId) as RefundRequestRow | undefined,
    countByOrder: (orderId) =>
      (db.prepare("SELECT COUNT(*) AS n FROM refund_requests WHERE order_id = ?").get(orderId) as { n: number }).n,
    insert(row) {
      db.prepare(
        `INSERT INTO refund_requests(id, customer_id, ticket_id, conversation_id, order_id, amount_minor, currency, reason,
           evidence_json, version, status, idempotency_key, thread_id, attempt, failure_reason, flow_completed_at,
           created_at, updated_at)
         VALUES (@id, @customer_id, @ticket_id, @conversation_id, @order_id, @amount_minor, @currency, @reason,
           @evidence_json, @version, @status, @idempotency_key, @thread_id, @attempt, @failure_reason, @flow_completed_at,
           @created_at, @updated_at)`,
      ).run(row);
    },
    listByCustomer: (customerId) =>
      db
        .prepare("SELECT * FROM refund_requests WHERE customer_id = ? ORDER BY created_at DESC, rowid DESC")
        .all(customerId) as RefundRequestRow[],
    listByTicket: (ticketId) =>
      db.prepare("SELECT * FROM refund_requests WHERE ticket_id = ? ORDER BY created_at, rowid").all(ticketId) as RefundRequestRow[],
    listAll(status?: RefundStatus) {
      if (status) {
        return db
          .prepare("SELECT * FROM refund_requests WHERE status = ? ORDER BY created_at DESC, rowid DESC")
          .all(status) as RefundRequestRow[];
      }
      return db.prepare("SELECT * FROM refund_requests ORDER BY created_at DESC, rowid DESC").all() as RefundRequestRow[];
    },
    listFlowOpen: () =>
      db
        .prepare("SELECT * FROM refund_requests WHERE flow_completed_at IS NULL ORDER BY created_at, rowid")
        .all() as RefundRequestRow[],
    transition(id, from, to, at, extra) {
      if (from.length === 0) return 0;
      const placeholders = from.map(() => "?").join(",");
      const hasFailure = extra !== undefined && "failureReason" in extra;
      const sql = `UPDATE refund_requests SET status = ?, updated_at = ?${hasFailure ? ", failure_reason = ?" : ""}
                   WHERE id = ? AND status IN (${placeholders})`;
      const args: unknown[] = [to, at];
      if (hasFailure) args.push(extra.failureReason ?? null);
      args.push(id, ...from);
      return db.prepare(sql).run(...args).changes;
    },
    prepareRetry: (id, expectedAttempt, newThreadId, at) =>
      db
        .prepare(
          `UPDATE refund_requests SET status = 'approved', attempt = attempt + 1, thread_id = ?, failure_reason = NULL,
             flow_completed_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'failed' AND attempt = ?`,
        )
        .run(newThreadId, at, id, expectedAttempt).changes,
    markFlowCompleted: (id, at) =>
      db.prepare("UPDATE refund_requests SET flow_completed_at = ? WHERE id = ? AND flow_completed_at IS NULL").run(at, id).changes,
    getDecision: (requestId) =>
      db.prepare("SELECT * FROM refund_decisions WHERE refund_request_id = ?").get(requestId) as RefundDecisionRow | undefined,
    insertDecision(row) {
      db.prepare(
        `INSERT INTO refund_decisions(id, refund_request_id, reviewer_id, decision, comment, decided_at)
         VALUES (@id, @refund_request_id, @reviewer_id, @decision, @comment, @decided_at)`,
      ).run(row);
    },
    listExecutions: (requestId) =>
      db
        .prepare("SELECT * FROM refund_executions WHERE refund_request_id = ? ORDER BY attempt")
        .all(requestId) as RefundExecutionRow[],
    getSuccessExecution: (requestId) =>
      db
        .prepare("SELECT * FROM refund_executions WHERE refund_request_id = ? AND status = 'success'")
        .get(requestId) as RefundExecutionRow | undefined,
    getExecution: (requestId, attempt) =>
      db
        .prepare("SELECT * FROM refund_executions WHERE refund_request_id = ? AND attempt = ?")
        .get(requestId, attempt) as RefundExecutionRow | undefined,
    sumSuccessByOrder: (orderId) =>
      (
        db
          .prepare("SELECT COALESCE(SUM(amount_minor), 0) AS total FROM refund_executions WHERE order_id = ? AND status = 'success'")
          .get(orderId) as { total: number }
      ).total,
    insertExecution(row) {
      db.prepare(
        `INSERT INTO refund_executions(id, refund_request_id, order_id, attempt, status, amount_minor, failure_reason, executed_at)
         VALUES (@id, @refund_request_id, @order_id, @attempt, @status, @amount_minor, @failure_reason, @executed_at)`,
      ).run(row);
    },
  };
}

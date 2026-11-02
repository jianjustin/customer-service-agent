// 退款服务（SPEC §E.4）：提交 / 审核决定 / 重试。
// 关键约束：决定先落库，再恢复 Graph；Graph 的执行节点只信任 refund_decisions。
// 本服务只依赖 RefundRunner 接口（批次 2 为 stub，批次 3 替换为真实 Graph）。
import type { Db } from "../db/connection";
import { tx } from "../db/connection";
import { toOrderDTO } from "../domain/dto";
import type { RefundDecisionRow, RefundRequestRow } from "../domain/types";
import { AppError } from "../errors";
import type { FlowOutcome, RefundRunner } from "../graphs/refund/runner";
import type { Repos } from "../repos/interfaces";
import { newRefundId, nowIso, randomId } from "../util";
import type { KeyedMutex } from "./locks";
import { refundDedupeKey, renderNotification } from "./outbox";

export type SubmitResult =
  | { ok: true; existing: boolean; request: RefundRequestRow }
  | {
      ok: false;
      code: "ORDER_NOT_FOUND" | "NOT_PAID" | "ALREADY_REFUNDED" | "PAYMENT_NOT_SUCCEEDED" | "AMOUNT_INVALID" | "REASON_REQUIRED" | "RUN_CANCELLED";
      message: string;
    };

export interface FlowReport {
  ok: boolean;
  outcome: FlowOutcome | null;
  error: string | null;
}

export interface RefundService {
  submit(input: {
    customerId: string;
    ticketId: string;
    conversationId: string;
    orderId: string;
    reason: string;
    /** 写事务内的前置守卫（AI 工具传入：run 仍有效）；返回 false 时不产生任何写入，返回 RUN_CANCELLED */
    guard?: () => boolean;
  }): Promise<SubmitResult>;
  decide(
    reviewerId: string,
    requestId: string,
    decision: "approved" | "rejected",
    comment: string,
  ): Promise<{ request: RefundRequestRow; decision: RefundDecisionRow; idempotent: boolean; flow: FlowReport }>;
  retry(reviewerId: string, requestId: string): Promise<{ request: RefundRequestRow; flow: FlowReport }>;
  progressForCustomer(customerId: string): RefundRequestRow[];
}

function isUniqueViolation(e: unknown): boolean {
  return (
    !!e &&
    typeof e === "object" &&
    typeof (e as { code?: unknown }).code === "string" &&
    ((e as { code: string }).code === "SQLITE_CONSTRAINT_UNIQUE" || (e as { code: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY")
  );
}

export function createRefundService(deps: { db: Db; repos: Repos; runner: RefundRunner; locks: KeyedMutex }): RefundService {
  const { db, repos, runner, locks } = deps;

  /** 驱动 Graph；异常（含模拟崩溃）收敛进 FlowReport，决定已持久化，后续由启动恢复处理 */
  async function driveSafely(requestId: string, reason: "submit" | "decision" | "retry"): Promise<FlowReport> {
    try {
      const outcome = await runner.drive(requestId, reason);
      return { ok: true, outcome, error: null };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      try {
        repos.logs.write({ scope: "refund", refId: requestId, node: "runner", event: "drive_error", detail: { reason, error } });
      } catch {
        // 日志失败不影响返回
      }
      return { ok: false, outcome: null, error };
    }
  }

  async function submit(input: {
    customerId: string;
    ticketId: string;
    conversationId: string;
    orderId: string;
    reason: string;
    guard?: () => boolean;
  }): Promise<SubmitResult> {
    const { customerId, ticketId, conversationId, orderId } = input;
    const reason = input.reason.trim();
    if (reason.length < 2) return { ok: false, code: "REASON_REQUIRED", message: "请提供退款理由" };

    type TxOut = { result: SubmitResult; createdId: string | null };
    let out: TxOut;
    try {
      out = tx(db, (): TxOut => {
        const at = nowIso();
        if (input.guard && !input.guard()) {
          return { result: { ok: false, code: "RUN_CANCELLED", message: "会话已由人工接管，操作未执行" }, createdId: null };
        }
        const order = repos.orders.get(orderId);
        if (!order || order.customer_id !== customerId) {
          return { result: { ok: false, code: "ORDER_NOT_FOUND", message: "未找到该订单，或该订单不属于当前账户" }, createdId: null };
        }
        const active = repos.refunds.findActiveByOrder(orderId);
        if (active) return { result: { ok: true, existing: true, request: active }, createdId: null };
        if (order.payment_status === "refunded") {
          return { result: { ok: false, code: "ALREADY_REFUNDED", message: "该订单已退款，无需重复申请" }, createdId: null };
        }
        if (order.payment_status !== "paid") {
          return { result: { ok: false, code: "NOT_PAID", message: "该订单尚未支付，无需退款" }, createdId: null };
        }
        const payment = repos.orders.getPayment(orderId);
        if (!payment || payment.status !== "succeeded") {
          return { result: { ok: false, code: "PAYMENT_NOT_SUCCEEDED", message: "支付记录异常，暂无法申请退款" }, createdId: null };
        }
        const refundable = order.amount_minor - repos.refunds.sumSuccessByOrder(orderId);
        if (refundable !== order.amount_minor || refundable <= 0) {
          return { result: { ok: false, code: "AMOUNT_INVALID", message: "可退金额异常" }, createdId: null };
        }

        const version = repos.refunds.countByOrder(orderId) + 1;
        const id = newRefundId();
        const excerpt = repos.messages
          .list(conversationId)
          .slice(-10)
          .map((m) => ({ senderType: m.sender_type, content: m.content, createdAt: m.created_at }));
        const evidence = {
          orderSnapshot: toOrderDTO(order, payment),
          paymentSnapshot: payment,
          conversationExcerpt: excerpt,
        };
        const row: RefundRequestRow = {
          id,
          customer_id: customerId,
          ticket_id: ticketId,
          conversation_id: conversationId,
          order_id: orderId,
          amount_minor: order.amount_minor,
          currency: order.currency,
          reason,
          evidence_json: JSON.stringify(evidence),
          version,
          status: "submitted",
          idempotency_key: `refund:${orderId}:v${version}`,
          thread_id: `refund:${id}:a1`,
          attempt: 1,
          failure_reason: null,
          flow_completed_at: null,
          created_at: at,
          updated_at: at,
        };
        repos.refunds.insert(row); // 并发下违反部分唯一索引会抛 UNIQUE，整个事务回滚
        const payload = { template: "refund_submitted" as const, requestId: id, orderId, amountMinor: order.amount_minor };
        repos.outbox.enqueue({
          dedupeKey: refundDedupeKey(id, "submitted", 1),
          conversationId,
          payload: { ...payload, text: renderNotification(payload) },
          at,
        });
        repos.logs.write({
          scope: "refund",
          refId: id,
          node: "submit",
          event: "submitted",
          detail: { orderId, customerId },
          dedupeKey: `refund:${id}:submit`,
          at,
        });
        return { result: { ok: true, existing: false, request: row }, createdId: id };
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        const active = repos.refunds.findActiveByOrder(orderId);
        if (active) return { ok: true, existing: true, request: active };
      }
      throw e;
    }

    if (out.createdId) {
      await driveSafely(out.createdId, "submit");
      const fresh = repos.refunds.get(out.createdId);
      if (fresh) return { ok: true, existing: false, request: fresh };
    }
    return out.result;
  }

  async function decide(
    reviewerId: string,
    requestId: string,
    decision: "approved" | "rejected",
    commentRaw: string,
  ): Promise<{ request: RefundRequestRow; decision: RefundDecisionRow; idempotent: boolean; flow: FlowReport }> {
    const comment = commentRaw.trim();
    if (comment.length < 1 || comment.length > 500) {
      throw new AppError(422, "VALIDATION_ERROR", "审核意见不能为空，且不超过 500 字");
    }

    const settle = (existing: RefundDecisionRow): { row: RefundDecisionRow; idempotent: boolean } => {
      if (existing.decision === decision) return { row: existing, idempotent: true };
      throw new AppError(409, "ALREADY_DECIDED", "该申请已有不同的审核决定");
    };

    const decided = tx(db, (): { row: RefundDecisionRow; idempotent: boolean } => {
      const at = nowIso();
      const req = repos.refunds.get(requestId);
      if (!req) throw new AppError(404, "NOT_FOUND", "退款申请不存在");
      const existing = repos.refunds.getDecision(requestId);
      if (existing) return settle(existing);
      if (req.status !== "submitted" && req.status !== "pending_review") {
        throw new AppError(409, "INVALID_STATE", "当前状态不可审核");
      }
      const row: RefundDecisionRow = {
        id: randomId("RD"),
        refund_request_id: requestId,
        reviewer_id: reviewerId,
        decision,
        comment,
        decided_at: at,
      };
      try {
        repos.refunds.insertDecision(row);
      } catch (e) {
        if (isUniqueViolation(e)) {
          const again = repos.refunds.getDecision(requestId);
          if (again) return settle(again);
        }
        throw e;
      }
      const changes = repos.refunds.transition(requestId, ["submitted", "pending_review"], decision, at);
      if (changes !== 1) throw new AppError(409, "INVALID_STATE", "当前状态不可审核"); // 抛错 → 回滚决定
      repos.logs.write({ scope: "refund", refId: requestId, node: "decide", event: decision, detail: { reviewerId, comment }, at });
      return { row, idempotent: false };
    });

    const flow = await driveSafely(requestId, "decision");
    return { request: repos.refunds.get(requestId)!, decision: decided.row, idempotent: decided.idempotent, flow };
  }

  async function retry(reviewerId: string, requestId: string): Promise<{ request: RefundRequestRow; flow: FlowReport }> {
    // 整个重试（含补跑旧线程）串行在退款锁内；drive 自身也使用同一把锁，因此旧线程补跑放在锁外、
    // 重试事务放在锁内：先确保旧线程已完成（flow_completed_at 非空），再在锁内做状态判断与 prepareRetry。
    const prepare = () =>
      locks.withLock("refund:" + requestId, async () =>
        tx(db, () => {
          const at = nowIso();
          const req = repos.refunds.get(requestId);
          if (!req) throw new AppError(404, "NOT_FOUND", "退款申请不存在");
          const dec = repos.refunds.getDecision(requestId);
          if (req.status !== "failed" || !dec || dec.decision !== "approved") {
            throw new AppError(409, "NOT_RETRYABLE", "仅审核通过且执行失败的申请可以重试");
          }
          if (req.flow_completed_at === null) return "flow_open" as const;
          const newAttempt = req.attempt + 1;
          let changes: number;
          try {
            changes = repos.refunds.prepareRetry(requestId, req.attempt, `refund:${requestId}:a${newAttempt}`, at);
          } catch (e) {
            if (isUniqueViolation(e)) throw new AppError(409, "CONFLICT", "该订单已有进行中的退款申请，无法重试");
            throw e;
          }
          if (changes !== 1) throw new AppError(409, "NOT_RETRYABLE", "仅审核通过且执行失败的申请可以重试");
          repos.logs.write({
            scope: "refund",
            refId: requestId,
            node: "retry",
            event: "retry_requested",
            detail: { attempt: newAttempt, reviewerId },
            at,
          });
          return "prepared" as const;
        }),
      );

    let state = await prepare();
    if (state === "flow_open") {
      // 旧线程尚未走完（例如通知未入队）：先补跑到完成，再重新判断
      await runner.drive(requestId, "recovery");
      state = await prepare();
      if (state === "flow_open") throw new AppError(409, "NOT_RETRYABLE", "上一轮退款流程尚未完成，请稍后重试");
    }
    const flow = await driveSafely(requestId, "retry");
    return { request: repos.refunds.get(requestId)!, flow };
  }

  return {
    submit,
    decide,
    retry,
    progressForCustomer: (customerId) => repos.refunds.listByCustomer(customerId).slice(0, 10),
  };
}

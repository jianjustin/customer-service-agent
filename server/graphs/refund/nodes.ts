// 退款 Graph 节点（SPEC §H.3 / §H.4）。
// 每个节点经 instrument 包装：crash.trip("before:"+name) → fn → crash.trip("after:"+name)。
// after: 崩溃意味着节点的数据库副作用已提交但 checkpoint 未记录完成，恢复时节点整体重跑，故每个节点都必须幂等。
// 事务内（tx 回调）禁止 await。
import { interrupt } from "@langchain/langgraph";
import { tx, type Db } from "../../db/connection";
import type { RefundRequestRow } from "../../domain/types";
import type { Repos } from "../../repos/interfaces";
import { refundDedupeKey, renderNotification } from "../../services/outbox";
import { nowIso, randomId } from "../../util";
import type { CrashPointName, CrashPoints } from "./crash";
import type { RefundFlowUpdate, RefundFlowValue } from "./state";
import type { RefundNodeName } from "./node-names";

export interface RefundNodeDeps {
  db: Db;
  repos: Repos;
  crash: CrashPoints;
  faults?: { refundFailure?: (requestId: string, attempt: number) => string | null };
}

/** 业务不变量被破坏（缺少批准决定、attempt 不匹配等）：抛出并回滚，绝不执行退款 */
export class RefundInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefundInvariantError";
  }
}

type NodeFn = (s: RefundFlowValue) => Promise<RefundFlowUpdate>;

export function createRefundNodes(deps: RefundNodeDeps): Record<RefundNodeName, NodeFn> {
  const { db, repos, crash, faults } = deps;

  const instrument =
    (name: RefundNodeName, fn: NodeFn): NodeFn =>
    async (state) => {
      crash.trip(`before:${name}` as CrashPointName);
      const update = await fn(state);
      crash.trip(`after:${name}` as CrashPointName);
      return update;
    };

  const mustGet = (id: string): RefundRequestRow => {
    const req = repos.refunds.get(id);
    if (!req) throw new RefundInvariantError(`退款申请不存在：${id}`);
    return req;
  };

  const log = (
    requestId: string,
    node: string,
    event: string,
    detail?: unknown,
    dedupeKey?: string,
  ): void => repos.logs.write({ scope: "refund", refId: requestId, node, event, detail, dedupeKey });

  // ---------------------------------------------------------------- validate_request
  const validate_request: NodeFn = async (s) => {
    return tx(db, (): RefundFlowUpdate => {
      const req = mustGet(s.requestId);
      // 已处于 failed：上一次运行已提交校验失败但 checkpoint 未记录（after:validate_request 崩溃），按失败结果重放
      if (req.status === "failed") {
        return { phase: "validation_failed", outcome: "failed", failureReason: req.failure_reason ?? "校验失败" };
      }
      if (req.status !== "submitted" && req.status !== "pending_review") return { phase: "validated" };

      const order = repos.orders.get(req.order_id);
      const payment = order ? repos.orders.getPayment(order.id) : undefined;
      let reason: string | null = null;
      if (!order || order.customer_id !== req.customer_id) reason = "订单归属不一致";
      else if (order.payment_status !== "paid") reason = "订单不是已支付状态";
      else if (!payment || payment.status !== "succeeded") reason = "支付记录状态异常";
      else if (req.amount_minor !== order.amount_minor) reason = "申请金额与订单金额不一致";
      else if (repos.refunds.sumSuccessByOrder(order.id) !== 0) reason = "订单已存在成功退款记录";

      if (reason === null) return { phase: "validated" };
      const changes = repos.refunds.transition(req.id, ["submitted", "pending_review"], "failed", nowIso(), {
        failureReason: reason,
      });
      if (changes !== 1) throw new RefundInvariantError("校验失败但状态转换未生效");
      log(req.id, "validate_request", "validate:failed", { reason }, `refund:${req.id}:validate:a${s.attempt}`);
      return { phase: "validation_failed", outcome: "failed", failureReason: reason };
    });
  };

  // ---------------------------------------------------------------- register_review
  const register_review: NodeFn = async (s) => {
    tx(db, () => {
      const changes = repos.refunds.transition(s.requestId, ["submitted"], "pending_review", nowIso());
      void changes; // 条件更新：非 submitted 时为 no-op（幂等）
      log(s.requestId, "register_review", "registered", { attempt: s.attempt }, `refund:${s.requestId}:register:a${s.attempt}`);
    });
    return { phase: "review_registered" };
  };

  // ---------------------------------------------------------------- await_decision
  // interrupt 之前只读：节点在 resume 时会从头重跑。
  const await_decision: NodeFn = async (s) => {
    const req = mustGet(s.requestId);
    const signal: unknown = interrupt({
      type: "refund_review",
      requestId: req.id,
      orderId: req.order_id,
      amountMinor: req.amount_minor,
      attempt: s.attempt,
    });
    // resume 值仅作信号存档，不读取其中任何字段作判断
    return { phase: "decision_signaled", lastSignal: signal };
  };

  // ---------------------------------------------------------------- verify_decision
  const verify_decision: NodeFn = async (s) => {
    return tx(db, (): RefundFlowUpdate => {
      const req = mustGet(s.requestId);
      if (req.status === "refunded") return { phase: "already_refunded" };
      if (req.status === "failed") return { phase: "already_failed" };
      if (req.status === "rejected") return { phase: "rejected" };
      const dec = repos.refunds.getDecision(req.id);
      if (!dec) return { phase: "decision_missing" };
      if (dec.decision === "rejected") {
        repos.refunds.transition(req.id, ["submitted", "pending_review"], "rejected", nowIso());
        return { phase: "rejected", decisionId: dec.id };
      }
      // 决定 = approved；状态此时只可能是 approved/executing/submitted/pending_review
      repos.refunds.transition(req.id, ["submitted", "pending_review"], "approved", nowIso());
      return { phase: "approved", decisionId: dec.id };
    });
  };

  // ---------------------------------------------------------------- execute_refund
  const execute_refund: NodeFn = async (s) => {
    const { requestId, attempt } = s;

    const executedFromDb = (): RefundFlowUpdate => {
      const ok = repos.refunds.getSuccessExecution(requestId);
      return { phase: "executed", outcome: "refunded", executionId: ok?.id };
    };

    // ---- 认领事务 tx-A
    const early = tx(db, (): RefundFlowUpdate | null => {
      const req = mustGet(requestId);
      const dec = repos.refunds.getDecision(requestId);
      if (!dec || dec.decision !== "approved") throw new RefundInvariantError("缺少批准决定，拒绝执行退款");
      if (req.status === "refunded") return executedFromDb();
      if (req.status === "failed") {
        const e = repos.refunds.getExecution(requestId, attempt);
        return { phase: "execution_failed", outcome: "failed", failureReason: req.failure_reason ?? undefined, executionId: e?.id };
      }
      if (req.attempt !== attempt) throw new RefundInvariantError("attempt 不匹配");
      if (req.status === "approved") {
        const now = nowIso();
        const info = db
          .prepare("UPDATE refund_requests SET status = 'executing', updated_at = ? WHERE id = ? AND status = 'approved' AND attempt = ?")
          .run(now, requestId, attempt);
        if (info.changes !== 1) throw new RefundInvariantError("认领退款执行失败（状态已变化）");
      } else if (req.status !== "executing") {
        throw new RefundInvariantError(`状态 ${req.status} 不允许执行退款`);
      }
      log(requestId, "execute_refund", "claimed", { attempt }, `refund:${requestId}:claim:a${attempt}`);
      return null;
    });
    if (early) return early;

    crash.trip("mid:execute_refund");

    // ---- 主事务 tx-B（重读权威记录）
    return tx(db, (): RefundFlowUpdate => {
      const req = mustGet(requestId);
      if (req.status === "refunded") return executedFromDb();
      if (req.status === "failed") {
        const e = repos.refunds.getExecution(requestId, attempt);
        return { phase: "execution_failed", outcome: "failed", failureReason: req.failure_reason ?? undefined, executionId: e?.id };
      }
      if (req.status !== "executing" || req.attempt !== attempt) {
        throw new RefundInvariantError(`状态 ${req.status}（attempt ${req.attempt}）不允许完成退款执行`);
      }
      const dec = repos.refunds.getDecision(requestId);
      if (!dec || dec.decision !== "approved") throw new RefundInvariantError("缺少批准决定，拒绝执行退款");

      const now = nowIso();
      const success = repos.refunds.getSuccessExecution(requestId);
      if (success) {
        const changes = repos.refunds.transition(requestId, ["executing"], "refunded", now, { failureReason: null });
        if (changes !== 1) throw new RefundInvariantError("状态转换 executing→refunded 未生效");
        return { phase: "executed", outcome: "refunded", executionId: success.id };
      }
      const prior = repos.refunds.getExecution(requestId, attempt);
      if (prior && prior.status === "failed") {
        repos.refunds.transition(requestId, ["executing"], "failed", now, { failureReason: prior.failure_reason });
        return {
          phase: "execution_failed",
          outcome: "failed",
          failureReason: prior.failure_reason ?? undefined,
          executionId: prior.id,
        };
      }

      const order = repos.orders.get(req.order_id);
      if (!order) throw new RefundInvariantError(`订单不存在：${req.order_id}`);
      const payment = repos.orders.getPayment(req.order_id);
      let reason: string | null = null;
      if (order.customer_id !== req.customer_id) reason = "订单归属不一致";
      else if (order.payment_status !== "paid") reason = "订单不是已支付状态";
      else if (!payment || payment.status !== "succeeded") reason = "支付记录状态异常";
      else if (order.amount_minor !== req.amount_minor) reason = "申请金额与订单金额不一致";
      else if (repos.refunds.sumSuccessByOrder(order.id) !== 0) reason = "订单已存在成功退款记录";
      else {
        const injected = faults?.refundFailure?.(requestId, attempt) ?? null;
        if (injected) reason = injected;
        else if (repos.orders.consumeSimulatedFailure(order.id) === 1) reason = "模拟支付渠道退款失败（演示用，可重试）";
      }

      const execId = randomId("RE");
      if (reason) {
        repos.refunds.insertExecution({
          id: execId,
          refund_request_id: requestId,
          order_id: order.id,
          attempt,
          status: "failed",
          amount_minor: req.amount_minor,
          failure_reason: reason,
          executed_at: now,
        });
        const changes = repos.refunds.transition(requestId, ["executing"], "failed", now, { failureReason: reason });
        if (changes !== 1) throw new RefundInvariantError("状态转换 executing→failed 未生效");
        log(requestId, "execute_refund", "execution_failed", { reason, executionId: execId }, `refund:${requestId}:exec:a${attempt}`);
        return { phase: "execution_failed", outcome: "failed", failureReason: reason, executionId: execId };
      }

      // UNIQUE 冲突即并发重复执行 → 抛错，整个事务回滚
      repos.refunds.insertExecution({
        id: execId,
        refund_request_id: requestId,
        order_id: order.id,
        attempt,
        status: "success",
        amount_minor: req.amount_minor,
        failure_reason: null,
        executed_at: now,
      });
      if (repos.orders.markRefunded(order.id, now) !== 1) throw new RefundInvariantError("订单状态更新失败（非已支付）");
      // 支付记录必须恰好有一条 succeeded → refunded，否则抛错回滚整个事务（不产生部分写）
      if (repos.orders.markPaymentRefunded(order.id) !== 1) throw new RefundInvariantError("支付记录状态更新失败（非成功支付）");
      if (repos.refunds.transition(requestId, ["executing"], "refunded", now, { failureReason: null }) !== 1) {
        throw new RefundInvariantError("状态转换 executing→refunded 未生效");
      }
      log(requestId, "execute_refund", "executed", { executionId: execId, amountMinor: req.amount_minor }, `refund:${requestId}:exec:a${attempt}`);
      return { phase: "executed", outcome: "refunded", executionId: execId };
    });
  };

  // ---------------------------------------------------------------- record_rejection
  const record_rejection: NodeFn = async (s) => {
    return tx(db, (): RefundFlowUpdate => {
      const dec = repos.refunds.getDecision(s.requestId);
      repos.refunds.transition(s.requestId, ["submitted", "pending_review"], "rejected", nowIso()); // 通常 no-op
      log(s.requestId, "record_rejection", "rejected", { decisionId: dec?.id ?? null }, `refund:${s.requestId}:rejection`);
      return { phase: "rejection_recorded", outcome: "rejected", decisionId: dec?.id };
    });
  };

  // ---------------------------------------------------------------- record_result
  const record_result: NodeFn = async (s) => {
    const req = mustGet(s.requestId);
    const exec = repos.refunds.getSuccessExecution(s.requestId) ?? repos.refunds.getExecution(s.requestId, s.attempt);
    log(
      s.requestId,
      "record_result",
      "result_recorded",
      { status: req.status, executionId: exec?.id ?? s.executionId ?? null, failureReason: req.failure_reason },
      `refund:${s.requestId}:result:a${s.attempt}`,
    );
    return { phase: "result_recorded" };
  };

  // ---------------------------------------------------------------- enqueue_notification
  const enqueue_notification: NodeFn = async (s) => {
    tx(db, () => {
      const req = mustGet(s.requestId);
      const at = nowIso();
      let base;
      let status: "refunded" | "rejected" | "failed";
      if (req.status === "refunded") {
        status = "refunded";
        base = { template: "refund_refunded" as const };
      } else if (req.status === "rejected") {
        status = "rejected";
        base = { template: "refund_rejected" as const, comment: repos.refunds.getDecision(req.id)?.comment ?? "" };
      } else if (req.status === "failed") {
        status = "failed";
        base = { template: "refund_failed" as const, failureReason: req.failure_reason ?? undefined };
      } else {
        throw new RefundInvariantError(`状态 ${req.status} 不是终态，不能入队通知`);
      }
      const payload = { ...base, requestId: req.id, orderId: req.order_id, amountMinor: req.amount_minor };
      repos.outbox.enqueue({
        dedupeKey: refundDedupeKey(req.id, status, s.attempt),
        conversationId: req.conversation_id,
        payload: { ...payload, text: renderNotification(payload) },
        at,
      });
      repos.refunds.markFlowCompleted(req.id, at);
      log(req.id, "enqueue_notification", "notified", { status }, `refund:${req.id}:notify:a${s.attempt}`);
    });
    return { phase: "notified" };
  };

  return {
    validate_request: instrument("validate_request", validate_request),
    register_review: instrument("register_review", register_review),
    await_decision: instrument("await_decision", await_decision),
    verify_decision: instrument("verify_decision", verify_decision),
    execute_refund: instrument("execute_refund", execute_refund),
    record_rejection: instrument("record_rejection", record_rejection),
    record_result: instrument("record_result", record_result),
    enqueue_notification: instrument("enqueue_notification", enqueue_notification),
  };
}

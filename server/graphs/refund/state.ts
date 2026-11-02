// 退款 Graph 状态（SPEC §H.1）。
// 禁止在状态中存放 approved:boolean 或任何用作执行依据的审批结论；执行节点只读 refund_decisions。
import { StateSchema } from "@langchain/langgraph";
import { z } from "zod";

export { REFUND_NODES, type RefundNodeName } from "./node-names";

export const PHASES = [
  "init",
  "validated",
  "validation_failed",
  "review_registered",
  "decision_signaled",
  "decision_missing",
  "approved",
  "rejected",
  "already_refunded",
  "already_failed",
  "executed",
  "execution_failed",
  "rejection_recorded",
  "result_recorded",
  "notified",
] as const;

export const RefundFlowState = new StateSchema({
  requestId: z.string(),
  attempt: z.number().int().min(1),
  mode: z.enum(["initial", "retry", "recover"]).default("initial"),
  phase: z.enum(PHASES).default("init"),
  decisionId: z.string().optional(), // 仅审计/展示，不作执行依据
  executionId: z.string().optional(),
  outcome: z.enum(["none", "refunded", "rejected", "failed"]).default("none"),
  failureReason: z.string().optional(),
  lastSignal: z.unknown().optional(), // interrupt 返回的 resume 值，仅审计
});

export type RefundFlowValue = typeof RefundFlowState.State;
export type RefundFlowUpdate = typeof RefundFlowState.Update;

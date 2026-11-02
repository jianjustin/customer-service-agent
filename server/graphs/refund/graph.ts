// 退款 Graph 的边与条件路由（SPEC §H.5）。
import { END, START, StateGraph } from "@langchain/langgraph";
import type { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createRefundNodes, type RefundNodeDeps } from "./nodes";
import { RefundFlowState, type RefundFlowValue } from "./state";

function buildGraph(deps: RefundNodeDeps) {
  const n = createRefundNodes(deps);
  return new StateGraph(RefundFlowState)
    .addNode("validate_request", n.validate_request)
    .addNode("register_review", n.register_review)
    .addNode("await_decision", n.await_decision)
    .addNode("verify_decision", n.verify_decision)
    .addNode("execute_refund", n.execute_refund)
    .addNode("record_rejection", n.record_rejection)
    .addNode("record_result", n.record_result)
    .addNode("enqueue_notification", n.enqueue_notification)
    // 重试（attempt>1 的新 thread）与恢复重入：直接校验决定，跳过校验登记与等待
    .addConditionalEdges(
      START,
      (s: RefundFlowValue) => (s.mode === "initial" ? "validate_request" : "verify_decision"),
      ["validate_request", "verify_decision"],
    )
    .addConditionalEdges(
      "validate_request",
      (s: RefundFlowValue) => (s.phase === "validation_failed" ? "enqueue_notification" : "register_review"),
      ["enqueue_notification", "register_review"],
    )
    .addEdge("register_review", "await_decision")
    .addEdge("await_decision", "verify_decision")
    .addConditionalEdges(
      "verify_decision",
      (s: RefundFlowValue) => {
        switch (s.phase) {
          case "approved":
            return "execute_refund";
          case "rejected":
            return "record_rejection";
          case "already_refunded":
            return "record_result";
          case "already_failed":
            return "enqueue_notification";
          default:
            return "await_decision"; // decision_missing（含任何意外 phase）：回到等待
        }
      },
      ["await_decision", "execute_refund", "record_rejection", "record_result", "enqueue_notification"],
    )
    .addEdge("execute_refund", "record_result")
    .addEdge("record_rejection", "enqueue_notification")
    .addEdge("record_result", "enqueue_notification")
    .addEdge("enqueue_notification", END);
}

export function buildRefundGraph(deps: RefundNodeDeps, checkpointer: SqliteSaver) {
  return buildGraph(deps).compile({ checkpointer });
}

export type CompiledRefundGraph = ReturnType<typeof buildRefundGraph>;

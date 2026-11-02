// 退款 Graph 节点名。单独成文件，使 crash.ts 不依赖 LangGraph（批次 3 的 state.ts 应从此处 re-export）。
export const REFUND_NODES = [
  "validate_request",
  "register_review",
  "await_decision",
  "verify_decision",
  "execute_refund",
  "record_rejection",
  "record_result",
  "enqueue_notification",
] as const;
export type RefundNodeName = (typeof REFUND_NODES)[number];

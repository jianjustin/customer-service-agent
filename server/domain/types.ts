// 共享领域类型（行类型字段名与列名一致，snake_case）。见 docs/SPEC.md §A.1。

export type Role = "customer" | "agent" | "reviewer";
export type TicketStatus = "queued" | "assigned" | "closed";
export type HandlingMode = "ai" | "human";
export type SenderType = "customer" | "ai" | "agent" | "system";
export type AiRunStatus = "queued" | "running" | "completed" | "suppressed" | "cancelled" | "failed";
export type RefundStatus =
  | "submitted"
  | "pending_review"
  | "approved"
  | "rejected"
  | "executing"
  | "refunded"
  | "failed";
export type PaymentStatus = "unpaid" | "paid" | "refunded";
export type ShippingStatus = "none" | "pending" | "shipped" | "delivered";
export type PaymentRecordStatus = "pending" | "succeeded" | "failed" | "refunded";
export type OutboxStatus = "pending" | "sent" | "failed";
export type ChannelName = "web" | "wechat" | "feishu";
export type LogScope = "conversation" | "refund" | "outbox" | "mcp" | "assignment";

export interface Actor {
  role: Role;
  id: string;
  name: string;
}

export interface CustomerRow {
  id: string;
  name: string;
}
export interface SeatRow {
  id: string;
  name: string;
  online: 0 | 1;
  capacity: number;
  sort_order: number;
}
export interface ReviewerRow {
  id: string;
  name: string;
}
export interface OrderRow {
  id: string;
  customer_id: string;
  title: string;
  amount_minor: number;
  currency: string;
  payment_status: PaymentStatus;
  shipping_status: ShippingStatus;
  tracking_no: string | null;
  paid_at: string | null;
  refunded_at: string | null;
  refund_note: string | null;
  simulate_refund_failure: number;
  created_at: string;
}
export interface PaymentRow {
  id: string;
  order_id: string;
  channel: "wechat" | "alipay" | "card";
  status: PaymentRecordStatus;
  amount_minor: number;
  paid_at: string | null;
  failure_reason: string | null;
  created_at: string;
}
export interface TicketRow {
  id: string;
  customer_id: string;
  seat_id: string | null;
  status: TicketStatus;
  subject: string;
  ai_summary: string | null;
  handover_requested: 0 | 1;
  handover_reason: string | null;
  created_at: string;
  assigned_at: string | null;
  closed_at: string | null;
  updated_at: string;
}
export interface ConversationRow {
  id: string;
  ticket_id: string;
  customer_id: string;
  channel: ChannelName;
  channel_session_id: string;
  thread_id: string;
  handling_mode: HandlingMode;
  ai_generation: number;
  created_at: string;
  updated_at: string;
}
export interface MessageRow {
  id: number;
  conversation_id: string;
  seq: number;
  sender_type: SenderType;
  sender_id: string | null;
  content: string;
  sources_json: string;
  ai_run_id: number | null;
  client_message_id: string | null;
  created_at: string;
}
export interface AiRunRow {
  id: number;
  conversation_id: string;
  trigger_message_id: number;
  generation: number;
  status: AiRunStatus;
  handover_requested: 0 | 1;
  error: string | null;
  reply_message_id: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}
export interface RefundRequestRow {
  id: string;
  customer_id: string;
  ticket_id: string;
  conversation_id: string;
  order_id: string;
  amount_minor: number;
  currency: string;
  reason: string;
  evidence_json: string;
  version: number;
  status: RefundStatus;
  idempotency_key: string;
  thread_id: string;
  attempt: number;
  failure_reason: string | null;
  flow_completed_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface RefundDecisionRow {
  id: string;
  refund_request_id: string;
  reviewer_id: string;
  decision: "approved" | "rejected";
  comment: string;
  decided_at: string;
}
export interface RefundExecutionRow {
  id: string;
  refund_request_id: string;
  order_id: string;
  attempt: number;
  status: "success" | "failed";
  amount_minor: number;
  failure_reason: string | null;
  executed_at: string;
}
export interface OutboxRow {
  id: number;
  kind: "customer_notification";
  dedupe_key: string;
  conversation_id: string;
  payload_json: string;
  status: OutboxStatus;
  attempts: number;
  next_attempt_at: string;
  created_at: string;
  sent_at: string | null;
  last_error: string | null;
}
export interface ExecutionLogRow {
  id: number;
  scope: LogScope;
  ref_id: string;
  node: string;
  event: string;
  detail_json: string;
  dedupe_key: string | null;
  created_at: string;
}
export interface KnowledgeEntry {
  id: string;
  title: string;
  version: number;
  category: string;
  content: string;
  keywords: string[];
}
export interface MessageSource {
  id: string;
  title: string;
  version: number;
}

/** 通知载荷（outbox.payload_json）。类型定义放在此处以便 repos 与 services 共用；services/outbox.ts 批次 2 再导出。 */
export type NotificationTemplate = "refund_submitted" | "refund_refunded" | "refund_rejected" | "refund_failed";
export interface NotificationPayload {
  template: NotificationTemplate;
  requestId: string;
  orderId: string;
  amountMinor: number;
  comment?: string;
  failureReason?: string;
  text: string;
}

export const REFUND_STATUS_TEXT: Record<RefundStatus, string> = {
  submitted: "已提交",
  pending_review: "待审核",
  approved: "审核通过，待执行",
  executing: "退款执行中",
  refunded: "已退款（模拟）",
  rejected: "已拒绝",
  failed: "退款失败",
};

export const PAYMENT_STATUS_TEXT: Record<PaymentStatus, string> = {
  unpaid: "未支付",
  paid: "已支付",
  refunded: "已退款（模拟）",
};

export const SHIPPING_STATUS_TEXT: Record<ShippingStatus, string> = {
  none: "无需发货",
  pending: "待发货",
  shipped: "已发货",
  delivered: "已签收",
};

export const TICKET_STATUS_TEXT: Record<TicketStatus, string> = {
  queued: "排队中",
  assigned: "已分配",
  closed: "已结束",
};

/** 支付记录（payments.status）文案；SPEC 未给出，批次 1 自拟 */
export const PAYMENT_RECORD_STATUS_TEXT: Record<PaymentRecordStatus, string> = {
  pending: "待支付",
  succeeded: "支付成功",
  failed: "支付失败",
  refunded: "已退款（模拟）",
};

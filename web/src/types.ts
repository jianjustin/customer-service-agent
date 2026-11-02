// 前端类型：手写自 docs/SPEC.md §A.1/§A.2/§D（不 import server 代码）

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
export type ChannelName = "web" | "wechat" | "feishu";

export interface MessageSource {
  id: string;
  title: string;
  version: number;
}

export interface TicketDTO {
  id: string;
  customerId: string;
  customerName: string;
  seatId: string | null;
  seatName: string | null;
  status: TicketStatus;
  statusText: string;
  subject: string;
  handoverRequested: boolean;
  handoverReason: string | null;
  createdAt: string;
  closedAt: string | null;
  conversation: { id: string; channel: ChannelName; handlingMode: HandlingMode; aiGeneration: number };
}
export interface AgentTicketDTO extends TicketDTO {
  aiSummary: string | null;
  threadId: string;
}
export interface MessageDTO {
  id: number;
  seq: number;
  senderType: SenderType;
  senderLabel: string;
  content: string;
  sources: MessageSource[];
  createdAt: string;
}
export interface OrderDTO {
  id: string;
  title: string;
  amountMinor: number;
  currency: string;
  paymentStatus: PaymentStatus;
  paymentStatusText: string;
  shippingStatus: ShippingStatus;
  shippingStatusText: string;
  trackingNo: string | null;
  paidAt: string | null;
  refundedAt: string | null;
  refundNote: string | null;
  payment: {
    id: string;
    channel: string;
    status: PaymentRecordStatus;
    amountMinor: number;
    failureReason: string | null;
  } | null;
}
export interface RefundDTO {
  id: string;
  orderId: string;
  ticketId: string;
  amountMinor: number;
  currency: string;
  reason: string;
  status: RefundStatus;
  statusText: string;
  version: number;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  decision: { decision: "approved" | "rejected"; comment: string; decidedAt: string } | null;
  failureReason: string | null;
}
export interface RefundDecisionDTO {
  id: string;
  reviewerId: string;
  reviewerName: string;
  decision: "approved" | "rejected";
  comment: string;
  decidedAt: string;
}

// ---------- §D 响应 ----------

export interface BootstrapModel {
  mode: string;
  label: string;
  modelName: string | null;
  reason: string;
}
export interface BootstrapResp {
  customers: { id: string; name: string }[];
  seats: { id: string; name: string; online: boolean; capacity: number }[];
  reviewers: { id: string; name: string }[];
  model: BootstrapModel;
}

export interface SendMessageResp {
  duplicate: boolean;
  ticket: TicketDTO;
  message: MessageDTO;
  aiRunId: number | null;
}
export interface SendMessageBody {
  content: string;
  clientMessageId: string;
  ticketId?: string;
  newTicket?: boolean;
}
export interface CustomerTicketsResp {
  tickets: TicketDTO[];
}
export interface CustomerMessagesResp {
  ticket: TicketDTO;
  messages: MessageDTO[];
  aiPending: boolean;
}
export interface OrdersResp {
  orders: OrderDTO[];
}
export interface RefundsResp {
  refunds: RefundDTO[];
}
export interface TicketResp {
  ticket: TicketDTO;
}

export interface SeatInfo {
  id: string;
  name: string;
  online: boolean;
  capacity: number;
  activeCount: number;
}
export interface AgentMeResp {
  seat: SeatInfo;
}
export interface AgentStatusResp {
  seat: SeatInfo;
  dequeued: string[];
}
export interface AgentTicketsResp {
  tickets: AgentTicketDTO[];
}
export interface AiRunDTO {
  id: number;
  status: AiRunStatus;
  generation: number;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
}
export interface AgentTicketDetailResp {
  ticket: AgentTicketDTO;
  messages: MessageDTO[];
  orders: OrderDTO[];
  refunds: RefundDTO[];
  aiRuns: AiRunDTO[];
}
export interface AgentTicketResp {
  ticket: AgentTicketDTO;
}
export interface AgentReplyResp {
  message: MessageDTO;
  duplicate: boolean;
}
export interface AgentSeatsResp {
  seats: SeatInfo[];
  queue: { count: number; ticketIds: string[] };
}

export type ReviewerRefundItem = RefundDTO & { customerName: string; orderTitle: string };
export interface ReviewerRefundsResp {
  refunds: ReviewerRefundItem[];
}
export interface RefundDetailResp {
  refund: RefundDTO;
  customer: { id: string; name: string };
  order: OrderDTO;
  evidence: {
    orderSnapshot: Record<string, unknown> | null;
    paymentSnapshot: Record<string, unknown> | null;
    conversationExcerpt: { senderType: SenderType; content: string; createdAt: string }[];
  };
  decision: RefundDecisionDTO | null;
  executions: {
    id: string;
    attempt: number;
    status: "success" | "failed";
    amountMinor: number;
    failureReason: string | null;
    executedAt: string;
  }[];
  logs: { node: string; event: string; detail: unknown; createdAt: string }[];
  notifications: {
    dedupeKey: string;
    status: "pending" | "sent" | "failed";
    attempts: number;
    lastError: string | null;
    sentAt: string | null;
  }[];
  graph: { threadId: string; hasCheckpoint: boolean; next: string[]; waitingForReview: boolean };
}
export interface FlowReport {
  ok: boolean;
  outcome?: unknown;
  error: string | null;
}
export interface DecideResp {
  refund: RefundDTO;
  decision: RefundDecisionDTO;
  idempotent: boolean;
  flow: FlowReport;
}
export interface RetryResp {
  refund: RefundDTO;
  flow: FlowReport;
}

// 行 → API DTO。见 docs/SPEC.md §A.2。
import type {
  ChannelName,
  ConversationRow,
  CustomerRow,
  HandlingMode,
  MessageRow,
  MessageSource,
  OrderRow,
  PaymentRecordStatus,
  PaymentRow,
  PaymentStatus,
  RefundDecisionRow,
  RefundRequestRow,
  RefundStatus,
  SeatRow,
  SenderType,
  ShippingStatus,
  TicketRow,
  TicketStatus,
} from "./types";
import { PAYMENT_STATUS_TEXT, REFUND_STATUS_TEXT, SHIPPING_STATUS_TEXT, TICKET_STATUS_TEXT } from "./types";

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
/** 仅客服可见 */
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
  /** 面向客户时统一替换为 "退款执行未成功，审核员将跟进处理" */
  failureReason: string | null;
}

export const CUSTOMER_FACING_REFUND_FAILURE = "退款执行未成功，审核员将跟进处理";

/**
 * audience="customer" 时 handoverReason 固定为 null：转人工原因可能由 AI 生成（含内部判断措辞），不向客户暴露。
 * 缺省为 "staff"（客服工作台）。
 */
export function toTicketDTO(
  t: TicketRow,
  c: ConversationRow,
  customer: CustomerRow,
  seat: SeatRow | null,
  audience: "customer" | "staff" = "staff",
): TicketDTO {
  return {
    id: t.id,
    customerId: t.customer_id,
    customerName: customer.name,
    seatId: t.seat_id,
    seatName: seat ? seat.name : null,
    status: t.status,
    statusText: TICKET_STATUS_TEXT[t.status],
    subject: t.subject,
    handoverRequested: t.handover_requested === 1,
    handoverReason: audience === "customer" ? null : t.handover_reason,
    createdAt: t.created_at,
    closedAt: t.closed_at,
    conversation: {
      id: c.id,
      channel: c.channel,
      handlingMode: c.handling_mode,
      aiGeneration: c.ai_generation,
    },
  };
}

export function toAgentTicketDTO(
  t: TicketRow,
  c: ConversationRow,
  customer: CustomerRow,
  seat: SeatRow | null,
): AgentTicketDTO {
  return { ...toTicketDTO(t, c, customer, seat), aiSummary: t.ai_summary, threadId: c.thread_id };
}

function parseSources(json: string): MessageSource[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? (v as MessageSource[]) : [];
  } catch {
    return [];
  }
}

export function toMessageDTO(
  m: MessageRow,
  labels: { customerName: string; seatNames: Record<string, string> },
): MessageDTO {
  let senderLabel: string;
  switch (m.sender_type) {
    case "customer":
      senderLabel = labels.customerName;
      break;
    case "ai":
      senderLabel = "AI 助手";
      break;
    case "agent":
      senderLabel = `人工客服 ${(m.sender_id && labels.seatNames[m.sender_id]) || m.sender_id || ""}`.trim();
      break;
    default:
      senderLabel = "系统通知";
  }
  return {
    id: m.id,
    seq: m.seq,
    senderType: m.sender_type,
    senderLabel,
    content: m.content,
    sources: parseSources(m.sources_json),
    createdAt: m.created_at,
  };
}

export function toOrderDTO(o: OrderRow, p: PaymentRow | null): OrderDTO {
  return {
    id: o.id,
    title: o.title,
    amountMinor: o.amount_minor,
    currency: o.currency,
    paymentStatus: o.payment_status,
    paymentStatusText: PAYMENT_STATUS_TEXT[o.payment_status],
    shippingStatus: o.shipping_status,
    shippingStatusText: SHIPPING_STATUS_TEXT[o.shipping_status],
    trackingNo: o.tracking_no,
    paidAt: o.paid_at,
    refundedAt: o.refunded_at,
    refundNote: o.refund_note,
    payment: p
      ? {
          id: p.id,
          channel: p.channel,
          status: p.status,
          amountMinor: p.amount_minor,
          failureReason: p.failure_reason,
        }
      : null,
  };
}

export function toRefundDTO(
  r: RefundRequestRow,
  d: RefundDecisionRow | null,
  audience: "customer" | "staff",
): RefundDTO {
  return {
    id: r.id,
    orderId: r.order_id,
    ticketId: r.ticket_id,
    amountMinor: r.amount_minor,
    currency: r.currency,
    reason: r.reason,
    status: r.status,
    statusText: REFUND_STATUS_TEXT[r.status],
    version: r.version,
    attempt: r.attempt,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    decision: d ? { decision: d.decision, comment: d.comment, decidedAt: d.decided_at } : null,
    failureReason:
      audience === "customer" ? (r.failure_reason ? CUSTOMER_FACING_REFUND_FAILURE : null) : r.failure_reason,
  };
}

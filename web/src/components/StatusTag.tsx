import type { HandlingMode, RefundStatus, TicketStatus } from "../types";

type Props =
  | { kind: "ticket"; value: TicketStatus; text?: string }
  | { kind: "mode"; value: HandlingMode }
  | { kind: "refund"; value: RefundStatus; text?: string };

const TICKET_TEXT: Record<TicketStatus, string> = { queued: "排队中", assigned: "已分配", closed: "已结束" };
const MODE_TEXT: Record<HandlingMode, string> = { ai: "AI 接待中", human: "人工接管中" };
const REFUND_TEXT: Record<RefundStatus, string> = {
  submitted: "已提交",
  pending_review: "待审核",
  approved: "审核通过，待执行",
  executing: "退款执行中",
  refunded: "已退款（模拟）",
  rejected: "已拒绝",
  failed: "退款失败",
};

/** 工单状态 / 接待状态 / 退款状态标签（退款：待审核黄、已退款绿、已拒绝灰、失败红） */
export function StatusTag(props: Props) {
  switch (props.kind) {
    case "ticket":
      return <span className={`tag tag-ticket-${props.value}`}>{props.text ?? TICKET_TEXT[props.value]}</span>;
    case "mode":
      return <span className={`tag tag-mode-${props.value}`}>{MODE_TEXT[props.value]}</span>;
    case "refund":
      return <span className={`tag tag-refund-${props.value}`}>{props.text ?? REFUND_TEXT[props.value]}</span>;
  }
}

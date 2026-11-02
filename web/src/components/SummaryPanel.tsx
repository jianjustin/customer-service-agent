import type { AgentTicketDTO, OrderDTO, RefundDTO } from "../types";
import { OrdersPanel } from "./OrdersPanel";
import { RefundsPanel } from "./RefundsPanel";

/** 客服右栏：AI 排查摘要、客户订单、本工单退款、threadId（仅客服可见） */
export function SummaryPanel({
  ticket,
  orders,
  refunds,
}: {
  ticket: AgentTicketDTO;
  orders: OrderDTO[];
  refunds: RefundDTO[];
}) {
  return (
    <div className="summary-panel">
      <section className="panel">
        <h3>AI 排查摘要</h3>
        {ticket.aiSummary ? <pre className="summary-text">{ticket.aiSummary}</pre> : <div className="empty">暂无摘要</div>}
      </section>
      <OrdersPanel orders={orders} title={`${ticket.customerName}的订单`} />
      <RefundsPanel refunds={refunds} title="本工单退款申请" />
      <div className="thread-id">threadId：{ticket.threadId}</div>
    </div>
  );
}

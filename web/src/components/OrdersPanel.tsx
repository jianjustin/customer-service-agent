import { formatMoney } from "../format";
import type { OrderDTO } from "../types";

export function OrdersPanel({ orders, title = "我的订单" }: { orders: OrderDTO[] | null; title?: string }) {
  return (
    <section className="panel">
      <h3>{title}</h3>
      {orders === null && <div className="empty">加载中…</div>}
      {orders && orders.length === 0 && <div className="empty">暂无订单</div>}
      {orders?.map((o) => (
        <div key={o.id} className="card">
          <div className="card-title">
            <span>{o.title}</span>
            <strong>{formatMoney(o.amountMinor)}</strong>
          </div>
          <dl className="kv">
            <dt>订单号</dt>
            <dd>{o.id}</dd>
            <dt>支付状态</dt>
            <dd>{o.paymentStatusText}</dd>
            <dt>物流状态</dt>
            <dd>{o.shippingStatusText}</dd>
            <dt>运单号</dt>
            <dd>{o.trackingNo ?? "-"}</dd>
          </dl>
        </div>
      ))}
    </section>
  );
}

import { formatDateTime, formatMoney } from "../format";
import type { RefundDTO } from "../types";
import { StatusTag } from "./StatusTag";

export function RefundsPanel({ refunds, title = "我的退款" }: { refunds: RefundDTO[] | null; title?: string }) {
  return (
    <section className="panel">
      <h3>{title}</h3>
      {refunds === null && <div className="empty">加载中…</div>}
      {refunds && refunds.length === 0 && <div className="empty">暂无退款申请</div>}
      {refunds?.map((r) => (
        <div key={r.id} className="card">
          <div className="card-title">
            <span>{r.id}</span>
            <StatusTag kind="refund" value={r.status} text={r.statusText} />
          </div>
          <dl className="kv">
            <dt>订单</dt>
            <dd>{r.orderId}</dd>
            <dt>金额</dt>
            <dd>{formatMoney(r.amountMinor)}</dd>
            <dt>审核意见</dt>
            <dd>{r.decision ? r.decision.comment : "-"}</dd>
            {r.failureReason && (
              <>
                <dt>说明</dt>
                <dd>{r.failureReason}</dd>
              </>
            )}
            <dt>更新时间</dt>
            <dd>{formatDateTime(r.updatedAt)}</dd>
          </dl>
        </div>
      ))}
    </section>
  );
}

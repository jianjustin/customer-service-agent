import { useEffect, useState } from "react";
import { formatDateTime, formatMoney } from "../format";
import type { RefundDetailResp, SenderType } from "../types";
import { StatusTag } from "./StatusTag";

const SENDER_TEXT: Record<SenderType, string> = { customer: "客户", ai: "AI", agent: "客服", system: "系统" };
const KEY_TEXT: Record<string, string> = {
  id: "编号",
  title: "标题",
  amountMinor: "金额",
  amount_minor: "金额",
  currency: "币种",
  paymentStatus: "支付状态",
  payment_status: "支付状态",
  shippingStatus: "物流状态",
  shipping_status: "物流状态",
  trackingNo: "运单号",
  tracking_no: "运单号",
  paidAt: "支付时间",
  paid_at: "支付时间",
  channel: "支付渠道",
  status: "状态",
  failureReason: "失败原因",
  failure_reason: "失败原因",
  orderId: "订单号",
  order_id: "订单号",
};

function snapshotValue(key: string, v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (typeof v === "number" && /amount/i.test(key)) return formatMoney(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function Snapshot({ title, data }: { title: string; data: Record<string, unknown> | null }) {
  return (
    <div className="snapshot">
      <h5>{title}</h5>
      {!data || Object.keys(data).length === 0 ? (
        <div className="empty">无</div>
      ) : (
        <dl className="kv">
          {Object.entries(data).map(([k, v]) => (
            <FragmentKV key={k} k={KEY_TEXT[k] ?? k} v={snapshotValue(k, v)} />
          ))}
        </dl>
      )}
    </div>
  );
}

function FragmentKV({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

function detailText(detail: unknown): string {
  if (detail === null || detail === undefined || detail === "") return "";
  if (typeof detail === "string") return detail;
  return JSON.stringify(detail);
}

export function RefundDetail({
  detail,
  busy,
  onDecide,
  onRetry,
}: {
  detail: RefundDetailResp;
  busy: boolean;
  onDecide: (decision: "approved" | "rejected", comment: string) => Promise<void>;
  onRetry: () => Promise<void>;
}) {
  const { refund, customer, order, evidence, decision, executions, logs, notifications, graph } = detail;
  const [comment, setComment] = useState("");
  useEffect(() => setComment(""), [refund.id]);

  const reviewable = refund.status === "submitted" || refund.status === "pending_review";
  const retryable = refund.status === "failed" && decision?.decision === "approved";
  const payment = order.payment;

  const decide = async (d: "approved" | "rejected") => {
    try {
      await onDecide(d, comment.trim());
      setComment("");
    } catch {
      /* 错误由页面展示，保留意见文本 */
    }
  };

  return (
    <div className="refund-detail">
      <section className="panel">
        <h3>
          申请 {refund.id} <StatusTag kind="refund" value={refund.status} text={refund.statusText} />
        </h3>
        <dl className="kv">
          <dt>客户</dt>
          <dd>{customer.name}</dd>
          <dt>订单</dt>
          <dd>
            {order.id} {order.title}
          </dd>
          <dt>退款金额</dt>
          <dd>{formatMoney(refund.amountMinor)}</dd>
          <dt>退款理由</dt>
          <dd>{refund.reason}</dd>
          <dt>版本 / 尝试</dt>
          <dd>
            v{refund.version} / 第 {refund.attempt} 次
          </dd>
          <dt>创建时间</dt>
          <dd>{formatDateTime(refund.createdAt)}</dd>
          <dt>更新时间</dt>
          <dd>{formatDateTime(refund.updatedAt)}</dd>
          {refund.failureReason && (
            <>
              <dt>失败原因</dt>
              <dd className="text-danger">{refund.failureReason}</dd>
            </>
          )}
          {decision && (
            <>
              <dt>审核决定</dt>
              <dd>
                {decision.decision === "approved" ? "批准" : "拒绝"}（{decision.reviewerName}，
                {formatDateTime(decision.decidedAt)}）：{decision.comment}
              </dd>
            </>
          )}
        </dl>
      </section>

      {reviewable && (
        <section className="panel review-form">
          <h3>审核</h3>
          <textarea
            rows={3}
            maxLength={500}
            placeholder="审核意见（必填，1–500 字）"
            value={comment}
            disabled={busy}
            onChange={(e) => setComment(e.target.value)}
          />
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !comment.trim()}
              onClick={() => void decide("approved")}
            >
              批准
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy || !comment.trim()}
              onClick={() => void decide("rejected")}
            >
              拒绝
            </button>
          </div>
        </section>
      )}

      {retryable && (
        <section className="panel">
          <h3>执行失败</h3>
          <p className="muted">审核已通过，但退款执行失败，可由审核员重试。</p>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void onRetry().catch(() => {})}>
            重试执行
          </button>
        </section>
      )}

      <section className="panel">
        <h3>订单与支付快照</h3>
        <div className="snapshot-grid">
          <Snapshot title="订单快照（申请时）" data={evidence.orderSnapshot} />
          <Snapshot title="支付快照（申请时）" data={evidence.paymentSnapshot} />
        </div>
        <div className="muted small">
          当前订单：{order.paymentStatusText} / {order.shippingStatusText}
          {payment ? `；支付记录 ${payment.id}（${payment.channel}，${payment.status}）` : ""}
        </div>
      </section>

      <section className="panel">
        <h3>证据：对话摘录</h3>
        {evidence.conversationExcerpt.length === 0 && <div className="empty">无</div>}
        <ul className="excerpt">
          {evidence.conversationExcerpt.map((m, i) => (
            <li key={i}>
              <span className="muted">
                {formatDateTime(m.createdAt)} · {SENDER_TEXT[m.senderType] ?? m.senderType}
              </span>
              <div>{m.content}</div>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h3>执行记录</h3>
        {executions.length === 0 ? (
          <div className="empty">暂无执行记录</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>编号</th>
                <th>尝试</th>
                <th>结果</th>
                <th>金额</th>
                <th>失败原因</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {executions.map((x) => (
                <tr key={x.id}>
                  <td>{x.id}</td>
                  <td>{x.attempt}</td>
                  <td className={x.status === "success" ? "text-ok" : "text-danger"}>
                    {x.status === "success" ? "成功" : "失败"}
                  </td>
                  <td>{formatMoney(x.amountMinor)}</td>
                  <td>{x.failureReason ?? "-"}</td>
                  <td>{formatDateTime(x.executedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h3>通知（outbox）</h3>
        {notifications.length === 0 ? (
          <div className="empty">暂无通知</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>去重键</th>
                <th>状态</th>
                <th>次数</th>
                <th>最近错误</th>
                <th>发送时间</th>
              </tr>
            </thead>
            <tbody>
              {notifications.map((n) => (
                <tr key={n.dedupeKey}>
                  <td className="break">{n.dedupeKey}</td>
                  <td>{n.status === "sent" ? "已发送" : n.status === "failed" ? "失败" : "待发送"}</td>
                  <td>{n.attempts}</td>
                  <td>{n.lastError ?? "-"}</td>
                  <td>{formatDateTime(n.sentAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h3>流程日志</h3>
        {logs.length === 0 && <div className="empty">暂无日志</div>}
        <ol className="timeline">
          {logs.map((l, i) => (
            <li key={i}>
              <div>
                <strong>{l.node}</strong> · {l.event}
                <span className="muted"> {formatDateTime(l.createdAt)}</span>
              </div>
              {detailText(l.detail) && <div className="muted small break">{detailText(l.detail)}</div>}
            </li>
          ))}
        </ol>
      </section>

      <section className="panel">
        <h3>Graph 状态</h3>
        <dl className="kv">
          <dt>threadId</dt>
          <dd className="break">{graph.threadId}</dd>
          <dt>checkpoint</dt>
          <dd>{graph.hasCheckpoint ? "有" : "无"}</dd>
          <dt>next</dt>
          <dd>{graph.next.length ? graph.next.join(", ") : "-"}</dd>
          <dt>等待审核</dt>
          <dd>{graph.waitingForReview ? "是" : "否"}</dd>
        </dl>
      </section>
    </div>
  );
}

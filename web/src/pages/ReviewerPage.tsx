import { useState } from "react";
import { api, type Identity } from "../api";
import { ErrorBar, useErrorBar } from "../components/ErrorBar";
import { IdentityPicker } from "../components/IdentityPicker";
import { RefundDetail } from "../components/RefundDetail";
import { StatusTag } from "../components/StatusTag";
import { formatMoney } from "../format";
import { usePolling } from "../hooks/usePolling";
import type { DecideResp, FlowReport, RefundDetailResp, RetryResp, ReviewerRefundsResp } from "../types";

const IDENTITY: Identity = { role: "reviewer", id: "reviewer_1" };

const FILTERS: { value: string; label: string }[] = [
  { value: "", label: "全部" },
  { value: "pending_review", label: "待审核" },
  { value: "refunded", label: "已退款" },
  { value: "rejected", label: "已拒绝" },
  { value: "failed", label: "失败" },
];

export function ReviewerPage({ reviewers }: { reviewers: { id: string; name: string }[] | null }) {
  const identity = IDENTITY;
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const list = usePolling(
    () =>
      api<ReviewerRefundsResp>(
        identity,
        "GET",
        `/reviewer/refunds${filter ? `?status=${filter}` : ""}`,
      ),
    [filter],
  );
  const detail = usePolling(
    async () => {
      if (!selectedId) return null;
      return api<RefundDetailResp>(identity, "GET", `/reviewer/refunds/${encodeURIComponent(selectedId)}`);
    },
    [selectedId],
  );
  const errors = useErrorBar([list.error, detail.error]);

  const refreshAll = () => {
    list.refresh();
    detail.refresh();
  };

  const reportFlow = (flow: FlowReport, prefix: string) => {
    if (!flow.ok) {
      errors.report(`${prefix}流程恢复失败：${flow.error ?? "未知错误"}，系统重启后将自动恢复`);
    }
  };

  const decide = async (decision: "approved" | "rejected", comment: string) => {
    if (!selectedId) return;
    setBusy(true);
    try {
      const r = await api<DecideResp>(identity, "POST", `/reviewer/refunds/${encodeURIComponent(selectedId)}/decide`, {
        decision,
        comment,
      });
      errors.clear();
      if (!r.flow.ok) errors.report(`决定已保存，流程恢复失败：${r.flow.error ?? "未知错误"}，系统重启后将自动恢复`);
      refreshAll();
    } catch (e) {
      errors.report(e); // 409 时即服务端 message
      throw e;
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (!selectedId) return;
    setBusy(true);
    try {
      const r = await api<RetryResp>(identity, "POST", `/reviewer/refunds/${encodeURIComponent(selectedId)}/retry`, {});
      errors.clear();
      reportFlow(r.flow, "重试已受理，但");
      refreshAll();
    } catch (e) {
      errors.report(e);
      throw e;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <ErrorBar message={errors.message} onClose={errors.dismiss} />
      <div className="toolbar">
        <IdentityPicker
          label="当前审核员"
          value={IDENTITY.id}
          options={reviewers ?? [{ id: "reviewer_1", name: "退款审核员" }]}
          onChange={() => {}}
          disabled
        />
      </div>
      <div className="layout layout-2">
        <aside className="col col-left">
          <div className="col-head">
            <h3>退款申请</h3>
          </div>
          <div className="filter filter-wrap">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                className={`chip${filter === f.value ? " active" : ""}`}
                onClick={() => setFilter(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
          {list.data && list.data.refunds.length === 0 && <div className="empty">暂无退款申请</div>}
          {!list.data && <div className="empty">加载中…</div>}
          <ul className="ticket-list">
            {list.data?.refunds.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className={`ticket-item${r.id === selectedId ? " selected" : ""}`}
                  onClick={() => setSelectedId(r.id)}
                >
                  <div className="ticket-item-top">
                    <span className="ticket-subject">
                      <strong>{r.id}</strong>
                    </span>
                    <strong>{formatMoney(r.amountMinor)}</strong>
                  </div>
                  <div className="ticket-item-meta">
                    {r.customerName} · {r.orderId} {r.orderTitle}
                  </div>
                  <div className="ticket-item-tags">
                    <StatusTag kind="refund" value={r.status} text={r.statusText} />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="col col-wide">
          {detail.data ? (
            <RefundDetail key={detail.data.refund.id} detail={detail.data} busy={busy} onDecide={decide} onRetry={retry} />
          ) : (
            <div className="empty center">{selectedId ? "加载中…" : "请从左侧选择一个退款申请"}</div>
          )}
        </section>
      </div>
    </div>
  );
}

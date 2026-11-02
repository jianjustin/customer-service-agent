import { useMemo, useState } from "react";
import { api, type Identity } from "../api";
import { Composer } from "../components/Composer";
import { ErrorBar, useErrorBar } from "../components/ErrorBar";
import { IdentityPicker } from "../components/IdentityPicker";
import { MessageList } from "../components/MessageList";
import { StatusTag } from "../components/StatusTag";
import { SummaryPanel } from "../components/SummaryPanel";
import { TicketList } from "../components/TicketList";
import { useIdentity } from "../hooks/useIdentity";
import { usePolling } from "../hooks/usePolling";
import type {
  AgentMeResp,
  AgentReplyResp,
  AgentSeatsResp,
  AgentStatusResp,
  AgentTicketDetailResp,
  AgentTicketResp,
  AgentTicketsResp,
} from "../types";

type Filter = "assigned" | "closed" | "all";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "assigned", label: "进行中" },
  { value: "closed", label: "已结束" },
  { value: "all", label: "全部" },
];

const FALLBACK_SEATS = [
  { id: "seat_A", name: "A" },
  { id: "seat_B", name: "B" },
  { id: "seat_C", name: "C" },
];

export function AgentPage({ seats: bootSeats }: { seats: { id: string; name: string }[] | null }) {
  const [seatId, setSeatId] = useIdentity("agent", "seat_A");
  const identity = useMemo<Identity>(() => ({ role: "agent", id: seatId }), [seatId]);
  const [filter, setFilter] = useState<Filter>("assigned");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [targetSeat, setTargetSeat] = useState("");
  const [busy, setBusy] = useState(false);

  const me = usePolling(() => api<AgentMeResp>(identity, "GET", "/agent/me"), [identity]);
  const seats = usePolling(() => api<AgentSeatsResp>(identity, "GET", "/agent/seats"), [identity]);
  const tickets = usePolling(
    () => api<AgentTicketsResp>(identity, "GET", `/agent/tickets?status=${filter}`),
    [identity, filter],
  );
  const detail = usePolling(
    async () => {
      if (!selectedId) return null;
      return api<AgentTicketDetailResp>(identity, "GET", `/agent/tickets/${encodeURIComponent(selectedId)}`);
    },
    [identity, selectedId],
  );

  const errors = useErrorBar([me.error, seats.error, tickets.error, detail.error]);

  const refreshAll = () => {
    me.refresh();
    seats.refresh();
    tickets.refresh();
    detail.refresh();
  };

  /** 执行写操作：成功后立即刷新；失败展示错误 */
  const act = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      errors.clear();
      refreshAll();
      return r;
    } catch (e) {
      errors.report(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const d = detail.data;
  const ticket = d?.ticket ?? null;
  const base = selectedId ? `/agent/tickets/${encodeURIComponent(selectedId)}` : "";
  const closed = ticket?.status === "closed";
  const mode = ticket?.conversation.handlingMode;
  const suppressed = d?.aiRuns.filter((r) => r.status === "suppressed").length ?? 0;
  const mySeat = me.data?.seat ?? null;

  const otherSeats = (seats.data?.seats ?? []).filter((s) => s.id !== seatId);
  const seatOptions = bootSeats ?? FALLBACK_SEATS;

  const switchSeat = (id: string) => {
    setSelectedId(null);
    setTargetSeat("");
    setSeatId(id);
  };

  return (
    <div className="page">
      <ErrorBar message={errors.message} onClose={errors.dismiss} />
      <div className="toolbar">
        <IdentityPicker label="当前席位" value={seatId} options={seatOptions.map((s) => ({ id: s.id, name: `客服 ${s.name}` }))} onChange={switchSeat} />
        {mySeat && (
          <div className="seat-me">
            <span className={`dot ${mySeat.online ? "dot-on" : "dot-off"}`} />
            <span>{mySeat.online ? "在线" : "离线"}</span>
            <span className="muted">
              接待 {mySeat.activeCount}/{mySeat.capacity}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void act(() => api<AgentStatusResp>(identity, "POST", "/agent/me/status", { online: !mySeat.online }))}
            >
              {mySeat.online ? "下线" : "上线"}
            </button>
          </div>
        )}
        <div className="seat-loads">
          {seats.data?.seats.map((s) => (
            <span key={s.id} className={`seat-chip${s.online ? "" : " off"}`}>
              客服 {s.name}：{s.activeCount}/{s.capacity}
              {s.online ? "" : "（离线）"}
            </span>
          ))}
          {seats.data && <span className="seat-chip queue">等待队列 {seats.data.queue.count}</span>}
        </div>
      </div>

      <div className="layout">
        <aside className="col col-left">
          <div className="col-head">
            <h3>我的工单</h3>
            <div className="filter">
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
          </div>
          <TicketList
            tickets={tickets.data?.tickets ?? []}
            selectedId={selectedId}
            onSelect={setSelectedId}
            variant="agent"
            emptyText={tickets.data ? "暂无工单" : "加载中…"}
          />
        </aside>

        <section className="col col-mid">
          {ticket ? (
            <>
              <div className="info-bar">
                <span>
                  <strong>{ticket.customerName}</strong> · {ticket.id}
                </span>
                <StatusTag kind="ticket" value={ticket.status} text={ticket.statusText} />
                {!closed && mode && <StatusTag kind="mode" value={mode} />}
                {ticket.handoverRequested && !closed && <span className="red-dot">客户要求人工</span>}
              </div>
              <div className="action-bar">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy || closed || mode !== "ai"}
                  onClick={() => void act(() => api<AgentTicketResp>(identity, "POST", `${base}/takeover`, {}))}
                >
                  接管
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy || closed || mode !== "human"}
                  onClick={() => void act(() => api<AgentTicketResp>(identity, "POST", `${base}/resume-ai`, {}))}
                >
                  恢复 AI
                </button>
                <span className="spacer" />
                <select value={targetSeat} disabled={busy || closed} onChange={(e) => setTargetSeat(e.target.value)}>
                  <option value="">转派给…</option>
                  {otherSeats.map((s) => (
                    <option key={s.id} value={s.id} disabled={!s.online || s.activeCount >= s.capacity}>
                      客服 {s.name}
                      {!s.online ? "（离线）" : s.activeCount >= s.capacity ? "（已满）" : ""}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy || closed || !targetSeat}
                  onClick={async () => {
                    const r = await act(() =>
                      api<AgentTicketResp>(identity, "POST", `${base}/transfer`, { targetSeatId: targetSeat }),
                    );
                    if (r) {
                      setTargetSeat("");
                      setSelectedId(null); // 转派后工单不再属于本席位
                    }
                  }}
                >
                  转派
                </button>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  disabled={busy || closed}
                  onClick={() => {
                    if (window.confirm(`确定结束工单 ${ticket.id} 的服务吗？结束后客户需新建咨询。`)) {
                      void act(() => api<AgentTicketResp>(identity, "POST", `${base}/close`, {}));
                    }
                  }}
                >
                  结束服务
                </button>
              </div>
              <MessageList
                messages={d?.messages ?? []}
                resetKey={selectedId}
                notice={suppressed > 0 ? `有 ${suppressed} 条 AI 回复因人工接管已被拦截` : null}
              />
              <Composer
                disabled={closed || mode !== "human"}
                disabledHint={closed ? "工单已结束" : "请先接管"}
                placeholder="回复客户…"
                sendText="发送回复"
                onSend={async (content, clientMessageId) => {
                  try {
                    await api<AgentReplyResp>(identity, "POST", `${base}/reply`, { content, clientMessageId });
                    errors.clear();
                    refreshAll();
                  } catch (e) {
                    errors.report(e);
                    throw e;
                  }
                }}
              />
            </>
          ) : (
            <div className="empty center">{selectedId ? "加载中…" : "请从左侧选择一个工单"}</div>
          )}
        </section>

        <aside className="col col-right">
          {d ? (
            <SummaryPanel ticket={d.ticket} orders={d.orders} refunds={d.refunds} />
          ) : (
            <div className="empty">选择工单后显示摘要、订单与退款</div>
          )}
        </aside>
      </div>
    </div>
  );
}

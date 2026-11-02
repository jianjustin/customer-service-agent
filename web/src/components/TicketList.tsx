import type { TicketDTO } from "../types";
import { StatusTag } from "./StatusTag";

export function TicketList({
  tickets,
  selectedId,
  onSelect,
  variant,
  emptyText = "暂无工单",
}: {
  tickets: TicketDTO[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  variant: "customer" | "agent";
  emptyText?: string;
}) {
  if (tickets.length === 0) return <div className="empty">{emptyText}</div>;
  return (
    <ul className="ticket-list">
      {tickets.map((t) => (
        <li key={t.id}>
          <button
            type="button"
            className={`ticket-item${t.id === selectedId ? " selected" : ""}`}
            onClick={() => onSelect(t.id)}
          >
            <div className="ticket-item-top">
              <span className="ticket-subject">
                {variant === "agent" && <strong>{t.customerName}</strong>}
                {variant === "agent" ? ` · ${t.subject}` : t.subject}
              </span>
              {variant === "agent" && t.handoverRequested && t.status !== "closed" && (
                <span className="red-dot" title={t.handoverReason ?? undefined}>
                  客户要求人工
                </span>
              )}
            </div>
            <div className="ticket-item-meta">
              <span className="muted">{t.id}</span>
            </div>
            <div className="ticket-item-tags">
              <StatusTag kind="ticket" value={t.status} text={t.statusText} />
              {variant === "customer" && (
                <span className="muted">{t.seatName ? `客服 ${t.seatName}` : t.status === "closed" ? "" : "排队中"}</span>
              )}
              {t.status !== "closed" && <StatusTag kind="mode" value={t.conversation.handlingMode} />}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

import { useMemo, useRef, useState } from "react";
import { api, type Identity } from "../api";
import { Composer } from "../components/Composer";
import { ErrorBar, useErrorBar } from "../components/ErrorBar";
import { IdentityPicker } from "../components/IdentityPicker";
import { MessageList } from "../components/MessageList";
import { OrdersPanel } from "../components/OrdersPanel";
import { RefundsPanel } from "../components/RefundsPanel";
import { StatusTag } from "../components/StatusTag";
import { TicketList } from "../components/TicketList";
import { useIdentity } from "../hooks/useIdentity";
import { usePolling } from "../hooks/usePolling";
import type {
  CustomerMessagesResp,
  CustomerTicketsResp,
  MessageDTO,
  OrdersResp,
  RefundsResp,
  SendMessageBody,
  SendMessageResp,
  TicketResp,
} from "../types";

const FALLBACK_CUSTOMERS = [
  { id: "cust_a", name: "客户甲" },
  { id: "cust_b", name: "客户乙" },
  { id: "cust_c", name: "客户丙" },
];

function mergeBySeq(prev: MessageDTO[], incoming: MessageDTO[]): MessageDTO[] {
  const map = new Map<number, MessageDTO>();
  for (const m of prev) map.set(m.seq, m);
  for (const m of incoming) map.set(m.seq, m);
  return [...map.values()].sort((a, b) => a.seq - b.seq);
}

export function CustomerPage({ customers }: { customers: { id: string; name: string }[] | null }) {
  const [customerId, setCustomerId] = useIdentity("customer", "cust_a");
  const identity = useMemo<Identity>(() => ({ role: "customer", id: customerId }), [customerId]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newMode, setNewMode] = useState(false);
  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const selRef = useRef<string | null>(null);
  const lastSeq = useRef(0);
  const [handoverBusy, setHandoverBusy] = useState(false);

  const selectTicket = (id: string | null) => {
    selRef.current = id;
    lastSeq.current = 0;
    setMessages([]);
    setSelectedId(id);
    setNewMode(false);
  };

  const tickets = usePolling(
    () => api<CustomerTicketsResp>(identity, "GET", "/customer/tickets"),
    [identity],
  );
  const orders = usePolling(() => api<OrdersResp>(identity, "GET", "/customer/orders"), [identity]);
  const refunds = usePolling(() => api<RefundsResp>(identity, "GET", "/customer/refunds"), [identity]);

  // 增量拉取：afterSeq = 本地最大 seq；切换工单时 selectTicket 已清空
  const msgPoll = usePolling(
    async () => {
      const tid = selRef.current;
      if (!tid) return null;
      const r = await api<CustomerMessagesResp>(
        identity,
        "GET",
        `/customer/tickets/${encodeURIComponent(tid)}/messages?afterSeq=${lastSeq.current}`,
      );
      if (selRef.current !== tid) return null; // 已切换工单，丢弃
      if (r.messages.length) {
        lastSeq.current = Math.max(lastSeq.current, ...r.messages.map((m) => m.seq));
        setMessages((prev) => mergeBySeq(prev, r.messages));
      }
      return r;
    },
    [identity, selectedId],
  );

  const errors = useErrorBar([tickets.error, orders.error, refunds.error, msgPoll.error]);

  const listTicket = tickets.data?.tickets.find((t) => t.id === selectedId) ?? null;
  const ticket = msgPoll.data?.ticket ?? listTicket;
  const closed = ticket?.status === "closed";
  const isHuman = ticket?.conversation.handlingMode === "human";

  const refreshAll = () => {
    tickets.refresh();
    msgPoll.refresh();
    orders.refresh();
    refunds.refresh();
  };

  const send = async (content: string, clientMessageId: string) => {
    const body: SendMessageBody = { content, clientMessageId };
    if (selectedId) body.ticketId = selectedId;
    else if (newMode) body.newTicket = true;
    try {
      const r = await api<SendMessageResp>(identity, "POST", "/customer/messages", body);
      errors.clear();
      if (r.ticket.id !== selectedId) selectTicket(r.ticket.id);
      refreshAll();
    } catch (e) {
      errors.report(e);
      throw e;
    }
  };

  const handover = async () => {
    if (!selectedId) return;
    setHandoverBusy(true);
    try {
      await api<TicketResp>(identity, "POST", `/customer/tickets/${encodeURIComponent(selectedId)}/handover`, {});
      errors.clear();
      refreshAll();
    } catch (e) {
      errors.report(e);
    } finally {
      setHandoverBusy(false);
    }
  };

  return (
    <div className="page">
      <ErrorBar message={errors.message} onClose={errors.dismiss} />
      <div className="toolbar">
        <IdentityPicker
          label="当前客户"
          value={customerId}
          options={customers ?? FALLBACK_CUSTOMERS}
          onChange={(id) => {
            selectTicket(null);
            setCustomerId(id);
          }}
        />
      </div>
      <div className="layout">
        <aside className="col col-left">
          <div className="col-head">
            <h3>我的咨询</h3>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                selectTicket(null);
                setNewMode(true);
              }}
            >
              新建咨询
            </button>
          </div>
          <TicketList
            tickets={tickets.data?.tickets ?? []}
            selectedId={selectedId}
            onSelect={selectTicket}
            variant="customer"
            emptyText={tickets.data ? "暂无咨询，发送消息即可开始" : "加载中…"}
          />
        </aside>

        <section className="col col-mid">
          {ticket && selectedId ? (
            <div className="info-bar">
              <span>
                工单 <strong>{ticket.id}</strong>
              </span>
              <StatusTag kind="ticket" value={ticket.status} text={ticket.statusText} />
              <span>{ticket.seatName ? `客服 ${ticket.seatName}` : closed ? "-" : "排队中"}</span>
              {!closed && <StatusTag kind="mode" value={ticket.conversation.handlingMode} />}
              <span className="spacer" />
              <button
                type="button"
                className="btn btn-sm"
                disabled={closed || isHuman || handoverBusy}
                title={isHuman ? "已是人工接待" : undefined}
                onClick={() => void handover()}
              >
                申请转人工
              </button>
            </div>
          ) : (
            <div className="info-bar muted">
              {newMode ? "新建咨询：发送第一条消息将创建新工单" : "请选择左侧咨询，或直接发送消息开始新的咨询"}
            </div>
          )}
          <MessageList
            messages={messages}
            aiPending={msgPoll.data?.aiPending ?? false}
            resetKey={selectedId}
            emptyText={selectedId ? "暂无消息" : "发送一条消息开始咨询"}
          />
          <Composer
            onSend={send}
            disabled={closed}
            disabledHint="该工单已结束，请点击“新建咨询”"
            placeholder={newMode ? "描述您的问题，将创建新咨询…" : undefined}
          />
        </section>

        <aside className="col col-right">
          <OrdersPanel orders={orders.data?.orders ?? null} />
          <RefundsPanel refunds={refunds.data?.refunds ?? null} />
        </aside>
      </div>
    </div>
  );
}

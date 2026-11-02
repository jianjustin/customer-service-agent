import { useEffect, useRef } from "react";
import type { MessageDTO } from "../types";
import { MessageBubble } from "./MessageBubble";

export function MessageList({
  messages,
  aiPending,
  notice,
  emptyText = "暂无消息",
  resetKey,
}: {
  messages: MessageDTO[];
  aiPending?: boolean;
  /** 灰色提示条（如 AI 回复被拦截） */
  notice?: string | null;
  emptyText?: string;
  /** 变化时（如切换工单）强制滚动到底部 */
  resetKey?: string | null;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const last = messages.length ? messages[messages.length - 1].seq : 0;

  useEffect(() => {
    stickRef.current = true;
  }, [resetKey]);

  useEffect(() => {
    const el = boxRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [last, aiPending, notice, resetKey]);

  return (
    <div
      className="message-list"
      ref={boxRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
    >
      {messages.length === 0 && <div className="empty">{emptyText}</div>}
      {messages.map((m) => (
        <MessageBubble key={m.seq} message={m} />
      ))}
      {notice && <div className="suppressed-notice">{notice}</div>}
      {aiPending && <div className="ai-pending">AI 正在回复…</div>}
    </div>
  );
}

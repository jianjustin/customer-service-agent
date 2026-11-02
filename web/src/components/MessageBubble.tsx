import { formatTime } from "../format";
import type { MessageDTO } from "../types";

function agentBadge(label: string): string {
  const m = /^人工客服\s*(.+)$/.exec(label);
  return m ? `人工回复 · 客服 ${m[1]}` : `人工回复 · ${label}`;
}

export function MessageBubble({ message }: { message: MessageDTO }) {
  const time = formatTime(message.createdAt);

  if (message.senderType === "system") {
    return (
      <div className="msg msg-system">
        <span className="badge badge-system">系统</span>
        <span className="msg-system-text">{message.content}</span>
        <span className="msg-time">{time}</span>
      </div>
    );
  }

  const side = message.senderType === "customer" ? "msg-customer" : "msg-left";
  return (
    <div className={`msg ${side}`}>
      <div className="msg-head">
        {message.senderType === "ai" && <span className="badge badge-ai">AI 回复</span>}
        {message.senderType === "agent" && <span className="badge badge-agent">{agentBadge(message.senderLabel)}</span>}
        {message.senderType === "customer" && <span className="msg-name">{message.senderLabel}</span>}
        <span className="msg-time">{time}</span>
      </div>
      <div className={`bubble bubble-${message.senderType}`}>{message.content}</div>
      {message.sources.length > 0 && (
        <div className="msg-sources">
          {message.sources.map((s) => (
            <span key={`${s.id}-${s.version}`} className="source-tag">
              来源《{s.title}》v{s.version}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

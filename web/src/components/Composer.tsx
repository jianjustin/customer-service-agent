import { useRef, useState } from "react";
import { newClientId } from "../api";

/**
 * 输入框 + 发送。clientMessageId 在发送时生成；失败后保留，重试（内容未改）复用同一个 id，成功后才清除。
 * onSend 失败须抛出异常（由调用方展示错误）。
 */
export function Composer({
  onSend,
  disabled,
  disabledHint,
  placeholder = "输入消息，Enter 发送，Shift+Enter 换行",
  sendText = "发送",
}: {
  onSend: (content: string, clientMessageId: string) => Promise<void>;
  disabled?: boolean;
  disabledHint?: string;
  placeholder?: string;
  sendText?: string;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const pending = useRef<{ id: string; content: string } | null>(null);

  const submit = async () => {
    const content = text.trim();
    if (!content || sending || disabled) return;
    // 内容未变则复用失败前的 clientMessageId；内容变了视为新消息
    if (!pending.current || pending.current.content !== content) {
      pending.current = { id: newClientId(), content };
    }
    setSending(true);
    try {
      await onSend(content, pending.current.id);
      pending.current = null;
      setText("");
    } catch {
      /* 保留文本与 clientMessageId，等待重试 */
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="composer">
      {disabled && disabledHint && <div className="composer-hint">{disabledHint}</div>}
      <div className="composer-row">
        <textarea
          value={text}
          rows={2}
          maxLength={2000}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button type="button" className="btn btn-primary" disabled={disabled || sending || !text.trim()} onClick={() => void submit()}>
          {sending ? "发送中…" : sendText}
        </button>
      </div>
    </div>
  );
}

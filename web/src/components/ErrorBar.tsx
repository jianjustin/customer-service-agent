import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../api";

/** 页面顶部红色可关闭错误提示条 */
export function ErrorBar({ message, onClose }: { message: string | null; onClose: () => void }) {
  if (!message) return null;
  return (
    <div className="error-bar" role="alert">
      <span className="error-bar-text">{message}</span>
      <button type="button" className="error-bar-close" onClick={onClose} aria-label="关闭提示">
        ×
      </button>
    </div>
  );
}

/**
 * 汇总“轮询错误 + 操作错误”。report(e) 展示操作错误；dismiss 关闭当前提示
 * （同一条轮询错误关闭后不再重复弹出，直到恢复正常或错误内容变化）。
 */
export function useErrorBar(pollErrors: (string | null)[]) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const polled = pollErrors.find((e) => e) ?? null;
  const current = actionError ?? polled;

  useEffect(() => {
    if (!current && dismissed) setDismissed(null);
  }, [current, dismissed]);

  const report = useCallback((e: unknown) => {
    setDismissed(null);
    setActionError(errorMessage(e));
  }, []);
  const clear = useCallback(() => setActionError(null), []);
  const dismiss = useCallback(() => {
    setDismissed(current);
    setActionError(null);
  }, [current]);

  return {
    message: current && current !== dismissed ? current : null,
    report,
    clear,
    dismiss,
  };
}

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 轮询：mount / deps 变化时立即拉取一次，之后每 intervalMs 拉取；document.hidden 时暂停，
 * 页面重新可见时立即补拉一次。deps 变化会清空 data，并丢弃旧 deps 下尚未返回的响应。
 * refresh() 立即触发一次拉取（写操作成功后调用）。
 */
export function usePolling<T>(
  fn: () => Promise<T>,
  deps: unknown[],
  intervalMs = 2000,
): { data: T | null; error: string | null; refresh(): void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const runRef = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    let reqSeq = 0; // 发出的请求序号
    let appliedSeq = 0; // 已应用的最新序号，防止乱序响应覆盖新数据
    let timer: ReturnType<typeof setTimeout> | undefined;
    setData(null);
    setError(null);

    const run = async () => {
      const mySeq = ++reqSeq;
      try {
        const result = await fnRef.current();
        if (!alive || mySeq < appliedSeq) return;
        appliedSeq = mySeq;
        setData(result);
        setError(null);
      } catch (e) {
        if (!alive || mySeq < appliedSeq) return;
        appliedSeq = mySeq;
        setError(e instanceof Error ? e.message : String(e));
      }
    };
    const schedule = () => {
      timer = setTimeout(async () => {
        if (!document.hidden) await run();
        if (alive) schedule();
      }, intervalMs);
    };
    const onVisible = () => {
      if (!document.hidden && alive) void run();
    };

    runRef.current = () => {
      if (alive) void run();
    };
    void run();
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);

  const refresh = useCallback(() => runRef.current(), []);
  return { data, error, refresh };
}

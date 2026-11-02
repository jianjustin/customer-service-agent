// Outbox 通知与投递 worker（SPEC §I）。
// 隔离约束：本模块只依赖 Repos 与 ChannelRegistry，绝不 import 退款服务或 Graph，
// 因此通知重试不可能触发再次退款。
import type { ChannelRegistry } from "../channels/types";
import type { NotificationPayload, NotificationTemplate } from "../domain/types";
import type { Repos } from "../repos/interfaces";
import { formatMoney, nowIso } from "../util";

export type { NotificationPayload, NotificationTemplate };

/** 通知模板（原样见 SPEC §I）。文本在入队时渲染 */
export function renderNotification(p: Omit<NotificationPayload, "text">): string {
  const money = formatMoney(p.amountMinor);
  switch (p.template) {
    case "refund_submitted":
      return `【退款进度】您的退款申请 ${p.requestId}（订单 ${p.orderId}，金额 ${money}）已提交，正在等待人工审核，审核结果将第一时间通知您。`;
    case "refund_refunded":
      return `【退款进度】退款申请 ${p.requestId} 已审核通过并完成模拟退款，订单 ${p.orderId} 已更新为“已退款（模拟）”，金额 ${money}。`;
    case "refund_rejected":
      return `【退款进度】很抱歉，退款申请 ${p.requestId}（订单 ${p.orderId}）未通过审核。审核意见：${p.comment ?? ""}。如有疑问可申请转人工客服。`;
    case "refund_failed":
      return `【退款进度】退款申请 ${p.requestId}（订单 ${p.orderId}）暂未执行成功，我们已记录原因并将由审核员跟进处理，请耐心等待。`;
  }
}

/** `refund:${id}:${status}:a${attempt}`（submitted 恒为 a1） */
export function refundDedupeKey(
  requestId: string,
  status: "submitted" | "refunded" | "rejected" | "failed",
  attempt: number,
): string {
  return `refund:${requestId}:${status}:a${attempt}`;
}

export interface OutboxWorker {
  start(): void;
  stop(): Promise<void>;
  tick(): Promise<{ sent: number; retried: number; failed: number }>;
}

type TickResult = { sent: number; retried: number; failed: number };

export function createOutboxWorker(deps: {
  repos: Repos;
  channels: ChannelRegistry;
  pollMs: number;
  maxAttempts: number;
}): OutboxWorker {
  const { repos, channels, pollMs, maxAttempts } = deps;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<TickResult> | null = null;

  async function runTick(): Promise<TickResult> {
    const result: TickResult = { sent: 0, retried: 0, failed: 0 };
    const rows = repos.outbox.due(nowIso(), 20);
    for (const row of rows) {
      try {
        const conv = repos.conversations.get(row.conversation_id);
        if (!conv) throw new Error(`会话不存在：${row.conversation_id}`);
        const payload = JSON.parse(row.payload_json) as NotificationPayload;
        await channels.get(conv.channel).deliverSystemMessage({
          conversationId: conv.id,
          text: payload.text,
          dedupeKey: row.dedupe_key,
        });
        repos.outbox.markSent(row.id, nowIso());
        repos.logs.write({ scope: "outbox", refId: row.dedupe_key, node: "deliver", event: "sent" });
        result.sent++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const attempts = row.attempts + 1;
        if (attempts >= maxAttempts) {
          repos.outbox.markFailed(row.id, attempts, msg);
          repos.logs.write({
            scope: "outbox",
            refId: row.dedupe_key,
            node: "deliver",
            event: "failed",
            detail: { attempts, error: msg },
          });
          result.failed++;
        } else {
          const backoff = Math.min(60000, 1000 * 2 ** (attempts - 1));
          repos.outbox.markRetry(row.id, attempts, new Date(Date.now() + backoff).toISOString(), msg);
          repos.logs.write({
            scope: "outbox",
            refId: row.dedupe_key,
            node: "deliver",
            event: "retry",
            detail: { attempts, error: msg },
          });
          result.retried++;
        }
      }
    }
    return result;
  }

  /** 串行执行：已有 tick 在进行时，等其结束后再跑一轮（保证调用方看到自己之后入队的数据被处理） */
  async function tick(): Promise<TickResult> {
    while (inFlight) await inFlight.catch(() => undefined);
    const p = runTick();
    inFlight = p;
    try {
      return await p;
    } finally {
      if (inFlight === p) inFlight = null;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (inFlight) return; // 防重入：上一轮未完成则跳过
        tick().catch((e) => console.error("[outbox] tick 异常：", e));
      }, pollMs);
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (inFlight) await inFlight.catch(() => undefined);
    },
    tick,
  };
}

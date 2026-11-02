// AI 排查摘要（SPEC §E.8）：规则拼接，不调用 LLM。生成 7 行文本写入 tickets.ai_summary。
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { REFUND_STATUS_TEXT, type MessageSource } from "../domain/types";
import type { Repos } from "../repos/interfaces";
import { nowIso } from "../util";
import type { AgentRuntime } from "./types";

export interface SummaryService {
  /** 生成并写入 tickets.ai_summary，返回文本 */
  refresh(ticketId: string): Promise<string>;
}

const NONE = "无";

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) : t;
}

/** 读取工具消息中的结构化数据（MCP artifact → 本地 artifact → 文本 JSON）。批次 3 的 extract.ts 有同源实现。 */
function toolData(msg: ToolMessage): Record<string, unknown> | null {
  const art: unknown = msg.artifact;
  if (Array.isArray(art)) {
    const item = art.find((a) => a && typeof a === "object" && (a as { type?: string }).type === "mcp_structured_content") as
      | { data?: unknown }
      | undefined;
    if (item && item.data && typeof item.data === "object") return item.data as Record<string, unknown>;
  }
  try {
    const text = typeof msg.content === "string" ? msg.content : msg.text;
    const v: unknown = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // 非 JSON 文本
  }
  return null;
}

interface OrderLike {
  orderId?: string;
  title?: string;
  paymentStatusText?: string;
  shippingStatusText?: string;
}

function orderLine(o: OrderLike): string {
  return `${o.orderId ?? "未知订单"} ${o.title ?? ""}：${o.paymentStatusText ?? "未知"}/${o.shippingStatusText ?? "未知"}`.replace("  ", " ");
}

/** 从 agent 线程消息中提取订单/支付信息行（按订单号去重，保持首次出现顺序） */
function collectOrderLines(messages: BaseMessage[]): string[] {
  const callArgs = new Map<string, Record<string, unknown>>();
  for (const m of messages) {
    if (AIMessage.isInstance(m)) {
      for (const tc of m.tool_calls ?? []) if (tc.id) callArgs.set(tc.id, tc.args as Record<string, unknown>);
    }
  }
  const lines = new Map<string, string>();
  for (const m of messages) {
    if (!ToolMessage.isInstance(m)) continue;
    if (!m.name || !m.name.startsWith("orders_")) continue;
    const text = typeof m.content === "string" ? m.content : m.text;
    if (m.status === "error") {
      if (/^FORBIDDEN:/.test(text)) {
        const oid = String(callArgs.get(m.tool_call_id)?.order_id ?? callArgs.get(m.tool_call_id)?.refund_request_id ?? "订单");
        lines.set(oid, `${oid}：查询被拒绝（非本人订单）`);
      }
      continue;
    }
    const data = toolData(m);
    if (!data) continue;
    if (Array.isArray(data.orders)) {
      for (const o of data.orders as OrderLike[]) if (o.orderId && !lines.has(o.orderId)) lines.set(o.orderId, orderLine(o));
    }
    if (data.order && typeof data.order === "object") {
      const o = data.order as OrderLike;
      if (o.orderId) lines.set(o.orderId, orderLine(o));
    }
  }
  return [...lines.values()];
}

export function createSummaryService(deps: { repos: Repos; getAgent: () => AgentRuntime | null }): SummaryService {
  const { repos, getAgent } = deps;
  return {
    async refresh(ticketId) {
      const ticket = repos.tickets.get(ticketId);
      if (!ticket) throw new Error(`工单不存在：${ticketId}`);
      const conv = repos.conversations.getByTicket(ticketId);
      if (!conv) throw new Error(`工单无会话：${ticketId}`);

      const msgs = repos.messages.list(conv.id);
      const customerMsgs = msgs.filter((m) => m.sender_type === "customer");
      const first = customerMsgs[0];
      const last = customerMsgs[customerMsgs.length - 1];

      let orderPart = NONE;
      const agent = getAgent();
      if (agent) {
        try {
          const lines = collectOrderLines(await agent.getThreadMessages(conv.thread_id));
          if (lines.length > 0) orderPart = lines.join("；");
        } catch (e) {
          console.error("[summary] 读取 agent 线程失败：", e);
        }
      }

      const seen = new Map<string, MessageSource>();
      for (const m of msgs) {
        if (m.sender_type !== "ai") continue;
        try {
          for (const s of JSON.parse(m.sources_json) as MessageSource[]) if (!seen.has(s.id)) seen.set(s.id, s);
        } catch {
          // 忽略损坏的 sources_json
        }
      }
      const sourcePart = [...seen.values()].map((s) => `《${s.title}》v${s.version}`).join("、") || NONE;

      const refundPart =
        repos.refunds
          .listByTicket(ticketId)
          .map((r) => `${r.id}（订单 ${r.order_id}，${REFUND_STATUS_TEXT[r.status]}）`)
          .join("；") || NONE;

      const text = [
        `【客户诉求】${first ? truncate(first.content, 50) : NONE}`,
        `【最近问题】${last ? truncate(last.content, 50) : NONE}`,
        `【订单/支付】${orderPart}`,
        `【知识来源】${sourcePart}`,
        `【退款申请】${refundPart}`,
        `【转人工】${ticket.handover_requested === 1 ? `是（${ticket.handover_reason ?? NONE}）` : "否"}`,
        `【接待状态】${conv.handling_mode === "ai" ? "AI 接待中" : "人工接管中"}`,
      ].join("\n");

      repos.tickets.setSummary(ticketId, text, nowIso());
      return text;
    },
  };
}

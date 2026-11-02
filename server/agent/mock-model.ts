// 规则型 Mock 模型（SPEC §G）：确定性、无外部依赖，用于离线演示与自动化测试。
// 结构参考 langchain 的 FakeToolCallingModel；决策逻辑集中在纯函数 decideMockResponse。
import { randomUUID } from "node:crypto";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { BaseChatModel, type BaseChatModelParams, type BindToolsInput } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { formatMoney, sleep } from "../util";
import { parseToolError, readToolData } from "./extract";

export const MOCK_PREFIX = "[Mock 模式] ";

export interface MockChatModelFields extends BaseChatModelParams {
  delayMs?: number;
}

function toolNameOf(t: BindToolsInput): string {
  const x = t as { name?: string; function?: { name?: string } };
  return x.name ?? x.function?.name ?? "";
}

export class MockChatModel extends BaseChatModel {
  delayMs: number;
  boundToolNames: string[] = [];

  constructor(fields: MockChatModelFields = {}) {
    super(fields);
    this.delayMs = fields.delayMs ?? 0;
  }

  _llmType(): string {
    return "mock-rule-based";
  }

  bindTools(tools: BindToolsInput[], _kwargs?: Partial<this["ParsedCallOptions"]>): MockChatModel {
    const m = new MockChatModel({ delayMs: this.delayMs });
    m.boundToolNames = tools.map(toolNameOf).filter((n) => n.length > 0);
    return m;
  }

  async _generate(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    if (this.delayMs > 0) await sleep(this.delayMs);
    const message = decideMockResponse(messages, this.boundToolNames);
    return { generations: [{ text: message.text, message }], llmOutput: {} };
  }
}

// ---------------------------------------------------------------------------------------------
// 固定文案
// ---------------------------------------------------------------------------------------------

const GREETING_REPLY = "您好，我是智能客服助手，可以帮您查询订单与支付状态、解答常见问题、申请退款或转人工。请问有什么可以帮您？";
const FALLBACK = "抱歉，我暂时无法完成该请求，您可以申请转人工客服。";
const UNAVAILABLE = "抱歉，该功能暂不可用，您可以申请转人工客服。";
const NO_EVIDENCE =
  "抱歉，目前没有找到可以支持回答该问题的依据，我不能凭猜测答复。您可以补充更多细节（例如订单号或具体场景），或申请转人工客服。";

function errorText(code: string): string {
  switch (code) {
    case "FORBIDDEN":
      return "抱歉，系统校验显示该订单不属于您当前登录的账户，无法为您查询或办理。如有疑问可申请转人工客服。";
    case "NOT_FOUND":
      return "抱歉，没有找到该订单，请核对订单号（格式如 ORD-1001）。";
    case "UNAUTHORIZED":
      return "抱歉，身份校验未通过，暂时无法查询订单。";
    default:
      return "抱歉，订单服务暂时不可用，请稍后再试或申请转人工客服。";
  }
}

// ---------------------------------------------------------------------------------------------
// 意图判定（G.3）
// ---------------------------------------------------------------------------------------------

const ORDER_ID_RE = /ORD-\d{4}/i;
const REASON_PHRASES = ["质量问题", "不想要了", "不想要", "发错货", "发错", "损坏", "破损", "尺寸不合适", "不合适", "重复购买", "买错了", "与描述不符"];
const GREETINGS = new Set(["你好", "您好", "在吗", "hi", "hello", "嗨", "哈喽"]);

function findOrderId(text: string): string | null {
  const m = ORDER_ID_RE.exec(text);
  return m ? m[0].toUpperCase() : null;
}

function extractReason(text: string): string | null {
  const m = /(?:因为|原因是|理由是|由于|原因[:：]|理由[:：])\s*([^。！!？?\n]{2,100})/.exec(text);
  if (m) {
    const r = m[1]!.replace(/\s+/g, "");
    if (r.length >= 2) return r;
  }
  for (const p of REASON_PHRASES) if (text.includes(p)) return p;
  return null;
}

type Intent =
  | { kind: "GREETING" }
  | { kind: "HANDOVER" }
  | { kind: "REFUND_PROGRESS" }
  | { kind: "REFUND_APPLY"; orderId: string | null; reason: string | null }
  | { kind: "ORDER_QUERY"; orderId: string | null }
  | { kind: "KNOWLEDGE" };

function detectIntent(userText: string, prevAiText: string): Intent {
  const norm = userText.toLowerCase().replace(/[^一-龥a-z0-9]/g, "");
  if (GREETINGS.has(norm)) return { kind: "GREETING" };
  if (/(转人工|人工客服|找人工|真人|人工服务)/.test(userText) && !/(时间|几点)/.test(userText)) return { kind: "HANDOVER" };
  if (/进度/.test(userText) || (/退款/.test(userText) && /(到哪|状态|结果|怎么样了|审核了吗|批了吗)/.test(userText))) {
    return { kind: "REFUND_PROGRESS" };
  }
  // 追问续接：上一轮 AI 在向客户索要退款理由 / 订单号
  const userOrderId = findOrderId(userText);
  const prevOrderId = findOrderId(prevAiText);
  if (prevAiText.includes("请告诉我退款理由") && prevOrderId) {
    return { kind: "REFUND_APPLY", orderId: prevOrderId, reason: extractReason(userText) ?? (userText.length >= 2 ? userText.slice(0, 100) : null) };
  }
  if (prevAiText.includes("请问您要为哪笔订单申请退款") && userOrderId) {
    return { kind: "REFUND_APPLY", orderId: userOrderId, reason: extractReason(userText) };
  }
  if (/(退款|退钱)/.test(userText) && (/(申请|我要|我想|想要|帮我|给我|要求)/.test(userText) || userOrderId)) {
    return { kind: "REFUND_APPLY", orderId: userOrderId, reason: extractReason(userText) };
  }
  if (/(退款|退钱)/.test(userText)) return { kind: "KNOWLEDGE" };
  if (userOrderId || /(我的订单|订单状态|查订单|查一下订单|查询订单|物流|快递|什么时候到|到哪了|发货了吗|支付状态|付款状态|有哪些订单)/.test(userText)) {
    return { kind: "ORDER_QUERY", orderId: userOrderId };
  }
  return { kind: "KNOWLEDGE" };
}

// ---------------------------------------------------------------------------------------------
// 决策（G.2 / G.4）
// ---------------------------------------------------------------------------------------------

const finalReply = (body: string): AIMessage => new AIMessage({ content: MOCK_PREFIX + body });

function toolCallMessage(calls: Array<{ name: string; args: Record<string, unknown> }>): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: calls.map((c) => ({ id: "mock_" + randomUUID().slice(0, 8), name: c.name, args: c.args, type: "tool_call" as const })),
  });
}

/** 工具结果的结构化内容：本地工具优先取文本 JSON（扁平），MCP 工具取 mcp_structured_content */
function payloadOf(msg: ToolMessage): Record<string, any> | null {
  const d = readToolData(msg);
  if (d && typeof d === "object" && "kind" in d) {
    try {
      const j: unknown = JSON.parse(msg.text);
      if (j && typeof j === "object") return j as Record<string, any>;
    } catch {
      // 回落到 artifact
    }
  }
  return d && typeof d === "object" ? (d as Record<string, any>) : null;
}

const TERMINAL_REFUND = new Set(["rejected", "refunded", "failed"]);

/**
 * 纯函数：依据“本轮已有的工具结果”决定下一步（调用工具，或给出最终回复）。
 * messages 含历史；本轮 = 最后一条 HumanMessage 之后的消息。
 */
export function decideMockResponse(messages: BaseMessage[], toolNames: string[]): AIMessage {
  let h = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (HumanMessage.isInstance(messages[i]!)) {
      h = i;
      break;
    }
  }
  if (h < 0) return finalReply(FALLBACK);
  const userText = messages[h]!.text.trim();
  const turn = messages.slice(h + 1);

  let prevAiText = "";
  for (let i = h - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (AIMessage.isInstance(m) && !(m.tool_calls?.length)) {
      prevAiText = m.text;
      break;
    }
  }

  const toolCallRounds = turn.filter((m) => AIMessage.isInstance(m) && (m.tool_calls?.length ?? 0) > 0).length;
  if (toolCallRounds >= 4) return finalReply(FALLBACK);

  const called = (name: string): boolean =>
    turn.some(
      (m) =>
        (AIMessage.isInstance(m) && (m.tool_calls ?? []).some((tc) => tc.name === name)) ||
        (ToolMessage.isInstance(m) && m.name === name),
    );
  const result = (name: string): ToolMessage | undefined => {
    for (let i = turn.length - 1; i >= 0; i--) {
      const m = turn[i]!;
      if (ToolMessage.isInstance(m) && m.name === name) return m;
    }
    return undefined;
  };
  const isErr = (m: ToolMessage): boolean => m.status === "error";
  const errCode = (m: ToolMessage): string => parseToolError(m)?.code ?? "UNKNOWN";
  const available = (...names: string[]): boolean => names.every((n) => toolNames.includes(n));

  const intent = detectIntent(userText, prevAiText);

  switch (intent.kind) {
    case "GREETING":
      return finalReply(GREETING_REPLY);

    case "HANDOVER": {
      if (!called("request_human_handover")) {
        if (!available("request_human_handover")) return finalReply(UNAVAILABLE);
        return toolCallMessage([{ name: "request_human_handover", args: { reason: userText.slice(0, 200) } }]);
      }
      const r = result("request_human_handover");
      if (!r || isErr(r)) return finalReply("抱歉，转人工申请暂时未能提交，请稍后重试。");
      return finalReply("已为您申请转接人工客服，请稍候。人工客服接入前，AI 助手将暂停自动回复。");
    }

    case "REFUND_PROGRESS": {
      if (!called("get_refund_progress")) {
        if (!available("get_refund_progress")) return finalReply(UNAVAILABLE);
        return toolCallMessage([{ name: "get_refund_progress", args: {} }]);
      }
      const r = result("get_refund_progress");
      if (!r || isErr(r)) return finalReply(FALLBACK);
      const refunds: Array<Record<string, any>> = payloadOf(r)?.refunds ?? [];
      if (refunds.length === 0) return finalReply("您当前没有退款申请记录。如需申请退款，请告诉我订单号和退款理由。");
      const lines = refunds.map(
        (x) =>
          `- ${x.requestId}（订单 ${x.orderId}，金额 ${formatMoney(x.amountMinor)}）：${x.statusText}` +
          (x.decisionComment ? `，审核意见：${x.decisionComment}` : ""),
      );
      let text = "您的退款申请进度如下：\n" + lines.join("\n");
      if (refunds.some((x) => !TERMINAL_REFUND.has(x.status))) text += "\n审核与执行完成后会通过系统消息通知您。";
      return finalReply(text);
    }

    case "ORDER_QUERY": {
      if (intent.orderId) {
        const id = intent.orderId;
        if (!called("orders_get_order")) {
          if (!available("orders_get_order")) return finalReply(UNAVAILABLE);
          return toolCallMessage([{ name: "orders_get_order", args: { order_id: id } }]);
        }
        const r = result("orders_get_order");
        if (!r) return finalReply(FALLBACK);
        if (isErr(r)) return finalReply(errorText(errCode(r)));
        const o = payloadOf(r)?.order;
        if (!o) return finalReply(FALLBACK);
        return finalReply(
          `订单 ${o.orderId}（${o.title}）：金额 ${formatMoney(o.amountMinor)}，支付状态：${o.paymentStatusText}，物流状态：${o.shippingStatusText}` +
            (o.trackingNo ? `，运单号 ${o.trackingNo}` : "") +
            (o.refundNote ? `，${o.refundNote}` : "") +
            "。",
        );
      }
      if (!called("orders_list_orders")) {
        if (!available("orders_list_orders")) return finalReply(UNAVAILABLE);
        return toolCallMessage([{ name: "orders_list_orders", args: {} }]);
      }
      const r = result("orders_list_orders");
      if (!r) return finalReply(FALLBACK);
      if (isErr(r)) return finalReply(errorText(errCode(r)));
      const orders: Array<Record<string, any>> = payloadOf(r)?.orders ?? [];
      if (orders.length === 0) return finalReply("您名下暂无订单。");
      return finalReply(
        `您名下共有 ${orders.length} 笔订单：\n` +
          orders.map((o) => `- ${o.orderId} ${o.title}：${formatMoney(o.amountMinor)}，${o.paymentStatusText}，${o.shippingStatusText}`).join("\n"),
      );
    }

    case "REFUND_APPLY": {
      if (!intent.orderId) {
        if (!called("orders_list_orders")) {
          if (!available("orders_list_orders")) return finalReply(UNAVAILABLE);
          return toolCallMessage([{ name: "orders_list_orders", args: {} }]);
        }
        const r = result("orders_list_orders");
        if (!r) return finalReply(FALLBACK);
        if (isErr(r)) return finalReply(errorText(errCode(r)));
        const paid = ((payloadOf(r)?.orders ?? []) as Array<Record<string, any>>).filter((o) => o.paymentStatus === "paid");
        if (paid.length === 0) return finalReply("您名下暂无可申请退款的已支付订单。");
        return finalReply(
          "请问您要为哪笔订单申请退款？您名下可申请退款的已支付订单：\n" +
            paid.map((o) => `- ${o.orderId} ${o.title}（${formatMoney(o.amountMinor)}）`).join("\n") +
            "\n请回复订单号和退款理由，例如：“ORD-1001 申请退款，原因是质量问题”。",
        );
      }
      const orderId = intent.orderId;
      // A) 先同时查订单与支付状态
      if (!called("orders_get_order")) {
        if (!available("orders_get_order", "orders_get_payment_status")) return finalReply(UNAVAILABLE);
        return toolCallMessage([
          { name: "orders_get_order", args: { order_id: orderId } },
          { name: "orders_get_payment_status", args: { order_id: orderId } },
        ]);
      }
      // B) 校验资格，齐全后提交
      if (!called("submit_refund_request")) {
        const ro = result("orders_get_order");
        const rp = result("orders_get_payment_status");
        if (!ro || !rp) return finalReply(FALLBACK);
        if (isErr(ro)) return finalReply(errorText(errCode(ro)));
        if (isErr(rp)) return finalReply(errorText(errCode(rp)));
        const order = payloadOf(ro)?.order;
        const payment = payloadOf(rp)?.payment;
        if (!order) return finalReply(FALLBACK);
        if (order.paymentStatus === "refunded") return finalReply(`订单 ${orderId} 已是“已退款（模拟）”状态，无需重复申请。`);
        if (order.paymentStatus === "unpaid") return finalReply(`订单 ${orderId} 尚未支付，无需申请退款。`);
        if (!payment || payment.status !== "succeeded") {
          return finalReply(`订单 ${orderId} 的支付记录状态为“${payment?.statusText ?? "未知"}”，暂不满足退款条件，建议申请转人工核实。`);
        }
        if (!intent.reason) {
          return finalReply(`已核对订单 ${orderId}（${order.title}，已支付 ${formatMoney(order.amountMinor)}）。请告诉我退款理由，例如：“原因是质量问题”。`);
        }
        if (!available("submit_refund_request")) return finalReply(UNAVAILABLE);
        return toolCallMessage([{ name: "submit_refund_request", args: { order_id: orderId, reason: intent.reason } }]);
      }
      // C) 提交结果
      const rs = result("submit_refund_request");
      if (!rs || isErr(rs)) return finalReply("抱歉，退款申请暂时未能提交，请稍后再试或申请转人工客服。");
      const p = payloadOf(rs);
      if (!p) return finalReply("抱歉，退款申请暂时未能提交，请稍后再试或申请转人工客服。");
      if (p.ok && !p.existing) {
        return finalReply(
          `已为您提交退款申请 ${p.requestId}（订单 ${p.orderId}，金额 ${formatMoney(p.amountMinor)}），当前状态：${p.statusText}。退款需经人工审核，审核通过并执行完成后会通知您；在此之前退款尚未完成。`,
        );
      }
      if (p.ok && p.existing) {
        return finalReply(`订单 ${p.orderId} 已有进行中的退款申请 ${p.requestId}，当前状态：${p.statusText}，无需重复提交。`);
      }
      return finalReply(`退款申请未能提交：${p.message}。`);
    }

    case "KNOWLEDGE": {
      if (!called("search_knowledge")) {
        if (!available("search_knowledge")) return finalReply(UNAVAILABLE);
        return toolCallMessage([{ name: "search_knowledge", args: { query: userText.slice(0, 200) } }]);
      }
      const r = result("search_knowledge");
      if (!r || isErr(r)) return finalReply(UNAVAILABLE);
      const p = payloadOf(r);
      const art = r.artifact as { hits?: Array<Record<string, any>> } | undefined;
      const hits: Array<Record<string, any>> = (art && Array.isArray(art.hits) ? art.hits : undefined) ?? p?.hits ?? [];
      if (hits.length === 0) return finalReply(NO_EVIDENCE);
      const first = hits[0]!;
      return finalReply(
        `根据《${first.title}》v${first.version}：${first.snippet}\n\n来源：` + hits.map((x) => `《${x.title}》v${x.version}`).join("；"),
      );
    }
  }
}

// 从消息 / ToolMessage 中提取结构化内容与来源（SPEC §F.6）。
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { MessageSource } from "../domain/types";

export const EMPTY_REPLY_TEXT = "抱歉，我暂时无法回答这个问题，您可以申请转人工客服。";

/** 返回 humanId 对应 HumanMessage 之后的消息；找不到返回 [] */
export function sliceTurn(messages: BaseMessage[], humanMessageId: string): BaseMessage[] {
  const idx = messages.findIndex((m) => m.id === humanMessageId);
  return idx < 0 ? [] : messages.slice(idx + 1);
}

function toolText(msg: ToolMessage): string {
  try {
    return msg.text;
  } catch {
    return typeof msg.content === "string" ? msg.content : "";
  }
}

/**
 * 读取工具结果的结构化数据：
 * 1) MCP：artifact 数组中 type==='mcp_structured_content' 的 data；
 * 2) 本地工具：artifact 为含 kind 的对象；
 * 3) 文本 JSON；4) null。
 */
export function readToolData(msg: ToolMessage): unknown | null {
  const art: unknown = msg.artifact;
  if (Array.isArray(art)) {
    const item = art.find((a) => a && typeof a === "object" && (a as { type?: string }).type === "mcp_structured_content") as
      | { data?: unknown }
      | undefined;
    if (item && item.data !== undefined) return item.data;
  } else if (art && typeof art === "object" && "kind" in art) {
    return art;
  }
  try {
    const v: unknown = JSON.parse(toolText(msg));
    if (v && typeof v === "object") return v;
  } catch {
    // 非 JSON 文本
  }
  return null;
}

/** 仅 status==='error' 有效；MCP 错误结果只有文本前缀 `CODE: message` */
export function parseToolError(msg: ToolMessage): { code: string; message: string } | null {
  if (msg.status !== "error") return null;
  const text = toolText(msg);
  const m = /^([A-Z_]+):\s*([\s\S]*)$/.exec(text);
  return m ? { code: m[1]!, message: m[2]! } : { code: "UNKNOWN", message: text };
}

/** 最后一条无 tool_calls 的 AIMessage 的文本 */
export function finalAiText(turn: BaseMessage[]): string {
  for (let i = turn.length - 1; i >= 0; i--) {
    const m = turn[i]!;
    if (AIMessage.isInstance(m) && !(m.tool_calls?.length)) return m.text;
  }
  return "";
}

interface HitLike {
  id?: string;
  title: string;
  version: number;
}

/** 本轮 search_knowledge 命中中，被最终文本以“《标题》vX”引用的条目（按 id 去重、保持首次出现顺序） */
export function collectSources(turn: BaseMessage[], finalText: string): MessageSource[] {
  const seen = new Map<string, HitLike>();
  for (const m of turn) {
    if (!ToolMessage.isInstance(m) || m.name !== "search_knowledge" || m.status === "error") continue;
    const art = m.artifact as { hits?: HitLike[] } | undefined;
    let hits = art && Array.isArray(art.hits) ? art.hits : undefined;
    if (!hits) {
      const d = readToolData(m) as { hits?: HitLike[] } | null;
      hits = d && Array.isArray(d.hits) ? d.hits : [];
    }
    for (const h of hits) {
      const key = h.id ?? `${h.title}@${h.version}`;
      if (!seen.has(key)) seen.set(key, h);
    }
  }
  const out: MessageSource[] = [];
  for (const [key, h] of seen) {
    if (finalText.includes(`《${h.title}》v${h.version}`)) out.push({ id: h.id ?? key, title: h.title, version: h.version });
  }
  return out;
}

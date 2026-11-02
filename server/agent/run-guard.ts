// AI run 有效性守卫：有副作用的本地工具（提交退款、申请转人工）执行前必须确认
// 本轮 run 仍然有效，否则接管 / 结单后在途的 AI run 仍可能产生写库、入队等副作用。
// 判定条件与写回事务（SPEC §E.3）一致：run.status='running' 且 run.generation === conversation.ai_generation
// 且 conversation.handling_mode='ai'。本函数是同步的，调用方应在同一个同步段（或同一个 tx）内紧接着执行副作用。
import type { Repos } from "../repos/interfaces";
import type { AgentContext } from "./context";

export const RUN_CANCELLED_CODE = "RUN_CANCELLED";
export const RUN_CANCELLED_MESSAGE = "会话已由人工接管，操作未执行";

export function isRunActive(repos: Pick<Repos, "aiRuns" | "conversations">, ctx: Pick<AgentContext, "runId" | "conversationId">): boolean {
  const run = repos.aiRuns.get(ctx.runId);
  if (!run || run.status !== "running" || run.conversation_id !== ctx.conversationId) return false;
  const conv = repos.conversations.get(ctx.conversationId);
  if (!conv) return false;
  return conv.handling_mode === "ai" && run.generation === conv.ai_generation;
}

/** 工具返回给模型的 RUN_CANCELLED 内容（content_and_artifact 的 content 部分） */
export function runCancelledContent(): string {
  return JSON.stringify({ ok: false, code: RUN_CANCELLED_CODE, message: RUN_CANCELLED_MESSAGE });
}

export const UNAVAILABLE_CONTENT = JSON.stringify({ ok: false, code: "UNAVAILABLE", message: "服务暂时不可用，请稍后再试" });

/**
 * 本地工具内部异常的统一出口：原始错误只写 execution_logs 与服务端日志，
 * 返回给模型的内容固定为通用的 UNAVAILABLE，避免内部细节（SQL、路径、栈）进入模型上下文。
 */
export function toolUnavailable(
  repos: Pick<Repos, "logs"> | undefined,
  ctx: Pick<AgentContext, "runId" | "conversationId">,
  toolName: string,
  err: unknown,
): [string, { kind: "tool_error"; code: "UNAVAILABLE" }] {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[tool] ${toolName} 执行失败：`, err);
  try {
    repos?.logs.write({
      scope: "conversation",
      refId: ctx.conversationId,
      node: toolName,
      event: "tool_error",
      detail: { runId: ctx.runId, error: message },
    });
  } catch {
    // 日志失败不影响返回
  }
  return [UNAVAILABLE_CONTENT, { kind: "tool_error", code: "UNAVAILABLE" }];
}

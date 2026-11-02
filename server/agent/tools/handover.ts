// 本地工具：申请转人工（SPEC §F.3）。只做标记；模式切换在 E.3 写回事务中完成。
import { tool, type DynamicStructuredTool, type ToolRuntime } from "@langchain/core/tools";
import { z } from "zod";
import type { Repos } from "../../repos/interfaces";
import type { HandoverService } from "../../services/handover";
import { agentContextSchema, readContext } from "../context";
import { runCancelledContent, toolUnavailable } from "../run-guard";

export function createHandoverTool(handover: HandoverService, repos: Repos): DynamicStructuredTool {
  return tool(
    async ({ reason }, runtime: ToolRuntime<unknown, typeof agentContextSchema>) => {
      const ctx = readContext(runtime);
      try {
        repos.logs.write({
          scope: "conversation",
          refId: ctx.conversationId,
          node: "request_human_handover",
          event: "tool_call",
          detail: { runId: ctx.runId, args: { reason } },
        });
        // requestByAiTool 在同一个事务内完成 run 有效性守卫（接管 / 结单后在途 run 不得再标记转人工）
        const res = handover.requestByAiTool(ctx, reason);
        if (!res.ok) return [runCancelledContent(), { kind: "run_cancelled" }];
        return [JSON.stringify({ ok: true, message: "已登记转人工申请" }), { kind: "handover" }];
      } catch (e) {
        return toolUnavailable(repos, ctx, "request_human_handover", e);
      }
    },
    {
      name: "request_human_handover",
      description: "为当前客户申请转接人工客服。客户明确要求人工服务时调用。",
      schema: z.object({ reason: z.string().min(1).max(200).describe("转人工原因") }),
      responseFormat: "content_and_artifact",
    },
  ) as unknown as DynamicStructuredTool;
}

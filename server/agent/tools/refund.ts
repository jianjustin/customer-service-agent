// 本地工具：提交退款申请 / 查询退款进度（SPEC §F.3）。客户身份只取可信上下文，不接受模型参数。
import { tool, type DynamicStructuredTool, type ToolRuntime } from "@langchain/core/tools";
import { z } from "zod";
import { REFUND_STATUS_TEXT } from "../../domain/types";
import type { Repos } from "../../repos/interfaces";
import type { RefundService } from "../../services/refunds";
import { agentContextSchema, readContext } from "../context";
import { isRunActive, runCancelledContent, toolUnavailable } from "../run-guard";

export function createSubmitRefundTool(refunds: RefundService, repos: Repos): DynamicStructuredTool {
  return tool(
    async ({ order_id, reason }, runtime: ToolRuntime<unknown, typeof agentContextSchema>) => {
      const ctx = readContext(runtime);
      try {
        // 副作用守卫：接管 / 结单后在途的 run 不得再提交退款（SPEC §E.3）
        if (!isRunActive(repos, ctx)) {
          repos.logs.write({
            scope: "conversation",
            refId: ctx.conversationId,
            node: "submit_refund_request",
            event: "run_cancelled",
            detail: { runId: ctx.runId, args: { order_id } },
          });
          return [runCancelledContent(), { kind: "run_cancelled" }];
        }
        repos.logs.write({
          scope: "conversation",
          refId: ctx.conversationId,
          node: "submit_refund_request",
          event: "tool_call",
          detail: { runId: ctx.runId, args: { order_id, reason } },
        });
        const result = await refunds.submit({
          customerId: ctx.customerId,
          ticketId: ctx.ticketId,
          conversationId: ctx.conversationId,
          orderId: order_id,
          reason,
          // 在 submit 的写事务内再次校验，保证“校验 + 写库”原子
          guard: () => isRunActive(repos, ctx),
        });
        if (result.ok) {
          const r = result.request;
          const content = JSON.stringify({
            ok: true,
            existing: result.existing,
            requestId: r.id,
            orderId: r.order_id,
            amountMinor: r.amount_minor,
            status: r.status,
            statusText: REFUND_STATUS_TEXT[r.status],
          });
          return [content, { kind: "refund_submit", result }];
        }
        if (result.code === "RUN_CANCELLED") return [runCancelledContent(), { kind: "run_cancelled" }];
        return [JSON.stringify({ ok: false, code: result.code, message: result.message }), { kind: "refund_submit", result }];
      } catch (e) {
        return toolUnavailable(repos, ctx, "submit_refund_request", e);
      }
    },
    {
      name: "submit_refund_request",
      description:
        "为当前客户的已支付订单提交整单退款申请。仅在已查询订单与支付状态、且已获得退款理由后调用。提交后需等待人工审核，你不能批准退款。",
      schema: z.object({
        order_id: z.string().regex(/^ORD-\d{4}$/).describe("订单号，例如 ORD-1001"),
        reason: z.string().min(2).max(200).describe("客户提供的退款理由"),
      }),
      responseFormat: "content_and_artifact",
    },
  ) as unknown as DynamicStructuredTool;
}

export function createRefundProgressTool(refunds: RefundService, repos: Repos): DynamicStructuredTool {
  return tool(
    async (_input, runtime: ToolRuntime<unknown, typeof agentContextSchema>) => {
      const ctx = readContext(runtime);
      try {
        repos.logs.write({
          scope: "conversation",
          refId: ctx.conversationId,
          node: "get_refund_progress",
          event: "tool_call",
          detail: { runId: ctx.runId, args: {} },
        });
        const rows = refunds.progressForCustomer(ctx.customerId);
        const list = rows.map((r) => ({
          requestId: r.id,
          orderId: r.order_id,
          status: r.status,
          statusText: REFUND_STATUS_TEXT[r.status],
          amountMinor: r.amount_minor,
          updatedAt: r.updated_at,
          decisionComment: repos.refunds.getDecision(r.id)?.comment ?? null,
        }));
        return [JSON.stringify({ refunds: list }), { kind: "refund_progress", refunds: list }];
      } catch (e) {
        return toolUnavailable(repos, ctx, "get_refund_progress", e);
      }
    },
    {
      name: "get_refund_progress",
      description: "查询当前客户的退款申请及审核进度。",
      schema: z.object({}),
      responseFormat: "content_and_artifact",
    },
  ) as unknown as DynamicStructuredTool;
}

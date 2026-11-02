// 本地工具：知识库检索（SPEC §F.3）。
import { tool, type DynamicStructuredTool, type ToolRuntime } from "@langchain/core/tools";
import { z } from "zod";
import type { Repos } from "../../repos/interfaces";
import type { KnowledgeService } from "../../services/knowledge";
import { agentContextSchema, readContext } from "../context";
import { toolUnavailable } from "../run-guard";

export function createSearchKnowledgeTool(knowledge: KnowledgeService, repos?: Repos): DynamicStructuredTool {
  return tool(
    async ({ query }, runtime: ToolRuntime<unknown, typeof agentContextSchema>) => {
      const ctx = readContext(runtime);
      try {
        repos?.logs.write({
          scope: "conversation",
          refId: ctx.conversationId,
          node: "search_knowledge",
          event: "tool_call",
          detail: { runId: ctx.runId, args: { query } },
        });
        const hits = knowledge.search(query);
        if (hits.length === 0) {
          return [JSON.stringify({ found: false, message: "知识库中没有找到相关依据" }), { kind: "knowledge", hits: [] }];
        }
        const content = JSON.stringify({
          found: true,
          hits: hits.map((h) => ({ title: h.title, version: h.version, snippet: h.snippet })),
        });
        return [content, { kind: "knowledge", hits }];
      } catch (e) {
        return toolUnavailable(repos, ctx, "search_knowledge", e);
      }
    },
    {
      name: "search_knowledge",
      description:
        "在企业知识库中检索产品使用、支付异常、退款政策、物流、账号、发票等知识。回答此类问题前必须调用。返回命中条目的标题、版本与摘要；没有命中表示无依据。",
      schema: z.object({ query: z.string().min(1).max(200).describe("客户的问题或检索关键词") }),
      responseFormat: "content_and_artifact",
    },
  ) as unknown as DynamicStructuredTool;
}

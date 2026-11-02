// MCP 接入与可信上下文注入（SPEC §F.5）。
// 模型只能看到 MCP_MODEL_SCHEMAS（不含 customer_id/context_token）；执行时由服务端用可信上下文覆盖。
import { createRequire } from "node:module";
import path from "node:path";
import { ToolMessage } from "@langchain/core/messages";
import { tool, type DynamicStructuredTool, type ToolRuntime } from "@langchain/core/tools";
import { MCPAdapter } from "@langchain/mcp-adapters";
import { z } from "zod";
import { signContextToken } from "../../../mcp-server/auth";
import type { AppConfig } from "../../config";
import type { Repos } from "../../repos/interfaces";
import { PROJECT_ROOT } from "../../util";
import { agentContextSchema, readContext } from "../context";

const require = createRequire(import.meta.url);

export interface McpRuntime {
  adapter: MCPAdapter;
  rawTools: DynamicStructuredTool[];
  tools: DynamicStructuredTool[];
  close(): Promise<void>;
}

export const MCP_MODEL_SCHEMAS = {
  orders_list_orders: z.object({}),
  orders_get_order: z.object({ order_id: z.string().min(1).describe("订单号，例如 ORD-1001") }),
  orders_get_payment_status: z.object({ order_id: z.string().min(1).describe("订单号，例如 ORD-1001") }),
  orders_get_refund_status: z.object({
    order_id: z.string().optional().describe("订单号"),
    refund_request_id: z.string().optional().describe("退款申请编号，例如 RF-20261102-1A2B3C"),
  }),
};

const REQUIRED_TOOLS = Object.keys(MCP_MODEL_SCHEMAS);

/**
 * MCP 子进程环境变量白名单：只传 PATH、HOME、NODE_OPTIONS（若有）、DB_PATH、MCP_SHARED_SECRET，
 * 不继承父进程的 ANTHROPIC_API_KEY / OPENAI_API_KEY 等敏感变量。
 */
export function buildMcpChildEnv(
  config: Pick<AppConfig, "dbPath" | "mcpSharedSecret">,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "NODE_OPTIONS"]) {
    const v = source[k];
    if (typeof v === "string") env[k] = v;
  }
  env.DB_PATH = config.dbPath;
  env.MCP_SHARED_SECRET = config.mcpSharedSecret;
  return env;
}

export async function startMcp(config: AppConfig, deps: { repos: Repos }): Promise<McpRuntime> {
  const adapter = new MCPAdapter({
    servers: {
      orders: {
        command: process.execPath,
        args: [require.resolve("tsx/cli"), path.join(PROJECT_ROOT, "mcp-server/index.ts")],
        env: buildMcpChildEnv(config),
        cwd: PROJECT_ROOT,
        stderr: "inherit",
      },
    },
  });
  let rawTools: DynamicStructuredTool[];
  try {
    rawTools = (await adapter.listTools()) as DynamicStructuredTool[];
    const names = new Set(rawTools.map((t) => t.name));
    const missing = REQUIRED_TOOLS.filter((n) => !names.has(n));
    if (missing.length > 0) throw new Error(`MCP 服务缺少工具：${missing.join("、")}`);
  } catch (e) {
    await adapter.close().catch(() => undefined);
    throw e;
  }
  // 只暴露约定的四个工具，顺序固定
  const byName = new Map(rawTools.map((t) => [t.name, t]));
  const ordered = REQUIRED_TOOLS.map((n) => byName.get(n)!);
  const tools = ordered.map((raw) => wrapMcpTool(raw, { secret: config.mcpSharedSecret, repos: deps.repos }));
  return { adapter, rawTools: ordered, tools, close: () => adapter.close() };
}

export function wrapMcpTool(raw: DynamicStructuredTool, deps: { secret: string; repos: Repos }): DynamicStructuredTool {
  const schema = MCP_MODEL_SCHEMAS[raw.name as keyof typeof MCP_MODEL_SCHEMAS];
  if (!schema) throw new Error(`未知的 MCP 工具：${raw.name}`);
  return tool(
    async (args: Record<string, unknown>, runtime: ToolRuntime<unknown, typeof agentContextSchema>) => {
      const ctx = readContext(runtime);
      // 双保险：模型传入的身份字段一律丢弃，以可信上下文覆盖
      const { customer_id: _c, context_token: _t, ...modelArgs } = args;
      const callArgs = {
        ...modelArgs,
        customer_id: ctx.customerId,
        context_token: signContextToken(deps.secret, ctx.customerId),
      };
      const toolCallId = runtime.toolCall?.id ?? runtime.toolCallId ?? `mcp_${raw.name}`;
      deps.repos.logs.write({
        scope: "conversation",
        refId: ctx.conversationId,
        node: raw.name,
        event: "mcp_tool_call",
        detail: { runId: ctx.runId, args: modelArgs },
      });
      try {
        // 关键：带 toolCall 的 config → 成功返回带 artifact 的 ToolMessage；MCP isError 返回 status="error" 的 ToolMessage（不抛异常）
        return await raw.invoke(callArgs, { toolCall: { id: toolCallId, name: raw.name, args: callArgs, type: "tool_call" } });
      } catch (e) {
        console.error(`[mcp] 调用 ${raw.name} 失败：`, e);
        return new ToolMessage({ status: "error", content: "UNAVAILABLE: 订单服务暂时不可用", tool_call_id: toolCallId, name: raw.name });
      }
    },
    { name: raw.name, description: raw.description, schema },
  ) as unknown as DynamicStructuredTool;
}

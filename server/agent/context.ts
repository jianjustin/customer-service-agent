// Agent 可信上下文（SPEC §A.7）。由服务端在每次 invokeTurn 时注入，模型不可见、不可伪造。
import { z } from "zod";

export const agentContextSchema = z.object({
  customerId: z.string().min(1),
  ticketId: z.string().min(1),
  conversationId: z.string().min(1),
  runId: z.number().int(),
});
export type AgentContext = z.infer<typeof agentContextSchema>;

/** 从工具运行时读取可信上下文；缺失或不合法时抛错 */
export function readContext(runtime: { context?: unknown }): AgentContext {
  const parsed = agentContextSchema.safeParse(runtime.context);
  if (!parsed.success) throw new Error("缺少可信上下文");
  return parsed.data;
}

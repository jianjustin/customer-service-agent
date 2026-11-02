// Agent 运行时的类型契约（批次 2 先落地接口，使 ConversationService / SummaryService 可独立编译与测试）。
// 批次 3 在 server/agent/agent.ts 实现 createAgentRuntime 时：
//   - `AgentRuntime` / `TurnResult` 沿用此处定义（agent.ts 可 `export type { ... } from "./types"` 再导出）；
//   - `ModelInfo` 沿用此处定义（model.ts 再导出）。
import type { BaseMessage } from "@langchain/core/messages";
import type { MessageSource } from "../domain/types";
import type { AgentContext } from "./context";

export interface ModelInfo {
  mode: "mock" | "anthropic" | "openai";
  label: string;
  modelName: string | null;
  reason: string | null;
}

export interface TurnResult {
  finalText: string;
  sources: MessageSource[];
  turnMessages: BaseMessage[];
}

export interface AgentRuntime {
  invokeTurn(input: { threadId: string; humanMessageId: string; content: string; context: AgentContext }): Promise<TurnResult>;
  getThreadMessages(threadId: string): Promise<BaseMessage[]>;
  /**
   * 丢弃一轮对话：把 humanMessageId 对应的 HumanMessage 及其之后的全部消息从线程中移除。
   * 用于被抑制（接管 / 结单后完成）的 AI run，避免其回复与工具结果残留在线程里成为后续轮次的上下文。返回移除条数。
   */
  discardTurn(threadId: string, humanMessageId: string): Promise<number>;
  /**
   * 修复悬空 tool_call：若线程末尾是带 tool_calls 的 AIMessage 且缺少对应 ToolMessage（进程崩溃所致），
   * 为每个缺失的 tool_call 追加 status="error" 的 ToolMessage。返回补齐条数。
   */
  repairDanglingToolCalls(threadId: string): Promise<number>;
  /** 低层写入：把消息追加到线程（asNode 缺省由 LangGraph 推断）。主要供恢复逻辑与测试构造线程状态 */
  appendThreadMessages(threadId: string, messages: BaseMessage[], asNode?: string): Promise<void>;
  modelInfo: ModelInfo;
}

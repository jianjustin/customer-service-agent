// Agent 运行时（SPEC §F.2）：createAgent + contextSchema + SqliteSaver checkpointer。
import type { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, RemoveMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import { createAgent, HumanMessage, type initChatModel } from "langchain";
import { agentContextSchema, type AgentContext } from "./context";
import { collectSources, EMPTY_REPLY_TEXT, finalAiText, sliceTurn } from "./extract";
import { SYSTEM_PROMPT } from "./prompt";
import type { AgentRuntime, ModelInfo, TurnResult } from "./types";

export type { AgentRuntime, TurnResult } from "./types";

export function createAgentRuntime(deps: {
  model: BaseChatModel | Awaited<ReturnType<typeof initChatModel>>;
  tools: DynamicStructuredTool[];
  checkpointer: SqliteSaver;
  modelInfo: ModelInfo;
}): AgentRuntime {
  const agent = createAgent({
    model: deps.model as BaseChatModel,
    tools: deps.tools,
    systemPrompt: SYSTEM_PROMPT,
    checkpointer: deps.checkpointer,
    contextSchema: agentContextSchema,
  });

  // createAgent 的泛型推断使 getState / updateState 的类型退化为 never，这里显式声明所需形状
  const getState = agent.getState.bind(agent) as unknown as (cfg: {
    configurable: { thread_id: string };
  }) => Promise<{ values?: { messages?: BaseMessage[] } }>;
  const updateState = agent.updateState.bind(agent) as unknown as (
    cfg: { configurable: { thread_id: string } },
    values: { messages: BaseMessage[] },
    asNode?: string,
  ) => Promise<unknown>;
  const threadMessages = async (threadId: string): Promise<BaseMessage[]> =>
    (await getState({ configurable: { thread_id: threadId } })).values?.messages ?? [];

  return {
    modelInfo: deps.modelInfo,

    async invokeTurn(input: { threadId: string; humanMessageId: string; content: string; context: AgentContext }): Promise<TurnResult> {
      const human = new HumanMessage({ content: input.content, id: input.humanMessageId });
      const result = await agent.invoke(
        { messages: [human] },
        { configurable: { thread_id: input.threadId }, context: input.context, recursionLimit: 25 },
      );
      const turn = sliceTurn(result.messages as BaseMessage[], input.humanMessageId);
      const text = finalAiText(turn).trim() || EMPTY_REPLY_TEXT;
      return { finalText: text, sources: collectSources(turn, text), turnMessages: turn };
    },

    async getThreadMessages(threadId: string): Promise<BaseMessage[]> {
      return threadMessages(threadId);
    },

    async discardTurn(threadId: string, humanMessageId: string): Promise<number> {
      const all = await threadMessages(threadId);
      const idx = all.findIndex((m) => m.id === humanMessageId);
      if (idx < 0) return 0;
      // LangGraph 的 messages reducer 会为缺 id 的消息分配 id，持久化后的消息都带 id；仍缺 id 的无法按 id 移除，跳过
      const removals = all
        .slice(idx)
        .filter((m): m is BaseMessage & { id: string } => typeof m.id === "string" && m.id.length > 0)
        .map((m) => new RemoveMessage({ id: m.id }));
      if (removals.length === 0) return 0;
      await updateState({ configurable: { thread_id: threadId } }, { messages: removals });
      return removals.length;
    },

    async repairDanglingToolCalls(threadId: string): Promise<number> {
      const all = await threadMessages(threadId);
      // 从末尾向前跳过连续的 ToolMessage，定位发起 tool_calls 的 AIMessage
      let i = all.length - 1;
      const answered = new Set<string>();
      while (i >= 0 && ToolMessage.isInstance(all[i]!)) {
        answered.add((all[i] as ToolMessage).tool_call_id);
        i--;
      }
      const last = i >= 0 ? all[i]! : undefined;
      if (!last || !AIMessage.isInstance(last)) return 0;
      const missing = (last.tool_calls ?? []).filter((tc) => tc.id !== undefined && !answered.has(tc.id));
      if (missing.length === 0) return 0;
      const fixes = missing.map(
        (tc) =>
          new ToolMessage({
            content: "工具调用因服务重启被中断",
            status: "error",
            tool_call_id: tc.id!,
            name: tc.name,
          }),
      );
      // 以 tools 节点身份写入：与正常工具执行完成后的线程状态一致
      await updateState({ configurable: { thread_id: threadId } }, { messages: fixes }, "tools");
      return fixes.length;
    },

    async appendThreadMessages(threadId: string, messages: BaseMessage[], asNode?: string): Promise<void> {
      await updateState({ configurable: { thread_id: threadId } }, { messages }, asNode);
    },
  };
}

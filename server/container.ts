// 依赖装配（SPEC §A.9，构建顺序照 10 步）。startMcp=false 时不启动 MCP、agent=null。
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createAgentRuntime } from "./agent/agent";
import { createChatModel } from "./agent/model";
import { createSummaryService, type SummaryService } from "./agent/summary";
import { createHandoverTool } from "./agent/tools/handover";
import { createSearchKnowledgeTool } from "./agent/tools/knowledge";
import { startMcp, type McpRuntime } from "./agent/tools/mcp";
import { createRefundProgressTool, createSubmitRefundTool } from "./agent/tools/refund";
import type { AgentRuntime, ModelInfo } from "./agent/types";
import {
  createChannelRegistry,
  createFeishuChannel,
  createWebChannel,
  createWechatChannel,
  type ChannelRegistry,
} from "./channels";
import { loadConfig, type AppConfig } from "./config";
import { openDb, type Db } from "./db/connection";
import { migrate } from "./db/migrate";
import { seed } from "./db/seed";
import { createCrashPoints, type CrashPointName } from "./graphs/refund/crash";
import { buildRefundGraph, type CompiledRefundGraph } from "./graphs/refund/graph";
import { createRefundRunner, type RefundRunner } from "./graphs/refund/runner";
import { createRepos } from "./repos";
import type { Repos } from "./repos/interfaces";
import { createAssignmentService, type AssignmentService } from "./services/assignment";
import { createConversationService, type ConversationService } from "./services/conversation";
import { createHandoverService, type HandoverService } from "./services/handover";
import { createKnowledgeService, type KnowledgeService } from "./services/knowledge";
import { KeyedMutex } from "./services/locks";
import { createOutboxWorker, type OutboxWorker } from "./services/outbox";
import { createRefundService, type RefundService } from "./services/refunds";
import { createTicketService, type TicketService } from "./services/tickets";

export interface ContainerOptions {
  dbPath: string;
  checkpointPath: string;
  /** 覆盖 loadConfig() 结果（测试用） */
  config?: Partial<AppConfig>;
  /** 默认 true；false 时 agent=null（AI 不回复，仅用于纯业务测试） */
  startMcp?: boolean;
  /** 默认 false（server/index.ts 传 true） */
  startOutboxWorker?: boolean;
  crashPoints?: Iterable<CrashPointName>;
  /** MockChatModel 每次 _generate 前等待（批次 3 使用） */
  mockDelayMs?: number;
  /** 测试注入脚本模型（FakeToolCallingModel 等） */
  modelOverride?: BaseChatModel;
  faults?: {
    webChannelFailTimes?: number;
    refundFailure?: (requestId: string, attempt: number) => string | null;
  };
}

export interface Container {
  config: AppConfig;
  db: Db;
  checkpointDb: Db;
  checkpointer: SqliteSaver;
  repos: Repos;
  locks: KeyedMutex;
  channels: ChannelRegistry;
  services: {
    assignment: AssignmentService;
    tickets: TicketService;
    conversation: ConversationService;
    handover: HandoverService;
    knowledge: KnowledgeService;
    refunds: RefundService;
    summary: SummaryService;
  };
  outbox: OutboxWorker;
  refundGraph: CompiledRefundGraph;
  refundRunner: RefundRunner;
  mcp: McpRuntime | null;
  agent: AgentRuntime | null;
  modelInfo: ModelInfo;
  /** 顺序：outbox.stop → 等待所有 locks 空闲(最多 5s) → mcp.close → db.close → checkpointDb.close */
  close(): Promise<void>;
}

export async function buildContainer(opts: ContainerOptions): Promise<Container> {
  // 1. 配置
  const config: AppConfig = { ...loadConfig(), ...opts.config, dbPath: opts.dbPath, checkpointPath: opts.checkpointPath };

  // 2. 业务库
  const db = openDb(config.dbPath);
  migrate(db);
  seed(db);

  // 3. checkpoint 库（SqliteSaver 没有 close()，关闭时关底层 db）
  const checkpointDb = openDb(config.checkpointPath);
  const checkpointer = new SqliteSaver(checkpointDb);

  // 4. repos / locks / channels
  const repos = createRepos(db);
  const locks = new KeyedMutex();
  const channels = createChannelRegistry([
    createWebChannel(repos, db, { failTimes: opts.faults?.webChannelFailTimes }),
    createWechatChannel(),
    createFeishuChannel(),
  ]);

  // 5. 服务（与 SPEC 顺序的小偏离：summary 只依赖 repos 与 getAgent 闭包，提前到 handover 之前创建，
  //    因为接管/转人工后需要刷新摘要）
  let agent: AgentRuntime | null = null;
  const summary = createSummaryService({ repos, getAgent: () => agent });
  const assignment = createAssignmentService({ db, repos });
  const tickets = createTicketService({ db, repos, assignment });
  const handover = createHandoverService({ db, repos, tickets, summary });
  const knowledge = createKnowledgeService(repos.knowledge.listAll());

  // 6. 退款：Graph → Runner → 服务
  const refundGraph = buildRefundGraph(
    { db, repos, crash: createCrashPoints(opts.crashPoints), faults: { refundFailure: opts.faults?.refundFailure } },
    checkpointer,
  );
  const refundRunner = createRefundRunner({ graph: refundGraph, checkpointer, repos, locks });
  const refunds = createRefundService({ db, repos, runner: refundRunner, locks });

  // 7. MCP + Agent
  // modelInfo 始终由 createChatModel 计算；startMcp=false 时只算 info，不创建 agent / 不启动 MCP。
  const { model, info: modelInfo } = await createChatModel(config, { mockDelayMs: opts.mockDelayMs, override: opts.modelOverride });
  let mcp: McpRuntime | null = null;
  if (opts.startMcp !== false) {
    mcp = await startMcp(config, { repos });
    try {
      const tools = [
        createSearchKnowledgeTool(knowledge, repos),
        ...mcp.tools,
        createSubmitRefundTool(refunds, repos),
        createRefundProgressTool(refunds, repos),
        createHandoverTool(handover, repos),
      ];
      agent = createAgentRuntime({ model, tools, checkpointer, modelInfo });
    } catch (e) {
      await mcp.close().catch(() => undefined);
      throw e;
    }
  }

  // 8. 会话服务（agent 在上面的闭包里被 summary 引用；这里按最终值传入）
  const conversation = createConversationService({ db, repos, locks, tickets, agent, summary });

  // 9. outbox
  const outbox = createOutboxWorker({
    repos,
    channels,
    pollMs: config.outboxPollMs,
    maxAttempts: config.outboxMaxAttempts,
  });
  if (opts.startOutboxWorker) outbox.start();

  // 10. 返回（恢复由 server/index.ts 或测试显式调用，这里不做）
  let closed = false;
  return {
    config,
    db,
    checkpointDb,
    checkpointer,
    repos,
    locks,
    channels,
    services: { assignment, tickets, conversation, handover, knowledge, refunds, summary },
    outbox,
    refundGraph,
    refundRunner,
    mcp,
    agent,
    modelInfo,
    async close() {
      if (closed) return;
      closed = true;
      await outbox.stop();
      await Promise.race([locks.idleAll(), new Promise<void>((r) => setTimeout(r, 5000))]);
      if (mcp) await mcp.close();
      db.close();
      checkpointDb.close();
    },
  };
}

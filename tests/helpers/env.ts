// 测试基础设施（docs/SPEC.md §K.1）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildContainer, type Container, type ContainerOptions } from "../../server/container";
import type { MessageRow } from "../../server/domain/types";
import type { IntakeResult, RunOutcome } from "../../server/services/conversation";

export type { Container, ContainerOptions };

export interface TestEnv {
  dir: string;
  dbPath: string;
  checkpointPath: string;
  cleanup(): void;
}

/** 创建独立临时目录与 db 路径；cleanup 删除整个目录（含 WAL 附属文件） */
export function makeTestEnv(): TestEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csa-test-"));
  return {
    dir,
    dbPath: path.join(dir, "app.db"),
    checkpointPath: path.join(dir, "checkpoints.db"),
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 默认配置的测试容器：mock 模型、test-secret、快速 outbox 轮询（不自动启动 worker） */
export async function buildTestContainer(env: TestEnv, opts: Partial<ContainerOptions> = {}): Promise<Container> {
  return buildContainer({
    dbPath: env.dbPath,
    checkpointPath: env.checkpointPath,
    config: { modelProvider: "mock", mcpSharedSecret: "test-secret", outboxPollMs: 50, outboxMaxAttempts: 8 },
    startMcp: true,
    startOutboxWorker: false,
    ...opts,
  });
}

/** “重启”：丢弃全部内存对象，用同一组 db 文件重建 */
export async function restart(c: Container, env: TestEnv, opts: Partial<ContainerOptions> = {}): Promise<Container> {
  await c.close();
  return buildTestContainer(env, opts);
}

/** 调 handleCustomerMessage，再等待 AI run 完成 */
export async function sendAndWait(
  c: Container,
  customerId: string,
  content: string,
  extra: { ticketId?: string; newTicket?: boolean; clientMessageId?: string } = {},
): Promise<IntakeResult & { outcome: RunOutcome | null }> {
  const r = c.services.conversation.handleCustomerMessage({
    customerId,
    content,
    clientMessageId: extra.clientMessageId ?? `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
    ticketId: extra.ticketId,
    newTicket: extra.newTicket,
  });
  const outcome = r.aiRun ? await r.aiRun : null;
  return { ...r, outcome };
}

export function lastAiMessage(c: Container, conversationId: string): MessageRow | undefined {
  const rows = c.repos.messages.list(conversationId).filter((m) => m.sender_type === "ai");
  return rows[rows.length - 1];
}

export async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 10000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// 退款 Graph Runner（SPEC §H.6）：驱动循环 + 启动恢复。
// 所有 invoke/getState 都在 locks.withLock("refund:"+id) 内；invoke 抛出的异常（含 SimulatedCrash）向上抛。
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { Command } from "@langchain/langgraph";
import type { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { RefundRequestRow, RefundStatus } from "../../domain/types";
import type { Repos } from "../../repos/interfaces";
import type { KeyedMutex } from "../../services/locks";
import type { CompiledRefundGraph } from "./graph";

export type FlowOutcome = { status: "waiting" | "completed" | "max_iterations"; requestStatus: RefundStatus; steps: string[] };
export interface GraphInspection {
  threadId: string;
  hasCheckpoint: boolean;
  next: string[];
  interrupts: Array<{ id?: string; value?: unknown }>;
  values: Record<string, unknown> | null;
}
export interface RecoveryReportItem {
  requestId: string;
  before: { hasCheckpoint: boolean; next: string[]; interrupted: boolean };
  outcome: FlowOutcome | null;
  error: string | null;
}
export interface RefundRunner {
  drive(requestId: string, reason: "submit" | "decision" | "retry" | "recovery"): Promise<FlowOutcome>;
  inspect(requestId: string): Promise<GraphInspection>;
  recoverRefundFlows(): Promise<RecoveryReportItem[]>;
}

const MAX_ITERATIONS = 6;

/**
 * 在“空”的 AsyncLocalStorage 上下文中运行。
 * 退款 Graph 可能从 Agent 的工具调用里同步驱动（submit_refund_request → refunds.submit → drive）。
 * 此时 LangGraph 会从 ALS 继承外层 Agent Graph 的 runnable config（checkpointer/scratchpad 等），
 * 把退款 Graph 当成子图：interrupt 作为 GraphInterrupt 异常向上抛，且检查点不会写入退款线程。
 * 退款流程是独立线程，必须与调用方的 Graph 上下文隔离。
 */
function isolated<T>(fn: () => Promise<T>): Promise<T> {
  return AsyncLocalStorageProviderSingleton.getInstance().run(undefined, fn) as Promise<T>;
}

export function createRefundRunner(deps: {
  graph: CompiledRefundGraph;
  checkpointer: SqliteSaver;
  repos: Repos;
  locks: KeyedMutex;
}): RefundRunner {
  const { graph, checkpointer, repos, locks } = deps;
  const lockKey = (id: string) => "refund:" + id;
  const cfgOf = (req: RefundRequestRow) => ({ configurable: { thread_id: req.thread_id }, durability: "sync" as const });

  function mustGet(requestId: string): RefundRequestRow {
    const req = repos.refunds.get(requestId);
    if (!req) throw new Error(`退款申请不存在：${requestId}`);
    return req;
  }

  /** 不加锁的检查（调用方已持锁） */
  async function inspectUnlocked(requestId: string): Promise<GraphInspection> {
    const req = mustGet(requestId);
    const tuple = await checkpointer.getTuple({ configurable: { thread_id: req.thread_id } });
    if (!tuple) return { threadId: req.thread_id, hasCheckpoint: false, next: [], interrupts: [], values: null };
    const snap = await graph.getState(cfgOf(req));
    const interrupts = snap.tasks.flatMap((t) => t.interrupts ?? []).map((i) => ({ id: i.id, value: i.value }));
    return {
      threadId: req.thread_id,
      hasCheckpoint: true,
      next: [...snap.next],
      interrupts,
      values: (snap.values ?? null) as Record<string, unknown> | null,
    };
  }

  async function driveUnlocked(requestId: string, reason: string): Promise<FlowOutcome> {
    const steps: string[] = [];
    const runnerLog = (event: string, detail: Record<string, unknown>) =>
      repos.logs.write({ scope: "refund", refId: requestId, node: "runner", event, detail: { reason, ...detail } });

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const req = mustGet(requestId);
      const cfg = cfgOf(req);
      const hasCheckpoint = (await checkpointer.getTuple({ configurable: { thread_id: req.thread_id } })) !== undefined;

      if (!hasCheckpoint) {
        if (req.flow_completed_at != null) return { status: "completed", requestStatus: req.status, steps };
        steps.push("start");
        runnerLog("start", { phase: "begin", threadId: req.thread_id });
        await graph.invoke(
          { requestId, attempt: req.attempt, mode: req.attempt > 1 ? "retry" : "initial" },
          cfg,
        );
        runnerLog("start", { phase: "end" });
        continue;
      }

      const snap = await graph.getState(cfg);
      const interrupts = snap.tasks.flatMap((t) => t.interrupts ?? []);
      if (interrupts.length > 0) {
        const dec = repos.refunds.getDecision(requestId);
        if (!dec) return { status: "waiting", requestStatus: req.status, steps };
        steps.push("resume");
        runnerLog("resume", { phase: "begin", decisionId: dec.id });
        // resume 值只是信号；执行节点只信任 refund_decisions
        await graph.invoke(
          new Command({ resume: { decisionId: dec.id, source: reason === "recovery" ? "recovery" : "decision" } }),
          cfg,
        );
        runnerLog("resume", { phase: "end" });
        continue;
      }

      if (snap.next.length > 0) {
        steps.push("continue");
        runnerLog("continue", { phase: "begin", next: [...snap.next] });
        await graph.invoke(null, cfg);
        runnerLog("continue", { phase: "end" });
        continue;
      }

      // 线程已结束
      if (req.flow_completed_at == null) {
        steps.push("reenter");
        runnerLog("reenter", { phase: "begin" });
        await graph.invoke({ requestId, attempt: req.attempt, mode: "recover" }, cfg);
        runnerLog("reenter", { phase: "end" });
        continue;
      }
      return { status: "completed", requestStatus: req.status, steps };
    }
    const last = mustGet(requestId);
    runnerLog("max_iterations", { steps });
    return { status: "max_iterations", requestStatus: last.status, steps };
  }

  const drive: RefundRunner["drive"] = (requestId, reason) =>
    locks.withLock(lockKey(requestId), () => isolated(() => driveUnlocked(requestId, reason)));

  const inspect: RefundRunner["inspect"] = (requestId) => locks.withLock(lockKey(requestId), () => isolated(() => inspectUnlocked(requestId)));

  async function recoverRefundFlows(): Promise<RecoveryReportItem[]> {
    const report: RecoveryReportItem[] = [];
    for (const req of repos.refunds.listFlowOpen()) {
      const item: RecoveryReportItem = {
        requestId: req.id,
        before: { hasCheckpoint: false, next: [], interrupted: false },
        outcome: null,
        error: null,
      };
      try {
        const before = await inspect(req.id);
        item.before = { hasCheckpoint: before.hasCheckpoint, next: before.next, interrupted: before.interrupts.length > 0 };
        item.outcome = await drive(req.id, "recovery");
      } catch (e) {
        item.error = e instanceof Error ? e.message : String(e);
        console.error(`[recovery] 退款流程 ${req.id} 恢复失败：`, item.error);
      }
      try {
        repos.logs.write({
          scope: "refund",
          refId: req.id,
          node: "recovery",
          event: item.error ? "error" : "recovered",
          detail: { before: item.before, outcome: item.outcome, error: item.error },
        });
      } catch {
        // 日志失败不影响继续
      }
      report.push(item);
    }
    return report;
  }

  return { drive, inspect, recoverRefundFlows };
}

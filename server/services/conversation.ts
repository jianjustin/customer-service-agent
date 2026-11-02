// 会话服务：客户消息接入、AI run 调度与写回（generation 抑制）、客服回复、重启恢复（SPEC §E.3 / §E.7）。
import type { Db } from "../db/connection";
import { tx } from "../db/connection";
import type { AgentRuntime } from "../agent/types";
import type { SummaryService } from "../agent/summary";
import type { AiRunStatus, ConversationRow, MessageRow, TicketRow } from "../domain/types";
import { AppError } from "../errors";
import type { Repos } from "../repos/interfaces";
import { nowIso } from "../util";
import type { KeyedMutex } from "./locks";
import type { TicketService } from "./tickets";

export type RunOutcome = { runId: number; status: AiRunStatus; replyMessageId: number | null };

export interface IntakeResult {
  duplicate: boolean;
  ticket: TicketRow;
  conversation: ConversationRow;
  message: MessageRow;
  aiRunId: number | null;
  aiRun: Promise<RunOutcome> | null;
}

export interface ConversationService {
  /** 同步单事务；事务提交后才排入 AI run（HTTP 路由不 await aiRun，测试可 await） */
  handleCustomerMessage(input: {
    customerId: string;
    content: string;
    clientMessageId: string;
    ticketId?: string;
    newTicket?: boolean;
  }): IntakeResult;
  /** 在 locks.withLock(`conv:${conversationId}`) 内执行 */
  processRun(runId: number): Promise<RunOutcome>;
  agentReply(seatId: string, ticketId: string, content: string, clientMessageId: string): { message: MessageRow; duplicate: boolean };
  idle(conversationId: string): Promise<void>;
  /**
   * 启动时：running → failed('interrupted_by_restart')，修复线程中悬空的 tool_call 并通知客户；queued → 重新调度。
   * 同步部分（改状态、写系统消息）在返回 Promise 前已完成；线程修复在会话锁内异步执行，返回的 Promise 在其完成后 resolve。
   */
  recoverRuns(): Promise<void>;
}

function isUniqueViolation(e: unknown): boolean {
  const code = e && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}

export function createConversationService(deps: {
  db: Db;
  repos: Repos;
  locks: KeyedMutex;
  tickets: TicketService;
  agent: AgentRuntime | null;
  summary: SummaryService;
}): ConversationService {
  const { db, repos, locks, tickets, agent, summary } = deps;

  const lockKey = (conversationId: string) => `conv:${conversationId}`;

  /** 让客服列表（按 updated_at 倒序）反映最新动态 */
  const touchTicket = (ticketId: string, at: string) => {
    db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ? AND updated_at < ?").run(at, ticketId, at);
  };

  function duplicateResult(customerId: string, clientMessageId: string): IntakeResult | null {
    const dup = repos.messages.findCustomerMessageByClientId(customerId, "c:" + clientMessageId);
    if (!dup) return null;
    const conversation = repos.conversations.get(dup.conversation_id)!;
    const ticket = repos.tickets.get(conversation.ticket_id)!;
    return { duplicate: true, ticket, conversation, message: dup, aiRunId: null, aiRun: null };
  }

  /** E.3 processRunInner：必须在 conv 锁内调用；异常一律收敛为 failed，永不 reject */
  async function processRunInner(runId: number): Promise<RunOutcome> {
    try {
      return await processRunUnsafe(runId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[conversation] ai run ${runId} 处理异常：`, e);
      try {
        repos.aiRuns.fail(runId, msg, nowIso());
      } catch {
        // 忽略
      }
      const run = repos.aiRuns.get(runId);
      return { runId, status: run?.status ?? "failed", replyMessageId: run?.reply_message_id ?? null };
    }
  }

  async function processRunUnsafe(runId: number): Promise<RunOutcome> {
    const outcome = (): RunOutcome => {
      const r = repos.aiRuns.get(runId)!;
      return { runId, status: r.status, replyMessageId: r.reply_message_id };
    };

    // 1. queued → running；若会话已非 ai 或 generation 已变化则直接取消
    const started = tx(db, () => {
      const at = nowIso();
      if (repos.aiRuns.markRunning(runId, at) === 0) return false;
      const run = repos.aiRuns.get(runId)!;
      const conv = repos.conversations.get(run.conversation_id)!;
      if (conv.handling_mode !== "ai" || run.generation !== conv.ai_generation) {
        db.prepare("UPDATE ai_runs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'running'").run(at, runId);
        return false;
      }
      return true;
    });
    if (!started) return outcome();

    const run = repos.aiRuns.get(runId)!;
    const conv = repos.conversations.get(run.conversation_id)!;
    const trigger = repos.messages.get(run.trigger_message_id)!;

    // 2. 无 agent（startMcp=false 或批次 2）：记为 failed
    if (agent === null) {
      repos.aiRuns.fail(runId, "agent_unavailable", nowIso());
      return outcome();
    }

    // 3. 调用 Agent（慢操作，事务之外）
    let turn: Awaited<ReturnType<AgentRuntime["invokeTurn"]>>;
    try {
      turn = await agent.invokeTurn({
        threadId: conv.thread_id,
        humanMessageId: "msg_" + trigger.id,
        content: trigger.content,
        context: { customerId: conv.customer_id, ticketId: conv.ticket_id, conversationId: conv.id, runId },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[conversation] ai run ${runId} 调用 agent 失败：`, err);
      tx(db, () => {
        const at = nowIso();
        repos.aiRuns.fail(runId, String(msg), at);
        const cur = repos.conversations.get(conv.id)!;
        if (cur.handling_mode === "ai" && cur.ai_generation === run.generation) {
          repos.messages.insert({
            conversationId: conv.id,
            senderType: "system",
            senderId: null,
            content: "抱歉，智能助手暂时无法回复，请稍后再试或申请转人工。",
            at,
          });
        }
      });
      return outcome();
    }

    // 4. 写回事务：接管 / 结束 / generation 变化都会让回复被抑制
    tx(db, () => {
      const at = nowIso();
      const curRun = repos.aiRuns.get(runId)!;
      const curConv = repos.conversations.get(conv.id)!;
      const ticket = repos.tickets.get(conv.ticket_id)!;
      if (
        curConv.handling_mode === "ai" &&
        curRun.status === "running" &&
        curRun.generation === curConv.ai_generation &&
        ticket.status !== "closed"
      ) {
        const msg = repos.messages.insert({
          conversationId: conv.id,
          senderType: "ai",
          senderId: null,
          content: turn.finalText,
          sources: turn.sources,
          aiRunId: runId,
          at,
        });
        if (repos.aiRuns.complete(runId, msg.id, at) !== 1) throw new Error("ai run 状态已变化，写回回滚");
        if (curRun.handover_requested === 1) {
          repos.conversations.takeover(conv.id, at); // handling_mode='human'，generation+1
          repos.messages.insert({
            conversationId: conv.id,
            senderType: "system",
            senderId: null,
            content: "已为您转接人工客服，请稍候。",
            at,
          });
        }
        touchTicket(conv.ticket_id, at);
      } else {
        repos.aiRuns.suppress(runId, at);
        repos.logs.write({
          scope: "conversation",
          refId: conv.id,
          node: "ai_run",
          event: "suppressed",
          detail: {
            runId,
            runGeneration: curRun.generation,
            convGeneration: curConv.ai_generation,
            handlingMode: curConv.handling_mode,
          },
          at,
        });
      }
    });

    // 4.5 被抑制的 run：把本轮（含触发的 HumanMessage、AI 回复与工具结果）从 Agent 线程移除，
    //     否则 AI 在接管 / 结单期间“说过”的话会成为后续轮次的上下文（失败只记日志）
    if (repos.aiRuns.get(runId)?.status === "suppressed") {
      try {
        await agent.discardTurn(conv.thread_id, "msg_" + trigger.id);
      } catch (e) {
        console.error(`[conversation] ai run ${runId} 丢弃被抑制的线程消息失败：`, e);
        try {
          repos.logs.write({
            scope: "conversation",
            refId: conv.id,
            node: "ai_run",
            event: "discard_turn_failed",
            detail: { runId, error: e instanceof Error ? e.message : String(e) },
          });
        } catch {
          // 忽略
        }
      }
    }

    // 5. 回复写回后刷新摘要（失败只记日志）
    if (repos.aiRuns.get(runId)?.status === "completed") {
      try {
        await summary.refresh(conv.ticket_id);
      } catch (e) {
        console.error("[conversation] 摘要刷新失败：", e);
      }
    }
    return outcome();
  }

  function schedule(runId: number, conversationId: string): Promise<RunOutcome> {
    // 同步调用 withLock 以保证 FIFO；processRunInner 永不 reject
    return locks.withLock(lockKey(conversationId), () => processRunInner(runId));
  }

  function handleCustomerMessage(input: {
    customerId: string;
    content: string;
    clientMessageId: string;
    ticketId?: string;
    newTicket?: boolean;
  }): IntakeResult {
    const { customerId, clientMessageId } = input;
    const content = input.content.trim();
    if (content.length === 0) throw new AppError(422, "VALIDATION_ERROR", "消息内容不能为空");

    // 2. 去重（事务之前的快速路径；事务内再查一次兜底）
    const early = duplicateResult(customerId, clientMessageId);
    if (early) return early;

    let result: Omit<IntakeResult, "aiRun">;
    try {
      result = tx(db, () => {
        const at = nowIso();
        // 3. 选工单
        let ticket: TicketRow | undefined;
        let conversation: ConversationRow | undefined;
        let created = false;
        if (input.ticketId) {
          const pair = tickets.requireCustomerTicket(customerId, input.ticketId);
          if (pair.ticket.status === "closed") throw new AppError(409, "TICKET_CLOSED", "该工单已结束，请新建咨询");
          ({ ticket, conversation } = pair);
        } else if (input.newTicket !== true) {
          const open = repos.tickets.latestOpenForCustomer(customerId);
          if (open) {
            ticket = open;
            conversation = repos.conversations.getByTicket(open.id)!;
          }
        }
        // 4. 新建
        if (!ticket || !conversation) {
          ({ ticket, conversation } = tickets.createForCustomerInTx(customerId, content.slice(0, 30), at));
          created = true;
        }

        // 5. 客户消息；新建工单时其后追加分配/排队系统消息
        const message = repos.messages.insert({
          conversationId: conversation.id,
          senderType: "customer",
          senderId: customerId,
          content,
          clientMessageId: "c:" + clientMessageId,
          at,
        });
        if (created) {
          const seat = ticket.seat_id ? repos.identity.getSeat(ticket.seat_id) : undefined;
          repos.messages.insert({
            conversationId: conversation.id,
            senderType: "system",
            senderId: null,
            content: seat
              ? `已为您分配人工客服 ${seat.name}。`
              : "当前人工客服繁忙，您已进入等待队列，AI 助手将先为您服务。",
            at,
          });
        }
        touchTicket(ticket.id, at);

        // 6. 仅 AI 接待模式下创建 run
        let aiRunId: number | null = null;
        if (conversation.handling_mode === "ai") {
          aiRunId = repos.aiRuns.insert(conversation.id, message.id, conversation.ai_generation, at).id;
        }
        return {
          duplicate: false,
          ticket: repos.tickets.get(ticket.id)!,
          conversation,
          message,
          aiRunId,
        };
      });
    } catch (e) {
      // 并发下同一 clientMessageId 的唯一约束冲突：按重复处理
      if (isUniqueViolation(e)) {
        const dup = duplicateResult(customerId, clientMessageId);
        if (dup) return dup;
      }
      throw e;
    }

    // 7. 事务提交后再排入 AI run
    const aiRun = result.aiRunId !== null ? schedule(result.aiRunId, result.conversation.id) : null;
    return { ...result, aiRun };
  }

  function processRun(runId: number): Promise<RunOutcome> {
    const run = repos.aiRuns.get(runId);
    if (!run) return Promise.reject(new Error(`ai run 不存在：${runId}`));
    return schedule(runId, run.conversation_id);
  }

  function agentReply(seatId: string, ticketId: string, contentRaw: string, clientMessageId: string) {
    const content = contentRaw.trim();
    if (content.length === 0) throw new AppError(422, "VALIDATION_ERROR", "回复内容不能为空");
    return tx(db, () => {
      const at = nowIso();
      const { ticket, conversation } = tickets.requireSeatTicket(seatId, ticketId);
      if (ticket.status === "closed") throw new AppError(409, "TICKET_CLOSED", "该工单已结束");
      if (conversation.handling_mode === "ai") throw new AppError(409, "NOT_TAKEN_OVER", "请先接管会话再回复");
      const { row, duplicate } = repos.messages.insertIgnoreByClientId({
        conversationId: conversation.id,
        senderType: "agent",
        senderId: seatId,
        content,
        clientMessageId: `a:${seatId}:${clientMessageId}`,
        at,
      });
      if (!duplicate) touchTicket(ticketId, at);
      return { message: row, duplicate };
    });
  }

  function recoverRuns(): Promise<void> {
    const active = repos.aiRuns.listActive();
    const repairs: Promise<unknown>[] = [];

    // 先处理被中断的 running（保证同一会话上的修复排在 queued 重新调度之前，locks 为 FIFO）
    for (const run of active) {
      if (run.status !== "running") continue;
      const conv = repos.conversations.get(run.conversation_id);
      tx(db, () => {
        const at = nowIso();
        if (repos.aiRuns.fail(run.id, "interrupted_by_restart", at) !== 1) return;
        const cur = repos.conversations.get(run.conversation_id);
        // 只在仍由 AI 接待且 generation 未变时通知客户（已接管 / 结单的会话不需要）
        if (cur && cur.handling_mode === "ai" && cur.ai_generation === run.generation) {
          repos.messages.insert({
            conversationId: cur.id,
            senderType: "system",
            senderId: null,
            content: "抱歉，智能助手刚才的回复因服务重启中断，请重新发送您的问题。",
            at,
          });
        }
      });
      if (agent && conv) {
        const threadId = conv.thread_id;
        repairs.push(
          locks
            .withLock(lockKey(conv.id), async () => {
              const n = await agent.repairDanglingToolCalls(threadId);
              if (n > 0) {
                repos.logs.write({
                  scope: "conversation",
                  refId: conv.id,
                  node: "ai_run",
                  event: "repaired_dangling_tool_calls",
                  detail: { runId: run.id, count: n },
                });
              }
            })
            .catch((e) => console.error(`[conversation] 修复会话线程 ${threadId} 的悬空 tool_call 失败：`, e)),
        );
      }
    }
    for (const run of active) {
      if (run.status !== "running") void schedule(run.id, run.conversation_id);
    }
    return Promise.all(repairs).then(() => undefined);
  }

  return {
    handleCustomerMessage,
    processRun,
    agentReply,
    idle: (conversationId) => locks.idle(lockKey(conversationId)),
    recoverRuns,
  };
}

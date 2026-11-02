// 人工接管 / 恢复 AI / 转人工（SPEC §E.2）。
import type { Db } from "../db/connection";
import { tx } from "../db/connection";
import type { TicketRow } from "../domain/types";
import { AppError } from "../errors";
import type { AgentContext } from "../agent/context";
import { isRunActive, RUN_CANCELLED_MESSAGE } from "../agent/run-guard";
import type { SummaryService } from "../agent/summary";
import type { Repos } from "../repos/interfaces";
import { nowIso } from "../util";
import type { TicketService } from "./tickets";

export interface HandoverService {
  takeover(seatId: string, ticketId: string): TicketRow;
  resumeAi(seatId: string, ticketId: string): TicketRow;
  /** 客户按钮 */
  requestByCustomer(customerId: string, ticketId: string, reason: string): TicketRow;
  /** AI 工具调用：只做标记，模式切换推迟到 E.3 写回事务 */
  requestByAiTool(ctx: AgentContext, reason: string): { ok: true } | { ok: false; code: "RUN_CANCELLED"; message: string };
}

/**
 * 与 SPEC 的小偏离：deps 比 §A.6 多了 tickets（做归属校验）与 summary（接管后异步刷新摘要）。
 */
export function createHandoverService(deps: {
  db: Db;
  repos: Repos;
  tickets: TicketService;
  summary: SummaryService;
}): HandoverService {
  const { db, repos, tickets, summary } = deps;

  const refreshLater = (ticketId: string) => {
    void summary.refresh(ticketId).catch((e) => console.error("[handover] 摘要刷新失败：", e));
  };

  function takeover(seatId: string, ticketId: string): TicketRow {
    const { row, changed } = tx(db, () => {
      const at = nowIso();
      const { ticket, conversation } = tickets.requireSeatTicket(seatId, ticketId);
      if (ticket.status === "closed") throw new AppError(409, "TICKET_CLOSED", "该工单已结束，无法接管");
      const changes = repos.conversations.takeover(conversation.id, at);
      if (changes === 0) {
        // 已是 human：幂等返回
        return { row: ticket, changed: false };
      }
      repos.aiRuns.cancelActive(conversation.id, at);
      const seat = repos.identity.getSeat(seatId);
      repos.messages.insert({
        conversationId: conversation.id,
        senderType: "system",
        senderId: null,
        content: `人工客服 ${seat?.name ?? seatId} 已接入，AI 助手暂停自动回复。`,
        at,
      });
      repos.logs.write({ scope: "conversation", refId: conversation.id, node: "handover", event: "takeover", detail: { seatId }, at });
      return { row: repos.tickets.get(ticketId)!, changed: true };
    });
    if (changed) refreshLater(ticketId);
    return row;
  }

  function resumeAi(seatId: string, ticketId: string): TicketRow {
    return tx(db, () => {
      const at = nowIso();
      const { ticket, conversation } = tickets.requireSeatTicket(seatId, ticketId);
      if (ticket.status === "closed") throw new AppError(409, "TICKET_CLOSED", "该工单已结束");
      const changes = repos.conversations.resumeAi(conversation.id, at);
      if (changes === 0) return ticket; // 已是 ai：幂等
      repos.messages.insert({
        conversationId: conversation.id,
        senderType: "system",
        senderId: null,
        content: "AI 助手已恢复服务。",
        at,
      });
      repos.logs.write({ scope: "conversation", refId: conversation.id, node: "handover", event: "resume_ai", detail: { seatId }, at });
      return repos.tickets.get(ticketId)!;
    });
  }

  function requestByCustomer(customerId: string, ticketId: string, reason: string): TicketRow {
    const { row, changed } = tx(db, () => {
      const at = nowIso();
      const { ticket, conversation } = tickets.requireCustomerTicket(customerId, ticketId);
      if (ticket.status === "closed") throw new AppError(409, "TICKET_CLOSED", "该工单已结束，请新建咨询");
      const changes = repos.conversations.takeover(conversation.id, at);
      if (changes === 0) return { row: ticket, changed: false }; // 已是人工模式：幂等
      repos.aiRuns.cancelActive(conversation.id, at);
      repos.tickets.setHandoverRequested(ticketId, reason, at);
      repos.messages.insert({
        conversationId: conversation.id,
        senderType: "system",
        senderId: null,
        content: "已为您申请人工客服，请稍候，人工客服接入前 AI 助手将暂停自动回复。",
        at,
      });
      repos.logs.write({
        scope: "conversation",
        refId: conversation.id,
        node: "handover",
        event: "customer_request",
        detail: { reason },
        at,
      });
      return { row: repos.tickets.get(ticketId)!, changed: true };
    });
    if (changed) refreshLater(ticketId);
    return row;
  }

  function requestByAiTool(
    ctx: AgentContext,
    reason: string,
  ): { ok: true } | { ok: false; code: "RUN_CANCELLED"; message: string } {
    return tx(db, () => {
      // 守卫：run 已被接管 / 结单 / generation 变化时，不写任何标记（SPEC §E.3）
      if (!isRunActive(repos, ctx)) {
        repos.logs.write({
          scope: "conversation",
          refId: ctx.conversationId,
          node: "handover",
          event: "ai_request_ignored",
          detail: { runId: ctx.runId },
        });
        return { ok: false as const, code: "RUN_CANCELLED" as const, message: RUN_CANCELLED_MESSAGE };
      }
      const at = nowIso();
      if (repos.aiRuns.markHandoverRequested(ctx.runId) !== 1) {
        return { ok: false as const, code: "RUN_CANCELLED" as const, message: RUN_CANCELLED_MESSAGE };
      }
      repos.tickets.setHandoverRequested(ctx.ticketId, reason, at);
      repos.logs.write({
        scope: "conversation",
        refId: ctx.conversationId,
        node: "handover",
        event: "ai_request",
        detail: { runId: ctx.runId, reason },
        at,
      });
      return { ok: true as const };
    });
  }

  return { takeover, resumeAi, requestByCustomer, requestByAiTool };
}

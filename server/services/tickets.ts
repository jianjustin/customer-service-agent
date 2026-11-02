// 工单服务：创建、转派、结束、归属校验（SPEC §A.6 / §D.1 / §E.1）。
import { randomUUID } from "node:crypto";
import type { Db } from "../db/connection";
import { tx } from "../db/connection";
import type { ConversationRow, TicketRow } from "../domain/types";
import { AppError } from "../errors";
import type { Repos } from "../repos/interfaces";
import { nowIso, randomId } from "../util";
import type { AssignmentService } from "./assignment";

export interface TicketService {
  /** 必须在调用方 tx 内调用：建工单(queued)+会话，并立即尝试分配，写分配日志。返回的 ticket 为分配后的最新行 */
  createForCustomerInTx(customerId: string, subject: string, at: string): { ticket: TicketRow; conversation: ConversationRow };
  transfer(seatId: string, ticketId: string, targetSeatId: string): TicketRow;
  close(seatId: string, ticketId: string): TicketRow;
  requireCustomerTicket(customerId: string, ticketId: string): { ticket: TicketRow; conversation: ConversationRow };
  requireSeatTicket(seatId: string, ticketId: string): { ticket: TicketRow; conversation: ConversationRow };
}

export function createTicketService(deps: { db: Db; repos: Repos; assignment: AssignmentService }): TicketService {
  const { db, repos, assignment } = deps;

  function loadPair(ticketId: string): { ticket: TicketRow; conversation: ConversationRow } {
    const ticket = repos.tickets.get(ticketId);
    if (!ticket) throw new AppError(404, "NOT_FOUND", "工单不存在");
    const conversation = repos.conversations.getByTicket(ticketId);
    if (!conversation) throw new AppError(404, "NOT_FOUND", "工单对应的会话不存在");
    return { ticket, conversation };
  }

  function requireCustomerTicket(customerId: string, ticketId: string) {
    const pair = loadPair(ticketId);
    if (pair.ticket.customer_id !== customerId) throw new AppError(403, "FORBIDDEN", "无权访问该工单");
    return pair;
  }

  function requireSeatTicket(seatId: string, ticketId: string) {
    const pair = loadPair(ticketId);
    // queued 工单 seat_id 为 NULL，不属于任何席位
    if (pair.ticket.seat_id !== seatId) throw new AppError(403, "FORBIDDEN", "该工单不属于当前席位");
    return pair;
  }

  function createForCustomerInTx(customerId: string, subject: string, at: string) {
    const ticketId = randomId("TK");
    repos.tickets.insert({
      id: ticketId,
      customer_id: customerId,
      seat_id: null,
      status: "queued",
      subject,
      created_at: at,
      updated_at: at,
    });
    const conversationId = randomId("CV");
    const conversation: ConversationRow = {
      id: conversationId,
      ticket_id: ticketId,
      customer_id: customerId,
      channel: "web",
      channel_session_id: "web:" + conversationId,
      thread_id: "conv_" + randomUUID(),
      handling_mode: "ai",
      ai_generation: 0,
      created_at: at,
      updated_at: at,
    };
    repos.conversations.insert(conversation);
    const seat = assignment.assignInTx(ticketId, at);
    repos.logs.write({
      scope: "assignment",
      refId: ticketId,
      node: "assign",
      event: seat ? "assigned" : "queued",
      detail: { seatId: seat ? seat.id : null },
      at,
    });
    return { ticket: repos.tickets.get(ticketId)!, conversation };
  }

  function transfer(seatId: string, ticketId: string, targetSeatId: string): TicketRow {
    const updated = tx(db, () => {
      const at = nowIso();
      // 先读后校验：repo.assign 不校验当前 seat_id，所以归属必须在本事务内确认
      const { ticket } = requireSeatTicket(seatId, ticketId);
      if (ticket.status === "closed") throw new AppError(409, "TICKET_CLOSED", "该工单已结束，无法转派");
      if (ticket.status !== "assigned") throw new AppError(409, "CONFLICT", "工单状态已变化，请刷新后重试");
      const target = repos.identity.getSeat(targetSeatId);
      if (!target) throw new AppError(404, "NOT_FOUND", "目标席位不存在");
      if (target.id === seatId) throw new AppError(422, "VALIDATION_ERROR", "不能转派给当前席位");
      if (!assignment.isSeatAvailable(target)) {
        throw new AppError(409, "SEAT_UNAVAILABLE", `席位 ${target.name} 当前离线或已满员，无法转派`);
      }
      const changes = repos.tickets.assign(ticketId, target.id, at, "assigned");
      if (changes !== 1) throw new AppError(409, "CONFLICT", "工单状态已变化，请刷新后重试");
      repos.logs.write({
        scope: "assignment",
        refId: ticketId,
        node: "transfer",
        event: "transferred",
        detail: { from: seatId, to: target.id },
        at,
      });
      return repos.tickets.get(ticketId)!;
    });
    // 原席位释放了容量：尝试让排队工单出队
    assignment.drainQueue();
    return updated;
  }

  function close(seatId: string, ticketId: string): TicketRow {
    const result = tx(db, () => {
      const at = nowIso();
      const { ticket, conversation } = requireSeatTicket(seatId, ticketId);
      if (ticket.status === "closed") return { ticket, changed: false };
      const changes = repos.tickets.close(ticketId, at);
      if (changes !== 1) return { ticket: repos.tickets.get(ticketId)!, changed: false };
      // 使进行中的 AI 回复在写回时被抑制，并取消排队中的 run
      repos.conversations.bumpGeneration(conversation.id, at);
      repos.aiRuns.cancelActive(conversation.id, at);
      repos.messages.insert({
        conversationId: conversation.id,
        senderType: "system",
        senderId: null,
        content: "本次服务已结束，如有新问题请发起新的咨询。",
        at,
      });
      repos.logs.write({ scope: "assignment", refId: ticketId, node: "close", event: "closed", detail: { seatId }, at });
      return { ticket: repos.tickets.get(ticketId)!, changed: true };
    });
    if (result.changed) assignment.drainQueue();
    return result.ticket;
  }

  return { createForCustomerInTx, transfer, close, requireCustomerTicket, requireSeatTicket };
}

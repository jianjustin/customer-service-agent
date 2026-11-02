// 客服工作台路由（SPEC §D.4）。actor.id 即席位 id；工单归属由服务层 requireSeatTicket 校验。
import { Router } from "express";
import { z } from "zod";
import type { Container } from "../container";
import { AppError } from "../errors";
import { agentTicketDto, messageDtos, orderDtos, param, parseBody, refundDto, seatDto } from "./shared";

const statusBody = z.object({ online: z.boolean() }).strict();
const replyBody = z
  .object({
    content: z.string().trim().min(1).max(2000),
    clientMessageId: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
const transferBody = z.object({ targetSeatId: z.string().min(1) }).strict();
const emptyBody = z.object({}).strict();
const ticketsQuery = z.object({ status: z.enum(["assigned", "closed", "all"]).default("all") });

export function agentRouter(c: Container): Router {
  const r = Router();
  const mySeat = (seatId: string) => {
    const seat = c.repos.identity.getSeat(seatId);
    if (!seat) throw new AppError(404, "NOT_FOUND", "席位不存在");
    return seat;
  };

  r.get("/me", (req, res) => {
    res.json({ seat: seatDto(c, mySeat(req.actor!.id)) });
  });

  r.post("/me/status", (req, res) => {
    const { online } = parseBody(statusBody, req);
    const seatId = req.actor!.id;
    c.repos.identity.setSeatOnline(seatId, online);
    // 上线后出队：排队工单可能分给任意可用席位
    const dequeued = online ? c.services.assignment.drainQueue() : [];
    res.json({ seat: seatDto(c, mySeat(seatId)), dequeued });
  });

  r.get("/tickets", (req, res) => {
    const { status } = ticketsQuery.parse(req.query);
    const rows = c.repos.tickets
      .listBySeat(req.actor!.id, status === "all" ? undefined : status)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
    res.json({ tickets: rows.map((t) => agentTicketDto(c, t)) });
  });

  r.get("/tickets/:id", (req, res) => {
    const { ticket, conversation } = c.services.tickets.requireSeatTicket(req.actor!.id, param(req, "id"));
    res.json({
      ticket: agentTicketDto(c, ticket),
      messages: messageDtos(c, ticket.customer_id, c.repos.messages.list(conversation.id)),
      orders: orderDtos(c, ticket.customer_id),
      refunds: c.repos.refunds.listByTicket(ticket.id).map((x) => refundDto(c, x, "staff")),
      aiRuns: c.repos.aiRuns.listByConversation(conversation.id, 10).map((a) => ({
        id: a.id,
        status: a.status,
        generation: a.generation,
        createdAt: a.created_at,
        finishedAt: a.finished_at,
        error: a.error,
      })),
    });
  });

  r.post("/tickets/:id/takeover", (req, res) => {
    parseBody(emptyBody, req);
    const t = c.services.handover.takeover(req.actor!.id, param(req, "id"));
    res.json({ ticket: agentTicketDto(c, t) });
  });

  r.post("/tickets/:id/resume-ai", (req, res) => {
    parseBody(emptyBody, req);
    const t = c.services.handover.resumeAi(req.actor!.id, param(req, "id"));
    res.json({ ticket: agentTicketDto(c, t) });
  });

  r.post("/tickets/:id/reply", (req, res) => {
    const body = parseBody(replyBody, req);
    const seatId = req.actor!.id;
    const ticketId = param(req, "id");
    const { message, duplicate } = c.services.conversation.agentReply(seatId, ticketId, body.content, body.clientMessageId);
    const customerId = c.repos.tickets.get(ticketId)!.customer_id;
    const [dto] = messageDtos(c, customerId, [message]);
    res.status(duplicate ? 200 : 201).json({ message: dto, duplicate });
  });

  r.post("/tickets/:id/transfer", (req, res) => {
    const body = parseBody(transferBody, req);
    const t = c.services.tickets.transfer(req.actor!.id, param(req, "id"), body.targetSeatId);
    res.json({ ticket: agentTicketDto(c, t) });
  });

  r.post("/tickets/:id/close", (req, res) => {
    parseBody(emptyBody, req);
    const t = c.services.tickets.close(req.actor!.id, param(req, "id"));
    res.json({ ticket: agentTicketDto(c, t) });
  });

  r.get("/seats", (_req, res) => {
    const queued = c.repos.tickets.listQueued();
    res.json({
      seats: c.repos.identity.listSeats().map((s) => seatDto(c, s)),
      queue: { count: queued.length, ticketIds: queued.map((t) => t.id) },
    });
  });

  return r;
}

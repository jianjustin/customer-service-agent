// 客户端路由（SPEC §D.3）。归属校验在服务层（requireCustomerTicket），不依赖前端。
import { Router } from "express";
import { z } from "zod";
import type { Container } from "../container";
import { messageDtos, orderDtos, param, parseBody, refundDto, ticketDto } from "./shared";

const messageBody = z
  .object({
    content: z.string().trim().min(1).max(2000),
    clientMessageId: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/),
    ticketId: z.string().min(1).optional(),
    newTicket: z.boolean().optional(),
  })
  .strict()
  .refine((b) => !(b.ticketId !== undefined && b.newTicket === true), { message: "ticketId 与 newTicket 不能同时出现" });

const handoverBody = z.object({ reason: z.string().trim().max(200).optional() }).strict();

const afterSeqQuery = z.object({ afterSeq: z.coerce.number().int().min(0).default(0) });

export function customerRouter(c: Container): Router {
  const r = Router();

  r.post("/messages", (req, res) => {
    const body = parseBody(messageBody, req);
    const customerId = req.actor!.id;
    const result = c.services.conversation.handleCustomerMessage({
      customerId,
      content: body.content,
      clientMessageId: body.clientMessageId,
      ticketId: body.ticketId,
      newTicket: body.newTicket,
    });
    // AI run 在后台执行，HTTP 不等待；run 内部异常已被收敛，这里仅防御
    void result.aiRun?.catch((e) => console.error("[customer] ai run 异常：", e));
    const [message] = messageDtos(c, customerId, [result.message]);
    res.status(result.duplicate ? 200 : 201).json({
      duplicate: result.duplicate,
      ticket: ticketDto(c, result.ticket),
      message,
      aiRunId: result.aiRunId,
    });
  });

  r.get("/tickets", (req, res) => {
    const rows = c.repos.tickets.listByCustomer(req.actor!.id);
    res.json({ tickets: rows.map((t) => ticketDto(c, t)) });
  });

  r.get("/tickets/:id/messages", (req, res) => {
    const { afterSeq } = afterSeqQuery.parse(req.query);
    const customerId = req.actor!.id;
    const { ticket, conversation } = c.services.tickets.requireCustomerTicket(customerId, param(req, "id"));
    const rows = c.repos.messages.list(conversation.id, afterSeq);
    res.json({
      ticket: ticketDto(c, ticket),
      messages: messageDtos(c, customerId, rows),
      aiPending: c.repos.aiRuns.hasPending(conversation.id),
    });
  });

  r.get("/orders", (req, res) => {
    res.json({ orders: orderDtos(c, req.actor!.id) });
  });

  r.get("/refunds", (req, res) => {
    const rows = c.repos.refunds.listByCustomer(req.actor!.id);
    res.json({ refunds: rows.map((x) => refundDto(c, x, "customer")) });
  });

  r.post("/tickets/:id/handover", (req, res) => {
    const body = parseBody(handoverBody, req);
    const reason = body.reason && body.reason.length > 0 ? body.reason : "客户申请转人工";
    const ticket = c.services.handover.requestByCustomer(req.actor!.id, param(req, "id"), reason);
    res.json({ ticket: ticketDto(c, ticket) });
  });

  return r;
}

// 路由共用的视图装配工具（行 → DTO 所需的关联查询）。
import type { Request } from "express";
import { z } from "zod";
import type { Container } from "../container";
import {
  toAgentTicketDTO,
  toMessageDTO,
  toOrderDTO,
  toRefundDTO,
  toTicketDTO,
  type AgentTicketDTO,
  type MessageDTO,
  type OrderDTO,
  type RefundDTO,
  type TicketDTO,
} from "../domain/dto";
import type { MessageRow, RefundRequestRow, SeatRow, TicketRow } from "../domain/types";
import { AppError } from "../errors";

/** 读取路径参数（Express 5 类型为 string | string[]） */
export function param(req: Request, name: string): string {
  const v = req.params[name];
  const s = Array.isArray(v) ? v[0] : v;
  if (!s) throw new AppError(422, "VALIDATION_ERROR", `缺少路径参数 ${name}`);
  return s;
}

/** 校验请求体：缺省视为 {}，多余字段 422（schema 必须是 .strict()） */
export function parseBody<S extends z.ZodType>(schema: S, req: Request): z.infer<S> {
  return schema.parse(req.body ?? {});
}

export function seatDto(c: Container, seat: SeatRow) {
  return {
    id: seat.id,
    name: seat.name,
    online: seat.online === 1,
    capacity: seat.capacity,
    activeCount: c.repos.tickets.countAssigned(seat.id),
  };
}

/** 客户视角的工单 DTO（handoverReason 恒为 null） */
export function ticketDto(c: Container, t: TicketRow): TicketDTO {
  const conv = c.repos.conversations.getByTicket(t.id)!;
  const customer = c.repos.identity.getCustomer(t.customer_id)!;
  const seat = t.seat_id ? (c.repos.identity.getSeat(t.seat_id) ?? null) : null;
  return toTicketDTO(t, conv, customer, seat, "customer"); // ticketDto 仅用于客户端
}

export function agentTicketDto(c: Container, t: TicketRow): AgentTicketDTO {
  const conv = c.repos.conversations.getByTicket(t.id)!;
  const customer = c.repos.identity.getCustomer(t.customer_id)!;
  const seat = t.seat_id ? (c.repos.identity.getSeat(t.seat_id) ?? null) : null;
  return toAgentTicketDTO(t, conv, customer, seat);
}

export function messageDtos(c: Container, customerId: string, rows: MessageRow[]): MessageDTO[] {
  const customerName = c.repos.identity.getCustomer(customerId)?.name ?? customerId;
  const seatNames = Object.fromEntries(c.repos.identity.listSeats().map((s) => [s.id, s.name]));
  return rows.map((m) => toMessageDTO(m, { customerName, seatNames }));
}

export function orderDtos(c: Container, customerId: string): OrderDTO[] {
  return c.repos.orders.listByCustomer(customerId).map((o) => toOrderDTO(o, c.repos.orders.getPayment(o.id) ?? null));
}

export function refundDto(c: Container, r: RefundRequestRow, audience: "customer" | "staff"): RefundDTO {
  return toRefundDTO(r, c.repos.refunds.getDecision(r.id) ?? null, audience);
}

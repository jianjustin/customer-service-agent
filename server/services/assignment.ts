// 席位分配与排队出队（SPEC §E.6）：轮询游标 + 容量/在线过滤。
import type { Db } from "../db/connection";
import { tx } from "../db/connection";
import type { SeatRow } from "../domain/types";
import type { Repos } from "../repos/interfaces";
import { nowIso } from "../util";

export interface AssignmentService {
  /** 必须在调用方 tx 内调用；把 queued 工单分给下一个可用席位，或保持 queued。返回分配到的席位或 null */
  assignInTx(ticketId: string, at: string): SeatRow | null;
  /** 按 created_at 出队，直到无可用席位；自带 tx；返回被分配的工单 id 列表 */
  drainQueue(): string[];
  /** online=1 且 countAssigned < capacity */
  isSeatAvailable(seat: SeatRow): boolean;
  seatLoads(): Array<SeatRow & { activeCount: number }>;
}

export function createAssignmentService(deps: { db: Db; repos: Repos }): AssignmentService {
  const { db, repos } = deps;

  const isSeatAvailable = (seat: SeatRow): boolean =>
    seat.online === 1 && repos.tickets.countAssigned(seat.id) < seat.capacity;

  function assignInTx(ticketId: string, at: string): SeatRow | null {
    const seats = repos.identity.listSeats(); // ORDER BY sort_order
    if (seats.length === 0) return null;
    const cursor = repos.assignmentState.get("rr_cursor") ?? "";
    const start = seats.findIndex((s) => s.id === cursor); // 找不到为 -1，首个候选为 seats[0]
    for (let i = 1; i <= seats.length; i++) {
      const seat = seats[(((start + i) % seats.length) + seats.length) % seats.length]!;
      if (isSeatAvailable(seat)) {
        const changes = repos.tickets.assign(ticketId, seat.id, at, "queued");
        if (changes !== 1) throw new Error(`分配失败：工单 ${ticketId} 不在排队状态`);
        repos.assignmentState.set("rr_cursor", seat.id);
        return seat;
      }
    }
    return null;
  }

  function drainQueue(): string[] {
    return tx(db, () => {
      const assigned: string[] = [];
      for (const t of repos.tickets.listQueued()) {
        const at = nowIso();
        const seat = assignInTx(t.id, at);
        if (!seat) break;
        assigned.push(t.id);
        const conv = repos.conversations.getByTicket(t.id);
        if (conv) {
          repos.messages.insert({
            conversationId: conv.id,
            senderType: "system",
            senderId: null,
            content: `已为您分配人工客服 ${seat.name}。`,
            at,
          });
        }
        repos.logs.write({
          scope: "assignment",
          refId: t.id,
          node: "assign",
          event: "dequeued",
          detail: { seatId: seat.id },
          at,
        });
      }
      return assigned;
    });
  }

  return {
    assignInTx,
    drainQueue,
    isSeatAvailable,
    seatLoads: () =>
      repos.identity.listSeats().map((s) => ({ ...s, activeCount: repos.tickets.countAssigned(s.id) })),
  };
}

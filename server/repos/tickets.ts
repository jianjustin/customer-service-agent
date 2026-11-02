import type { Db } from "../db/connection";
import type { TicketRow, TicketStatus } from "../domain/types";
import type { TicketRepo } from "./interfaces";

export function createTicketRepo(db: Db): TicketRepo {
  return {
    get: (id) => db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as TicketRow | undefined,
    insert(row) {
      db.prepare(
        `INSERT INTO tickets(id, customer_id, seat_id, status, subject, created_at, updated_at)
         VALUES (@id, @customer_id, @seat_id, @status, @subject, @created_at, @updated_at)`,
      ).run(row);
    },
    listByCustomer: (customerId) =>
      db.prepare("SELECT * FROM tickets WHERE customer_id = ? ORDER BY created_at DESC, rowid DESC").all(customerId) as TicketRow[],
    listBySeat(seatId: string, status?: TicketStatus) {
      if (status) {
        return db
          .prepare("SELECT * FROM tickets WHERE seat_id = ? AND status = ? ORDER BY created_at DESC, rowid DESC")
          .all(seatId, status) as TicketRow[];
      }
      return db
        .prepare("SELECT * FROM tickets WHERE seat_id = ? ORDER BY created_at DESC, rowid DESC")
        .all(seatId) as TicketRow[];
    },
    latestOpenForCustomer: (customerId) =>
      db
        .prepare("SELECT * FROM tickets WHERE customer_id = ? AND status != 'closed' ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .get(customerId) as TicketRow | undefined,
    countAssigned: (seatId) =>
      (db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status = 'assigned' AND seat_id = ?").get(seatId) as { n: number }).n,
    listQueued: () =>
      db.prepare("SELECT * FROM tickets WHERE status = 'queued' ORDER BY created_at, rowid").all() as TicketRow[],
    assign: (id, seatId, at, fromStatus) =>
      db
        .prepare("UPDATE tickets SET seat_id = ?, status = 'assigned', assigned_at = ?, updated_at = ? WHERE id = ? AND status = ?")
        .run(seatId, at, at, id, fromStatus).changes,
    close: (id, at) =>
      db
        .prepare("UPDATE tickets SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued','assigned')")
        .run(at, at, id).changes,
    setSummary(id, summary, at) {
      db.prepare("UPDATE tickets SET ai_summary = ?, updated_at = ? WHERE id = ?").run(summary, at, id);
    },
    setHandoverRequested: (id, reason, at) =>
      db
        .prepare("UPDATE tickets SET handover_requested = 1, handover_reason = ?, updated_at = ? WHERE id = ?")
        .run(reason, at, id).changes,
  };
}

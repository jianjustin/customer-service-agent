import type { Db } from "../db/connection";
import type { CustomerRow, ReviewerRow, SeatRow } from "../domain/types";
import type { IdentityRepo } from "./interfaces";

export function createIdentityRepo(db: Db): IdentityRepo {
  return {
    getCustomer: (id) => db.prepare("SELECT * FROM customers WHERE id = ?").get(id) as CustomerRow | undefined,
    listCustomers: () => db.prepare("SELECT * FROM customers ORDER BY id").all() as CustomerRow[],
    getSeat: (id) => db.prepare("SELECT * FROM seats WHERE id = ?").get(id) as SeatRow | undefined,
    listSeats: () => db.prepare("SELECT * FROM seats ORDER BY sort_order").all() as SeatRow[],
    setSeatOnline: (id, online) => db.prepare("UPDATE seats SET online = ? WHERE id = ?").run(online ? 1 : 0, id).changes,
    getReviewer: (id) => db.prepare("SELECT * FROM reviewers WHERE id = ?").get(id) as ReviewerRow | undefined,
    listReviewers: () => db.prepare("SELECT * FROM reviewers ORDER BY id").all() as ReviewerRow[],
  };
}

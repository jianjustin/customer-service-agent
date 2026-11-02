import type { Db } from "../db/connection";
import type { OrderRow, PaymentRow } from "../domain/types";
import type { OrderRepo } from "./interfaces";

export function createOrderRepo(db: Db): OrderRepo {
  return {
    get: (id) => db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined,
    listByCustomer: (customerId) =>
      db.prepare("SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC, id").all(customerId) as OrderRow[],
    getPayment: (orderId) => db.prepare("SELECT * FROM payments WHERE order_id = ?").get(orderId) as PaymentRow | undefined,
    markRefunded: (orderId, at) =>
      db
        .prepare(
          "UPDATE orders SET payment_status = 'refunded', refunded_at = ?, refund_note = '已退款（模拟）' WHERE id = ? AND payment_status = 'paid'",
        )
        .run(at, orderId).changes,
    markPaymentRefunded: (orderId) =>
      db.prepare("UPDATE payments SET status = 'refunded' WHERE order_id = ? AND status = 'succeeded'").run(orderId).changes,
    consumeSimulatedFailure: (orderId) =>
      db
        .prepare(
          "UPDATE orders SET simulate_refund_failure = simulate_refund_failure - 1 WHERE id = ? AND simulate_refund_failure > 0",
        )
        .run(orderId).changes,
  };
}

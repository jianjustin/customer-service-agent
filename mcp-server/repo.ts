// MCP 子进程的订单只读数据访问接口。换成业务 API / 多维表格时，实现同一接口即可。
// 唯一允许的写操作：execution_logs(scope='mcp') 审计行（用于证明调用确实经过 MCP 进程）。
import Database from "better-sqlite3";
import {
  PAYMENT_RECORD_STATUS_TEXT,
  PAYMENT_STATUS_TEXT,
  REFUND_STATUS_TEXT,
  SHIPPING_STATUS_TEXT,
  type OrderRow,
  type PaymentRecordStatus,
  type PaymentRow,
  type PaymentStatus,
  type RefundRequestRow,
  type RefundStatus,
  type ShippingStatus,
} from "../server/domain/types";

export interface OrderView {
  orderId: string;
  title: string;
  amountMinor: number;
  currency: string;
  paymentStatus: PaymentStatus;
  paymentStatusText: string;
  shippingStatus: ShippingStatus;
  shippingStatusText: string;
  trackingNo: string | null;
  paidAt: string | null;
  refundedAt: string | null;
  refundNote: string | null;
}
export interface PaymentView {
  orderId: string;
  paymentId: string;
  channel: string;
  status: PaymentRecordStatus;
  statusText: string;
  amountMinor: number;
  paidAt: string | null;
  failureReason: string | null;
}
export interface RefundView {
  requestId: string;
  orderId: string;
  status: RefundStatus;
  statusText: string;
  amountMinor: number;
  updatedAt: string;
}

export interface OrderReadRepository {
  listOrders(customerId: string): Promise<OrderView[]>;
  getOrder(orderId: string): Promise<(OrderView & { customerId: string }) | null>;
  getPayment(orderId: string): Promise<PaymentView | null>;
  listRefundsByOrder(orderId: string): Promise<RefundView[]>;
  getRefund(requestId: string): Promise<(RefundView & { customerId: string }) | null>;
  /** 写 execution_logs(scope='mcp') 审计行 */
  audit(e: { tool: string; event: "call" | "denied"; customerId: string; detail: Record<string, unknown> }): Promise<void>;
  close(): void;
}

function toOrderView(o: OrderRow): OrderView {
  return {
    orderId: o.id,
    title: o.title,
    amountMinor: o.amount_minor,
    currency: o.currency,
    paymentStatus: o.payment_status,
    paymentStatusText: PAYMENT_STATUS_TEXT[o.payment_status],
    shippingStatus: o.shipping_status,
    shippingStatusText: SHIPPING_STATUS_TEXT[o.shipping_status],
    trackingNo: o.tracking_no,
    paidAt: o.paid_at,
    refundedAt: o.refunded_at,
    refundNote: o.refund_note,
  };
}

function toPaymentView(p: PaymentRow): PaymentView {
  return {
    orderId: p.order_id,
    paymentId: p.id,
    channel: p.channel,
    status: p.status,
    statusText: PAYMENT_RECORD_STATUS_TEXT[p.status],
    amountMinor: p.amount_minor,
    paidAt: p.paid_at,
    failureReason: p.failure_reason,
  };
}

function toRefundView(r: RefundRequestRow): RefundView {
  return {
    requestId: r.id,
    orderId: r.order_id,
    status: r.status,
    statusText: REFUND_STATUS_TEXT[r.status],
    amountMinor: r.amount_minor,
    updatedAt: r.updated_at,
  };
}

export function createSqliteOrderReadRepository(dbPath: string): OrderReadRepository {
  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  const listOrdersStmt = db.prepare("SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC, id");
  const getOrderStmt = db.prepare("SELECT * FROM orders WHERE id = ?");
  const getPaymentStmt = db.prepare("SELECT * FROM payments WHERE order_id = ?");
  const listRefundsStmt = db.prepare("SELECT * FROM refund_requests WHERE order_id = ? ORDER BY created_at, rowid");
  const getRefundStmt = db.prepare("SELECT * FROM refund_requests WHERE id = ?");
  const auditStmt = db.prepare(
    `INSERT INTO execution_logs(scope, ref_id, node, event, detail_json, dedupe_key, created_at)
     VALUES ('mcp', ?, ?, ?, ?, NULL, ?)`,
  );

  return {
    async listOrders(customerId) {
      return (listOrdersStmt.all(customerId) as OrderRow[]).map(toOrderView);
    },
    async getOrder(orderId) {
      const o = getOrderStmt.get(orderId) as OrderRow | undefined;
      return o ? { ...toOrderView(o), customerId: o.customer_id } : null;
    },
    async getPayment(orderId) {
      const p = getPaymentStmt.get(orderId) as PaymentRow | undefined;
      return p ? toPaymentView(p) : null;
    },
    async listRefundsByOrder(orderId) {
      return (listRefundsStmt.all(orderId) as RefundRequestRow[]).map(toRefundView);
    },
    async getRefund(requestId) {
      const r = getRefundStmt.get(requestId) as RefundRequestRow | undefined;
      return r ? { ...toRefundView(r), customerId: r.customer_id } : null;
    },
    async audit(e) {
      auditStmt.run(e.tool, e.tool, e.event, JSON.stringify({ ...e.detail, customerId: e.customerId, pid: process.pid }), new Date().toISOString());
    },
    close() {
      db.close();
    },
  };
}

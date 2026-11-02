import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { KnowledgeEntry } from "../domain/types";
import { PROJECT_ROOT } from "../util";
import { tx, type Db } from "./connection";

export const SEED_TIME = "2026-10-20T08:00:00.000Z";

export const knowledgeEntriesSchema = z
  .array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      version: z.number().int().positive(),
      category: z.string(),
      content: z.string(),
      keywords: z.array(z.string()).min(1),
    }),
  )
  .min(10);

/** 读取并校验 knowledge/entries.json */
export function loadKnowledgeEntries(knowledgePath: string = path.join(PROJECT_ROOT, "knowledge/entries.json")): KnowledgeEntry[] {
  return knowledgeEntriesSchema.parse(JSON.parse(readFileSync(knowledgePath, "utf8")));
}

const CUSTOMERS = [
  ["cust_a", "客户甲"],
  ["cust_b", "客户乙"],
  ["cust_c", "客户丙"],
] as const;

const SEATS = [
  ["seat_A", "A", 1],
  ["seat_B", "B", 2],
  ["seat_C", "C", 3],
] as const;

type SeedOrder = [
  id: string,
  customerId: string,
  title: string,
  amountMinor: number,
  paymentStatus: string,
  shippingStatus: string,
  trackingNo: string | null,
  paidAt: string | null,
  refundedAt: string | null,
  refundNote: string | null,
  simulateRefundFailure: number,
  createdAt: string,
];

const ORDERS: SeedOrder[] = [
  ["ORD-1001", "cust_a", "无线降噪耳机", 59900, "paid", "shipped", "SF1000000001", "2026-10-21T02:05:00.000Z", null, null, 0, "2026-10-21T02:00:00.000Z"],
  ["ORD-1002", "cust_a", "手机保护壳", 3900, "unpaid", "none", null, null, null, null, 0, "2026-10-21T03:00:00.000Z"],
  ["ORD-1003", "cust_b", "智能手表", 129900, "paid", "delivered", "SF1000000003", "2026-10-21T04:05:00.000Z", null, null, 1, "2026-10-21T04:00:00.000Z"],
  ["ORD-1004", "cust_b", "快充充电器", 9900, "refunded", "delivered", "SF1000000004", "2026-10-21T05:05:00.000Z", "2026-10-25T03:00:00.000Z", "已退款（模拟）", 0, "2026-10-21T05:00:00.000Z"],
  ["ORD-1005", "cust_c", "蓝牙音箱", 29900, "paid", "pending", null, "2026-10-21T06:05:00.000Z", null, null, 0, "2026-10-21T06:00:00.000Z"],
  ["ORD-1006", "cust_c", "数据线", 1990, "unpaid", "none", null, null, null, null, 0, "2026-10-21T07:00:00.000Z"],
  ["ORD-1007", "cust_a", "年度会员", 19900, "refunded", "none", null, "2026-10-21T08:05:00.000Z", "2026-10-26T03:00:00.000Z", "已退款（模拟）", 0, "2026-10-21T08:00:00.000Z"],
];

type SeedPayment = [id: string, orderId: string, channel: string, status: string, amountMinor: number, paidAt: string | null, failureReason: string | null, createdAt: string];

// payments.created_at 取订单创建时间
const PAYMENTS: SeedPayment[] = [
  ["PAY-1001", "ORD-1001", "wechat", "succeeded", 59900, "2026-10-21T02:05:00.000Z", null, "2026-10-21T02:00:00.000Z"],
  ["PAY-1002", "ORD-1002", "alipay", "pending", 3900, null, null, "2026-10-21T03:00:00.000Z"],
  ["PAY-1003", "ORD-1003", "card", "succeeded", 129900, "2026-10-21T04:05:00.000Z", null, "2026-10-21T04:00:00.000Z"],
  ["PAY-1004", "ORD-1004", "alipay", "refunded", 9900, "2026-10-21T05:05:00.000Z", null, "2026-10-21T05:00:00.000Z"],
  ["PAY-1005", "ORD-1005", "wechat", "succeeded", 29900, "2026-10-21T06:05:00.000Z", null, "2026-10-21T06:00:00.000Z"],
  ["PAY-1006", "ORD-1006", "card", "failed", 1990, null, "银行卡余额不足", "2026-10-21T07:00:00.000Z"],
  ["PAY-1007", "ORD-1007", "wechat", "refunded", 19900, "2026-10-21T08:05:00.000Z", null, "2026-10-21T08:00:00.000Z"],
];

/**
 * 幂等种子：业务行 INSERT OR IGNORE（不覆盖运行时修改），知识库 upsert。
 * 整个 seed 在一个事务内执行。
 */
export function seed(db: Db, knowledgePath?: string): void {
  const entries = loadKnowledgeEntries(knowledgePath);
  tx(db, () => {
    const insCustomer = db.prepare("INSERT OR IGNORE INTO customers(id, name) VALUES (?, ?)");
    for (const [id, name] of CUSTOMERS) insCustomer.run(id, name);

    const insSeat = db.prepare(
      "INSERT OR IGNORE INTO seats(id, name, online, capacity, sort_order) VALUES (?, ?, 1, 2, ?)",
    );
    for (const [id, name, order] of SEATS) insSeat.run(id, name, order);

    db.prepare("INSERT OR IGNORE INTO reviewers(id, name) VALUES (?, ?)").run("reviewer_1", "退款审核员");
    db.prepare("INSERT OR IGNORE INTO assignment_state(key, value) VALUES ('rr_cursor', '')").run();

    const insOrder = db.prepare(
      `INSERT OR IGNORE INTO orders(id, customer_id, title, amount_minor, currency, payment_status, shipping_status,
         tracking_no, paid_at, refunded_at, refund_note, simulate_refund_failure, created_at)
       VALUES (?, ?, ?, ?, 'CNY', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const o of ORDERS) insOrder.run(...o);

    const insPayment = db.prepare(
      `INSERT OR IGNORE INTO payments(id, order_id, channel, status, amount_minor, paid_at, failure_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of PAYMENTS) insPayment.run(...p);

    const upsertKb = db.prepare(
      `INSERT INTO knowledge_entries(id, title, version, category, content, keywords_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, version=excluded.version, category=excluded.category,
         content=excluded.content, keywords_json=excluded.keywords_json, updated_at=excluded.updated_at`,
    );
    for (const e of entries) {
      upsertKb.run(e.id, e.title, e.version, e.category, e.content, JSON.stringify(e.keywords), SEED_TIME);
    }
  });
}

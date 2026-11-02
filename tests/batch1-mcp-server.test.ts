import { createRequire } from "node:module";
import path from "node:path";
import { MCPAdapter } from "@langchain/mcp-adapters";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signContextToken, verifyContextToken } from "../mcp-server/auth";
import { openDb } from "../server/db/connection";
import { migrate } from "../server/db/migrate";
import { seed } from "../server/db/seed";
import { createRepos } from "../server/repos";
import { PROJECT_ROOT } from "../server/util";
import { makeTestEnv, type TestEnv } from "./helpers/env";

const require = createRequire(import.meta.url);
const SECRET = "test-secret-batch1";

let env: TestEnv;
let adapter: MCPAdapter;
let tools: DynamicStructuredTool[];

const byName = (name: string): DynamicStructuredTool => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`缺少工具 ${name}`);
  return t;
};

/** 以带 toolCall 的 config 调用 → 成功/失败都以 ToolMessage 返回（不抛异常） */
async function call(name: string, args: Record<string, unknown>) {
  const raw = byName(name);
  return (await raw.invoke(args, { toolCall: { id: `call-${name}`, name, args, type: "tool_call" } })) as {
    status?: string;
    text: string;
    content: unknown;
    artifact?: Array<{ type: string; data?: any }>;
  };
}

const authed = (customerId: string, extra: Record<string, unknown> = {}) => ({
  customer_id: customerId,
  context_token: signContextToken(SECRET, customerId),
  ...extra,
});

function structured(msg: Awaited<ReturnType<typeof call>>): any {
  const item = msg.artifact?.find((a) => a.type === "mcp_structured_content");
  expect(item, "artifact 应含 mcp_structured_content").toBeTruthy();
  return item!.data;
}

beforeAll(async () => {
  env = makeTestEnv();
  // 准备临时库：迁移 + 种子 + 一条退款申请（用于 get_refund_status）
  const db = openDb(env.dbPath);
  migrate(db);
  seed(db);
  const repos = createRepos(db);
  const at = "2026-10-30T01:00:00.000Z";
  repos.tickets.insert({ id: "TK-TEST000001", customer_id: "cust_a", seat_id: null, status: "queued", subject: "退款", created_at: at, updated_at: at });
  repos.conversations.insert({
    id: "CV-TEST000001", ticket_id: "TK-TEST000001", customer_id: "cust_a", channel: "web", channel_session_id: "web:CV-TEST000001",
    thread_id: "conv_test-1", handling_mode: "ai", ai_generation: 0, created_at: at, updated_at: at,
  });
  repos.refunds.insert({
    id: "RF-20261030-AAAAAA", customer_id: "cust_a", ticket_id: "TK-TEST000001", conversation_id: "CV-TEST000001", order_id: "ORD-1001",
    amount_minor: 59900, currency: "CNY", reason: "质量问题", evidence_json: "{}", version: 1, status: "pending_review",
    idempotency_key: "refund:ORD-1001:v1", thread_id: "refund:RF-20261030-AAAAAA:a1", attempt: 1, failure_reason: null,
    flow_completed_at: null, created_at: at, updated_at: at,
  });
  db.close();

  const processEnv = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  adapter = new MCPAdapter({
    servers: {
      orders: {
        command: process.execPath,
        args: [require.resolve("tsx/cli"), path.join(PROJECT_ROOT, "mcp-server/index.ts")],
        env: { ...processEnv, DB_PATH: env.dbPath, MCP_SHARED_SECRET: SECRET },
        cwd: PROJECT_ROOT,
        stderr: "inherit",
      },
    },
  });
  tools = await adapter.listTools();
});

afterAll(async () => {
  await adapter?.close();
  env?.cleanup();
});

describe("auth", () => {
  it("签名可验证；错误令牌、长度不等、他人令牌均失败", () => {
    const t = signContextToken("s3cret-key", "cust_a");
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyContextToken("s3cret-key", "cust_a", t)).toBe(true);
    expect(verifyContextToken("s3cret-key", "cust_b", t)).toBe(false);
    expect(verifyContextToken("other-key", "cust_a", t)).toBe(false);
    expect(verifyContextToken("s3cret-key", "cust_a", "short")).toBe(false);
  });
});

describe("MCP orders server（真实子进程）", () => {
  it("listTools 返回四个 orders_* 工具，且 inputSchema 含可信字段、readOnlyHint=true", () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      "orders_get_order",
      "orders_get_payment_status",
      "orders_get_refund_status",
      "orders_list_orders",
    ]);
    const schema = JSON.stringify((byName("orders_get_order") as any).schema);
    expect(schema).toContain("customer_id");
    expect(schema).toContain("context_token");
    for (const t of tools) expect((t as any).metadata?.annotations?.readOnlyHint).toBe(true);
  });

  it("正确 token + 本人订单 → 成功，artifact 含 mcp_structured_content 且由另一进程提供", async () => {
    const msg = await call("orders_get_order", authed("cust_a", { order_id: "ORD-1001" }));
    expect(msg.status).not.toBe("error");
    const data = structured(msg);
    expect(data.order).toMatchObject({
      orderId: "ORD-1001",
      title: "无线降噪耳机",
      amountMinor: 59900,
      paymentStatus: "paid",
      paymentStatusText: "已支付",
      shippingStatus: "shipped",
      shippingStatusText: "已发货",
      trackingNo: "SF1000000001",
    });
    expect(data.order.customerId).toBeUndefined();
    expect(data.served_by.server).toBe("orders-mcp");
    expect(data.served_by.pid).toBeTypeOf("number");
    expect(data.served_by.pid).not.toBe(process.pid);
    expect(msg.artifact?.some((a) => a.type === "mcp_meta")).toBe(true);
  });

  it("他人订单 → status=error 且文本以 FORBIDDEN: 开头", async () => {
    const msg = await call("orders_get_order", authed("cust_a", { order_id: "ORD-1003" }));
    expect(msg.status).toBe("error");
    expect(msg.text.startsWith("FORBIDDEN:")).toBe(true);
    expect(msg.artifact?.some((a) => a.type === "mcp_structured_content") ?? false).toBe(false);
  });

  it("错误 token → UNAUTHORIZED:", async () => {
    const bad = await call("orders_get_order", { order_id: "ORD-1001", customer_id: "cust_a", context_token: "0".repeat(64) });
    expect(bad.status).toBe("error");
    expect(bad.text.startsWith("UNAUTHORIZED:")).toBe(true);
    // 用他人的令牌冒充
    const forged = await call("orders_get_order", {
      order_id: "ORD-1001", customer_id: "cust_a", context_token: signContextToken(SECRET, "cust_b"),
    });
    expect(forged.status).toBe("error");
    expect(forged.text.startsWith("UNAUTHORIZED:")).toBe(true);
  });

  it("订单不存在 → NOT_FOUND:", async () => {
    const msg = await call("orders_get_order", authed("cust_a", { order_id: "ORD-9999" }));
    expect(msg.status).toBe("error");
    expect(msg.text.startsWith("NOT_FOUND:")).toBe(true);
  });

  it("list_orders 只返回本人订单", async () => {
    const data = structured(await call("orders_list_orders", authed("cust_a")));
    expect(data.orders.map((o: any) => o.orderId).sort()).toEqual(["ORD-1001", "ORD-1002", "ORD-1007"]);
    const dataB = structured(await call("orders_list_orders", authed("cust_b")));
    expect(dataB.orders.map((o: any) => o.orderId).sort()).toEqual(["ORD-1003", "ORD-1004"]);
  });

  it("get_payment_status：本人成功，他人 FORBIDDEN", async () => {
    const data = structured(await call("orders_get_payment_status", authed("cust_c", { order_id: "ORD-1006" })));
    expect(data.payment).toMatchObject({ paymentId: "PAY-1006", status: "failed", statusText: "支付失败", failureReason: "银行卡余额不足" });
    expect(data.orderPaymentStatus).toBe("unpaid");
    expect(data.orderPaymentStatusText).toBe("未支付");
    const denied = await call("orders_get_payment_status", authed("cust_c", { order_id: "ORD-1001" }));
    expect(denied.status).toBe("error");
    expect(denied.text.startsWith("FORBIDDEN:")).toBe(true);
  });

  it("get_refund_status：按订单号 / 申请编号查询，归属校验，参数缺失", async () => {
    const byOrder = structured(await call("orders_get_refund_status", authed("cust_a", { order_id: "ORD-1001" })));
    expect(byOrder.refunds).toHaveLength(1);
    expect(byOrder.refunds[0]).toMatchObject({ requestId: "RF-20261030-AAAAAA", status: "pending_review", statusText: "待审核", amountMinor: 59900 });
    const byId = structured(await call("orders_get_refund_status", authed("cust_a", { refund_request_id: "RF-20261030-AAAAAA" })));
    expect(byId.refunds[0].requestId).toBe("RF-20261030-AAAAAA");
    expect(byId.refunds[0].customerId).toBeUndefined();

    const otherId = await call("orders_get_refund_status", authed("cust_b", { refund_request_id: "RF-20261030-AAAAAA" }));
    expect(otherId.status).toBe("error");
    expect(otherId.text.startsWith("FORBIDDEN:")).toBe(true);
    const otherOrder = await call("orders_get_refund_status", authed("cust_b", { order_id: "ORD-1001" }));
    expect(otherOrder.text.startsWith("FORBIDDEN:")).toBe(true);
    const missing = await call("orders_get_refund_status", authed("cust_a"));
    expect(missing.status).toBe("error");
    expect(missing.text.startsWith("INVALID_ARGUMENT:")).toBe(true);
    const none = await call("orders_get_refund_status", authed("cust_a", { refund_request_id: "RF-NOPE" }));
    expect(none.text.startsWith("NOT_FOUND:")).toBe(true);
  });

  it("execution_logs 中出现 scope='mcp' 的 call / denied 审计记录（证明经过 MCP 进程）", () => {
    const db = new Database(env.dbPath, { readonly: true });
    try {
      const rows = db
        .prepare("SELECT node, event, detail_json FROM execution_logs WHERE scope = 'mcp' ORDER BY id")
        .all() as Array<{ node: string; event: string; detail_json: string }>;
      const events = new Set(rows.map((r) => r.event));
      expect(events.has("call")).toBe(true);
      expect(events.has("denied")).toBe(true);
      const denied = rows.filter((r) => r.event === "denied").map((r) => JSON.parse(r.detail_json));
      expect(denied.some((d) => d.reason === "not_owner")).toBe(true);
      expect(denied.some((d) => d.reason === "bad_token")).toBe(true);
      const call1 = rows.find((r) => r.event === "call" && r.node === "get_order");
      expect(call1).toBeTruthy();
      const detail = JSON.parse(call1!.detail_json);
      expect(detail.customerId).toBe("cust_a");
      expect(detail.orderId).toBe("ORD-1001");
      expect(detail.pid).not.toBe(process.pid);
    } finally {
      db.close();
    }
  });
});

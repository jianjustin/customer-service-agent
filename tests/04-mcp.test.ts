// 验证矩阵 #4：真实 MCP 子进程、越权拒绝、身份由服务端注入（SPEC §K.2 第 4 条）。
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { FakeToolCallingModel } from "langchain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestContainer, lastAiMessage, makeTestEnv, sendAndWait, type Container, type TestEnv } from "./helpers/env";
import { signContextToken } from "../mcp-server/auth";

let env: TestEnv;
let c: Container | null = null;

beforeEach(() => {
  env = makeTestEnv();
});
afterEach(async () => {
  await c?.close();
  c = null;
  env.cleanup();
});

async function threadToolMessages(cc: Container, conversationId: string, name: string): Promise<ToolMessage[]> {
  const conv = cc.repos.conversations.get(conversationId)!;
  const msgs = await cc.agent!.getThreadMessages(conv.thread_id);
  return msgs.filter((m): m is ToolMessage => ToolMessage.isInstance(m) && m.name === name);
}

const mcpLogCount = (cc: Container, event: string): number =>
  (cc.db.prepare("SELECT COUNT(*) AS n FROM execution_logs WHERE scope = 'mcp' AND event = ?").get(event) as { n: number }).n;

describe("真实 MCP 链路", () => {
  it("“我的订单”：ToolMessage 来自另一进程（mcp_structured_content），回复只含本人订单", async () => {
    c = await buildTestContainer(env);
    const r = await sendAndWait(c, "cust_a", "我的订单");
    expect(r.outcome?.status).toBe("completed");

    const [tm] = await threadToolMessages(c, r.conversation.id, "orders_list_orders");
    expect(tm).toBeTruthy();
    expect(tm!.status).not.toBe("error");
    const art = tm!.artifact as Array<{ type: string; data?: any }>;
    const structured = art.find((a) => a.type === "mcp_structured_content");
    expect(structured).toBeTruthy();
    expect(structured!.data.served_by.server).toBe("orders-mcp");
    expect(structured!.data.served_by.pid).not.toBe(process.pid);
    expect(mcpLogCount(c, "call")).toBeGreaterThanOrEqual(1);

    const text = lastAiMessage(c, r.conversation.id)!.content;
    expect(text).toContain("ORD-1001");
    expect(text).toContain("ORD-1002");
    expect(text).toContain("ORD-1007");
    expect(text).not.toContain("ORD-1003");
  });

  it("越权：他人订单被 MCP 拒绝（FORBIDDEN），回复不泄露订单信息", async () => {
    c = await buildTestContainer(env);
    const r = await sendAndWait(c, "cust_a", "帮我查一下订单 ORD-1003");
    expect(r.outcome?.status).toBe("completed");

    const [tm] = await threadToolMessages(c, r.conversation.id, "orders_get_order");
    expect(tm!.status).toBe("error");
    expect(tm!.text.startsWith("FORBIDDEN:")).toBe(true);
    expect(mcpLogCount(c, "denied")).toBeGreaterThanOrEqual(1);

    const text = lastAiMessage(c, r.conversation.id)!.content;
    expect(text).toContain("不属于您当前登录的账户");
    for (const leak of ["智能手表", "129900", "¥1299.00"]) expect(text).not.toContain(leak);
    // 摘要记录越权被拒
    expect(c.repos.tickets.get(r.ticket.id)!.ai_summary).toContain("ORD-1003：查询被拒绝（非本人订单）");
  });

  it("单个订单与不存在的订单", async () => {
    c = await buildTestContainer(env);
    const ok = await sendAndWait(c, "cust_a", "帮我查一下订单 ORD-1001");
    expect(lastAiMessage(c, ok.conversation.id)!.content).toContain("订单 ORD-1001（无线降噪耳机）：金额 ¥599.00，支付状态：已支付");
    const none = await sendAndWait(c, "cust_a", "帮我查一下订单 ORD-9999");
    expect(lastAiMessage(c, none.conversation.id)!.content).toContain("没有找到该订单");
  });

  it("模型伪造 customer_id / context_token 被丢弃，并以可信 cust_a 覆盖（仍 FORBIDDEN）", async () => {
    const model = new FakeToolCallingModel({
      toolCalls: [[{ name: "orders_get_order", args: { order_id: "ORD-1003", customer_id: "cust_b", context_token: "forged" }, id: "fake1" }], []],
    });
    c = await buildTestContainer(env, { modelOverride: model });
    expect(c.modelInfo.label).toBe("测试脚本模型");
    const r = await sendAndWait(c, "cust_a", "随便说点什么");
    expect(r.outcome?.status).toBe("completed");

    const [tm] = await threadToolMessages(c, r.conversation.id, "orders_get_order");
    expect(tm!.status).toBe("error");
    expect(tm!.text).toContain("FORBIDDEN");
    // 审计：MCP 子进程看到的 customerId 是可信的 cust_a，而不是模型伪造的 cust_b
    const rows = c.db
      .prepare("SELECT detail_json FROM execution_logs WHERE scope = 'mcp' AND event = 'denied'")
      .all() as Array<{ detail_json: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.map((x) => JSON.parse(x.detail_json).customerId)).toEqual(expect.arrayContaining(["cust_a"]));
    expect(rows.map((x) => JSON.parse(x.detail_json).customerId)).not.toContain("cust_b");
    // 主进程日志里记录的模型参数不含身份字段
    const logs = c.repos.logs.list("conversation", r.conversation.id).filter((l) => l.event === "mcp_tool_call");
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!.detail_json).args).toEqual({ order_id: "ORD-1003" });
  });

  it("模型可见的 schema 不含 customer_id / context_token", async () => {
    c = await buildTestContainer(env);
    const tools = c.mcp!.tools;
    expect(tools.map((t) => t.name)).toEqual([
      "orders_list_orders",
      "orders_get_order",
      "orders_get_payment_status",
      "orders_get_refund_status",
    ]);
    const getOrder = tools.find((t) => t.name === "orders_get_order") as any;
    expect(Object.keys(getOrder.schema.shape)).toEqual(["order_id"]);
    for (const t of tools) {
      const json = JSON.stringify((t as any).schema.shape ? Object.keys((t as any).schema.shape) : []);
      expect(json).not.toMatch(/customer_id|context_token/);
    }
    // 原始工具仍带可信字段（仅服务端使用）
    const raw = c.mcp!.rawTools.find((t) => t.name === "orders_get_order") as any;
    expect(Object.keys(raw.schema.properties ?? raw.schema.shape ?? {})).toEqual(expect.arrayContaining(["customer_id", "context_token"]));
  });

  it("直接调用原始 MCP 工具：错误 token → UNAUTHORIZED；正确 token 成功", async () => {
    c = await buildTestContainer(env);
    const raw = c.mcp!.rawTools.find((t) => t.name === "orders_get_order")!;
    const cfg = { toolCall: { id: "t1", name: "orders_get_order", args: {}, type: "tool_call" as const } };
    const bad = (await raw.invoke({ order_id: "ORD-1001", customer_id: "cust_a", context_token: "bad" }, cfg)) as ToolMessage;
    expect(bad.status).toBe("error");
    expect(bad.text.startsWith("UNAUTHORIZED:")).toBe(true);
    const good = (await raw.invoke(
      { order_id: "ORD-1001", customer_id: "cust_a", context_token: signContextToken(c.config.mcpSharedSecret, "cust_a") },
      cfg,
    )) as ToolMessage;
    expect(good.status).not.toBe("error");
  });

  it("包装工具缺少可信上下文时拒绝执行", async () => {
    c = await buildTestContainer(env);
    const wrapped = c.mcp!.tools.find((t) => t.name === "orders_list_orders")!;
    await expect(wrapped.invoke({}, { toolCall: { id: "x", name: "orders_list_orders", args: {}, type: "tool_call" } })).rejects.toThrow();
  });

  it("MCP 工具调用异常 → UNAVAILABLE 错误 ToolMessage，AI 回复通用不可用文案", async () => {
    c = await buildTestContainer(env);
    // 关闭 MCP 子进程后再对话，模拟服务不可用
    await c.mcp!.close();
    const r = await sendAndWait(c, "cust_a", "我的订单");
    expect(r.outcome?.status).toBe("completed");
    const [tm] = await threadToolMessages(c, r.conversation.id, "orders_list_orders");
    expect(tm!.status).toBe("error");
    expect(tm!.text.startsWith("UNAVAILABLE:")).toBe(true);
    const text = lastAiMessage(c, r.conversation.id)!.content;
    expect(text).toContain("订单服务暂时不可用");
    expect(text).not.toMatch(/orders_|MCP|customer_id/);
    // 线程里是 AIMessage 序列的最终回复
    const conv = c.repos.conversations.get(r.conversation.id)!;
    const msgs = await c.agent!.getThreadMessages(conv.thread_id);
    expect(AIMessage.isInstance(msgs[msgs.length - 1]!)).toBe(true);
  });
});

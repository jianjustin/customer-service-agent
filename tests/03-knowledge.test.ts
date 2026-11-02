// 验证矩阵 #3：知识回答有来源、未知问题不编造（SPEC §K.2 第 3 条）。
// 检索算法本身的逐行断言见 tests/unit-knowledge.test.ts。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestContainer, lastAiMessage, makeTestEnv, sendAndWait, type Container, type TestEnv } from "./helpers/env";
import { call, startHttp } from "./helpers/http";

let env: TestEnv;
let c: Container;

beforeEach(async () => {
  env = makeTestEnv();
  c = await buildTestContainer(env);
});
afterEach(async () => {
  await c.close();
  env.cleanup();
});

describe("知识问答", () => {
  it("命中知识：回复以 [Mock 模式] 开头，含标题版本，sources_json 与 HTTP sources 一致", async () => {
    const r = await sendAndWait(c, "cust_a", "怎么修改收货地址？");
    expect(r.outcome?.status).toBe("completed");
    const ai = lastAiMessage(c, r.conversation.id)!;
    expect(ai.content.startsWith("[Mock 模式] ")).toBe(true);
    expect(ai.content).toContain("《修改收货地址》v2");
    expect(ai.content).toContain("来源：《修改收货地址》v2");
    expect(JSON.parse(ai.sources_json)).toEqual([{ id: "kb-001", title: "修改收货地址", version: 2 }]);

    const http = await startHttp(c);
    try {
      const res = await call(http.baseUrl, "GET", `/api/customer/tickets/${r.ticket.id}/messages?afterSeq=0`, { role: "customer", id: "cust_a" });
      expect(res.status).toBe(200);
      const aiDto = res.body.messages.find((m: any) => m.senderType === "ai");
      expect(aiDto.sources).toEqual([{ id: "kb-001", title: "修改收货地址", version: 2 }]);
      // 面向客户的文本不得泄露工具名 / 内部字段
      for (const m of res.body.messages) {
        expect(m.content).not.toMatch(/search_knowledge|customer_id|context_token|thread_id|MCP/);
      }
    } finally {
      await http.close();
    }

    // 工具调用日志与摘要的“知识来源”
    expect(c.repos.logs.count("conversation", { node: "search_knowledge", event: "tool_call" })).toBe(1);
    const summary = c.repos.tickets.get(r.ticket.id)!.ai_summary ?? "";
    expect(summary).toContain("【知识来源】《修改收货地址》v2");
  });

  it("未知问题：明确说明无依据并建议转人工，不编造、无来源", async () => {
    const r = await sendAndWait(c, "cust_a", "你们对宠物保险的理赔政策是什么？");
    expect(r.outcome?.status).toBe("completed");
    const ai = lastAiMessage(c, r.conversation.id)!;
    expect(ai.content).toContain("没有找到可以支持回答该问题的依据");
    expect(ai.content).toContain("转人工");
    expect(ai.content).not.toContain("《");
    expect(JSON.parse(ai.sources_json)).toEqual([]);

    const http = await startHttp(c);
    try {
      const res = await call(http.baseUrl, "GET", `/api/customer/tickets/${r.ticket.id}/messages?afterSeq=0`, { role: "customer", id: "cust_a" });
      const aiDto = res.body.messages.find((m: any) => m.senderType === "ai");
      expect(aiDto.sources).toEqual([]);
    } finally {
      await http.close();
    }
  });

  it("多个来源：只保留最终回复中引用的条目；问候不触发检索", async () => {
    const hello = await sendAndWait(c, "cust_b", "你好");
    expect(lastAiMessage(c, hello.conversation.id)!.content).toContain("请问有什么可以帮您");
    expect(c.repos.logs.count("conversation", { node: "search_knowledge" })).toBe(0);

    const r = await sendAndWait(c, "cust_b", "退款多久到账");
    const ai = lastAiMessage(c, r.conversation.id)!;
    const sources = JSON.parse(ai.sources_json) as Array<{ id: string; title: string; version: number }>;
    expect(sources.length).toBeGreaterThanOrEqual(1);
    for (const s of sources) expect(ai.content).toContain(`《${s.title}》v${s.version}`);
  });
});

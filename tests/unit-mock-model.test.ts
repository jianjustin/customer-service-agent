// MockChatModel 规则单元测试（SPEC §K.2「单元测试」）：直接调用 decideMockResponse。
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { decideMockResponse, MOCK_PREFIX } from "../server/agent/mock-model";

const ALL_TOOLS = [
  "search_knowledge",
  "orders_list_orders",
  "orders_get_order",
  "orders_get_payment_status",
  "orders_get_refund_status",
  "submit_refund_request",
  "get_refund_progress",
  "request_human_handover",
];

const ORDER_1001 = {
  orderId: "ORD-1001",
  title: "无线降噪耳机",
  amountMinor: 59900,
  paymentStatus: "paid",
  paymentStatusText: "已支付",
  shippingStatus: "shipped",
  shippingStatusText: "已发货",
  trackingNo: "SF1000000001",
  refundNote: null,
};

/** 模拟 MCP 成功结果：content 为 JSON 文本，artifact 含 mcp_structured_content */
function mcpOk(name: string, callId: string, data: Record<string, unknown>): ToolMessage {
  return new ToolMessage({
    name,
    tool_call_id: callId,
    content: JSON.stringify(data),
    artifact: [{ type: "mcp_structured_content", data }],
  });
}
function mcpErr(name: string, callId: string, text: string): ToolMessage {
  return new ToolMessage({ name, tool_call_id: callId, status: "error", content: text });
}
function localOk(name: string, callId: string, content: unknown, artifact: unknown): ToolMessage {
  return new ToolMessage({ name, tool_call_id: callId, content: JSON.stringify(content), artifact });
}

const base = (text: string, ...rest: BaseMessage[]): BaseMessage[] => [new SystemMessage("sys"), new HumanMessage(text), ...rest];

const callMsg = (calls: Array<[string, Record<string, unknown>, string]>) =>
  new AIMessage({ content: "", tool_calls: calls.map(([name, args, id]) => ({ id, name, args, type: "tool_call" as const })) });

function expectFinal(m: AIMessage): string {
  expect(m.tool_calls ?? []).toHaveLength(0);
  expect(m.text.startsWith(MOCK_PREFIX)).toBe(true);
  return m.text;
}

describe("decideMockResponse：意图与步骤", () => {
  it("问候 → 固定欢迎语（无工具调用）", () => {
    for (const hi of ["你好", "您好！", "Hello", "在吗"]) {
      expect(expectFinal(decideMockResponse(base(hi), ALL_TOOLS))).toContain("请问有什么可以帮您");
    }
  });

  it("退款申请缺理由：先同一条消息并行查订单与支付；再要理由", () => {
    const first = decideMockResponse(base("我要申请退款 ORD-1001"), ALL_TOOLS);
    expect(first.tool_calls?.map((t) => t.name)).toEqual(["orders_get_order", "orders_get_payment_status"]);
    expect(first.tool_calls?.map((t) => t.args)).toEqual([{ order_id: "ORD-1001" }, { order_id: "ORD-1001" }]);
    expect(first.text).toBe("");

    const msgs = base(
      "我要申请退款 ORD-1001",
      callMsg([
        ["orders_get_order", { order_id: "ORD-1001" }, "c1"],
        ["orders_get_payment_status", { order_id: "ORD-1001" }, "c2"],
      ]),
      mcpOk("orders_get_order", "c1", { order: ORDER_1001 }),
      mcpOk("orders_get_payment_status", "c2", { payment: { status: "succeeded", statusText: "支付成功" }, orderPaymentStatus: "paid" }),
    );
    const text = expectFinal(decideMockResponse(msgs, ALL_TOOLS));
    expect(text).toContain("请告诉我退款理由");
    expect(text).toContain("ORD-1001");
  });

  it("有理由且已核对 → 调用 submit_refund_request；提交结果 → 固定话术（不说已退款）", () => {
    const checked = [
      callMsg([
        ["orders_get_order", { order_id: "ORD-1005" }, "c1"],
        ["orders_get_payment_status", { order_id: "ORD-1005" }, "c2"],
      ]),
      mcpOk("orders_get_order", "c1", { order: { ...ORDER_1001, orderId: "ORD-1005" } }),
      mcpOk("orders_get_payment_status", "c2", { payment: { status: "succeeded", statusText: "支付成功" } }),
    ];
    const text = "ORD-1005 申请退款，原因是不想要了";
    const submit = decideMockResponse(base(text, ...checked), ALL_TOOLS);
    expect(submit.tool_calls).toHaveLength(1);
    expect(submit.tool_calls![0]).toMatchObject({ name: "submit_refund_request", args: { order_id: "ORD-1005", reason: "不想要了" } });

    const done = decideMockResponse(
      base(
        text,
        ...checked,
        callMsg([["submit_refund_request", { order_id: "ORD-1005", reason: "不想要了" }, "c3"]]),
        localOk(
          "submit_refund_request",
          "c3",
          { ok: true, existing: false, requestId: "RF-20261102-ABCDEF", orderId: "ORD-1005", amountMinor: 8800, status: "pending_review", statusText: "待审核" },
          { kind: "refund_submit", result: {} },
        ),
      ),
      ALL_TOOLS,
    );
    const out = expectFinal(done);
    expect(out).toContain("已为您提交退款申请 RF-20261102-ABCDEF");
    expect(out).toContain("退款尚未完成");
    expect(out).not.toContain("已退款");
  });

  it("追问续接：上一轮要理由 + 本轮“原因是质量问题” → 取上一轮订单号并提交", () => {
    const history: BaseMessage[] = [
      new HumanMessage("我要申请退款 ORD-1001"),
      new AIMessage(`${MOCK_PREFIX}已核对订单 ORD-1001（无线降噪耳机，已支付 ¥599.00）。请告诉我退款理由，例如：“原因是质量问题”。`),
    ];
    const msgs = [new SystemMessage("sys"), ...history, new HumanMessage("原因是质量问题")];
    const first = decideMockResponse(msgs, ALL_TOOLS);
    expect(first.tool_calls?.map((t) => t.name)).toEqual(["orders_get_order", "orders_get_payment_status"]);
    const withResults = [
      ...msgs,
      callMsg([
        ["orders_get_order", { order_id: "ORD-1001" }, "c1"],
        ["orders_get_payment_status", { order_id: "ORD-1001" }, "c2"],
      ]),
      mcpOk("orders_get_order", "c1", { order: ORDER_1001 }),
      mcpOk("orders_get_payment_status", "c2", { payment: { status: "succeeded", statusText: "支付成功" } }),
    ];
    const submit = decideMockResponse(withResults, ALL_TOOLS);
    expect(submit.tool_calls![0]).toMatchObject({ name: "submit_refund_request", args: { order_id: "ORD-1001", reason: "质量问题" } });
  });

  it("FORBIDDEN 错误 → 解释“不属于您当前登录的账户”，不泄露订单信息", () => {
    const msgs = base(
      "帮我查一下订单 ORD-1003",
      callMsg([["orders_get_order", { order_id: "ORD-1003" }, "c1"]]),
      mcpErr("orders_get_order", "c1", "FORBIDDEN: 该订单不属于当前客户，无权访问"),
    );
    const text = expectFinal(decideMockResponse(msgs, ALL_TOOLS));
    expect(text).toContain("不属于您当前登录的账户");
    expect(text).not.toContain("智能手表");
    // 退款流程中同样处理
    const refundMsgs = base(
      "我要申请退款 ORD-1003",
      callMsg([
        ["orders_get_order", { order_id: "ORD-1003" }, "c1"],
        ["orders_get_payment_status", { order_id: "ORD-1003" }, "c2"],
      ]),
      mcpErr("orders_get_order", "c1", "FORBIDDEN: x"),
      mcpErr("orders_get_payment_status", "c2", "FORBIDDEN: x"),
    );
    expect(expectFinal(decideMockResponse(refundMsgs, ALL_TOOLS))).toContain("不属于您当前登录的账户");
  });

  it("订单资格：未支付 / 已退款 / 支付记录非成功", () => {
    const mk = (order: Record<string, unknown>, payment: Record<string, unknown>) =>
      base(
        "我要申请退款 ORD-1002",
        callMsg([
          ["orders_get_order", { order_id: "ORD-1002" }, "c1"],
          ["orders_get_payment_status", { order_id: "ORD-1002" }, "c2"],
        ]),
        mcpOk("orders_get_order", "c1", { order: { ...ORDER_1001, orderId: "ORD-1002", ...order } }),
        mcpOk("orders_get_payment_status", "c2", { payment }),
      );
    expect(expectFinal(decideMockResponse(mk({ paymentStatus: "unpaid" }, { status: "failed", statusText: "支付失败" }), ALL_TOOLS))).toContain("尚未支付");
    expect(expectFinal(decideMockResponse(mk({ paymentStatus: "refunded" }, { status: "refunded", statusText: "已退款" }), ALL_TOOLS))).toContain("无需重复申请");
    expect(expectFinal(decideMockResponse(mk({ paymentStatus: "paid" }, { status: "pending", statusText: "处理中" }), ALL_TOOLS))).toContain("暂不满足退款条件");
  });

  it("未带订单号的退款申请：先列订单，再列出已支付订单请客户选择", () => {
    const first = decideMockResponse(base("我想退款"), ALL_TOOLS);
    expect(first.tool_calls?.map((t) => t.name)).toEqual(["orders_list_orders"]);
    const text = expectFinal(
      decideMockResponse(
        base(
          "我想退款",
          callMsg([["orders_list_orders", {}, "c1"]]),
          mcpOk("orders_list_orders", "c1", {
            orders: [ORDER_1001, { ...ORDER_1001, orderId: "ORD-1002", paymentStatus: "unpaid", title: "手机壳" }],
          }),
        ),
        ALL_TOOLS,
      ),
    );
    expect(text).toContain("请问您要为哪笔订单申请退款");
    expect(text).toContain("ORD-1001");
    expect(text).not.toContain("ORD-1002");
  });

  it("订单查询：列表与单个订单", () => {
    const first = decideMockResponse(base("我的订单"), ALL_TOOLS);
    expect(first.tool_calls?.[0]).toMatchObject({ name: "orders_list_orders", args: {} });
    const list = expectFinal(
      decideMockResponse(
        base("我的订单", callMsg([["orders_list_orders", {}, "c1"]]), mcpOk("orders_list_orders", "c1", { orders: [ORDER_1001] })),
        ALL_TOOLS,
      ),
    );
    expect(list).toContain("您名下共有 1 笔订单");
    expect(list).toContain("- ORD-1001 无线降噪耳机：¥599.00，已支付，已发货");

    const one = expectFinal(
      decideMockResponse(
        base("帮我查一下订单 ord-1001", callMsg([["orders_get_order", { order_id: "ORD-1001" }, "c1"]]), mcpOk("orders_get_order", "c1", { order: ORDER_1001 })),
        ALL_TOOLS,
      ),
    );
    expect(one).toBe(`${MOCK_PREFIX}订单 ORD-1001（无线降噪耳机）：金额 ¥599.00，支付状态：已支付，物流状态：已发货，运单号 SF1000000001。`);
  });

  it("知识问答：命中带来源，未命中提示无依据", () => {
    const first = decideMockResponse(base("怎么修改收货地址？"), ALL_TOOLS);
    expect(first.tool_calls?.[0]).toMatchObject({ name: "search_knowledge", args: { query: "怎么修改收货地址？" } });
    const hit = { id: "kb-001", title: "修改收货地址", version: 2, snippet: "发货前可在订单详情修改。" };
    const withHit = base(
      "怎么修改收货地址？",
      callMsg([["search_knowledge", { query: "怎么修改收货地址？" }, "c1"]]),
      localOk("search_knowledge", "c1", { found: true, hits: [{ title: hit.title, version: 2, snippet: hit.snippet }] }, { kind: "knowledge", hits: [hit] }),
    );
    const text = expectFinal(decideMockResponse(withHit, ALL_TOOLS));
    expect(text).toContain("根据《修改收货地址》v2：发货前可在订单详情修改。");
    expect(text).toContain("来源：《修改收货地址》v2");

    const empty = base(
      "你们对宠物保险的理赔政策是什么？",
      callMsg([["search_knowledge", { query: "x" }, "c1"]]),
      localOk("search_knowledge", "c1", { found: false, message: "知识库中没有找到相关依据" }, { kind: "knowledge", hits: [] }),
    );
    const none = expectFinal(decideMockResponse(empty, ALL_TOOLS));
    expect(none).toContain("没有找到可以支持回答该问题的依据");
    expect(none).toContain("转人工");
    expect(none).not.toContain("《");
  });

  it("“退款多久到账”走知识问答而非退款流程", () => {
    expect(decideMockResponse(base("退款多久到账"), ALL_TOOLS).tool_calls?.[0]?.name).toBe("search_knowledge");
  });

  it("转人工与退款进度", () => {
    const h = decideMockResponse(base("我要转人工"), ALL_TOOLS);
    expect(h.tool_calls?.[0]).toMatchObject({ name: "request_human_handover", args: { reason: "我要转人工" } });
    const ok = base(
      "我要转人工",
      callMsg([["request_human_handover", { reason: "我要转人工" }, "c1"]]),
      localOk("request_human_handover", "c1", { ok: true, message: "已登记转人工申请" }, { kind: "handover" }),
    );
    expect(expectFinal(decideMockResponse(ok, ALL_TOOLS))).toContain("已为您申请转接人工客服");
    // “人工客服的工作时间”不触发转人工
    expect(decideMockResponse(base("人工客服的工作时间是几点"), ALL_TOOLS).tool_calls?.[0]?.name).toBe("search_knowledge");

    const p = decideMockResponse(base("我的退款进度怎么样了"), ALL_TOOLS);
    expect(p.tool_calls?.[0]?.name).toBe("get_refund_progress");
    const progress = base(
      "我的退款进度怎么样了",
      callMsg([["get_refund_progress", {}, "c1"]]),
      localOk(
        "get_refund_progress",
        "c1",
        { refunds: [{ requestId: "RF-1", orderId: "ORD-1001", status: "pending_review", statusText: "待审核", amountMinor: 59900, decisionComment: null }] },
        { kind: "refund_progress", refunds: [] },
      ),
    );
    const t = expectFinal(decideMockResponse(progress, ALL_TOOLS));
    expect(t).toContain("- RF-1（订单 ORD-1001，金额 ¥599.00）：待审核");
    expect(t).toContain("会通过系统消息通知您");
    const empty = base(
      "退款进度",
      callMsg([["get_refund_progress", {}, "c1"]]),
      localOk("get_refund_progress", "c1", { refunds: [] }, { kind: "refund_progress", refunds: [] }),
    );
    expect(expectFinal(decideMockResponse(empty, ALL_TOOLS))).toContain("没有退款申请记录");
  });

  it("工具不可用 → UNAVAILABLE；工具调用轮次 >= 4 → FALLBACK 兜底（防死循环）", () => {
    expect(expectFinal(decideMockResponse(base("我的订单"), []))).toContain("该功能暂不可用");
    const loop: BaseMessage[] = [];
    for (let i = 0; i < 4; i++) loop.push(callMsg([["search_knowledge", {}, `c${i}`]]), localOk("search_knowledge", `c${i}`, {}, { kind: "knowledge", hits: [] }));
    // 关闭 search 结果干扰：用订单查询场景，使其永远等待工具
    const text = expectFinal(decideMockResponse(base("怎么修改收货地址？", ...loop), ALL_TOOLS));
    expect(text).toContain("暂时无法完成该请求");
  });

  it("确定性：相同输入多次调用的文本一致；工具错误（UNAVAILABLE）回复通用不可用文案", () => {
    const msgs = base("我的订单", callMsg([["orders_list_orders", {}, "c1"]]), mcpErr("orders_list_orders", "c1", "UNAVAILABLE: 订单服务暂时不可用"));
    const a = decideMockResponse(msgs, ALL_TOOLS).text;
    expect(decideMockResponse(msgs, ALL_TOOLS).text).toBe(a);
    expect(a).toContain("订单服务暂时不可用");
  });
});

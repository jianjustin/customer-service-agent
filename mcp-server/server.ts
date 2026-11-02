// 订单只读 MCP Server（工具定义见 docs/SPEC.md §F.4）。
// 注意：本进程以 stdio 通信，stdout 是协议通道，日志只能写 stderr。
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { verifyContextToken } from "./auth";
import type { OrderReadRepository } from "./repo";

/** 可信字段：由主进程注入，模型不可见（主进程包装工具会隐藏并覆盖） */
const trusted = {
  customer_id: z.string().min(1).describe("由服务端注入"),
  context_token: z.string().min(1).describe("由服务端注入"),
};

const servedBy = () => ({ server: "orders-mcp", pid: process.pid });

function ok(data: Record<string, unknown>) {
  const out = { ...data, served_by: servedBy() };
  return { content: [{ type: "text" as const, text: JSON.stringify(out) }], structuredContent: out };
}

function err(code: string, message: string) {
  return { isError: true, content: [{ type: "text" as const, text: `${code}: ${message}` }] };
}

export function createOrdersMcpServer(deps: { repo: OrderReadRepository; secret: string }): McpServer {
  const { repo, secret } = deps;
  const server = new McpServer({ name: "orders", version: "0.1.0" });

  /** 审计失败不应拖垮查询，只在 stderr 留痕 */
  const audit = async (tool: string, event: "call" | "denied", customerId: string, detail: Record<string, unknown>) => {
    try {
      await repo.audit({ tool, event, customerId, detail });
    } catch (e) {
      process.stderr.write(`[orders-mcp] audit 写入失败：${e instanceof Error ? e.message : String(e)}\n`);
    }
  };

  /** 每个工具相同的前缀：令牌校验。通过返回 null，失败返回错误结果 */
  const checkToken = async (tool: string, args: { customer_id: string; context_token: string; order_id?: string }) => {
    if (verifyContextToken(secret, args.customer_id, args.context_token)) return null;
    await audit(tool, "denied", args.customer_id, { reason: "bad_token", orderId: args.order_id });
    return err("UNAUTHORIZED", "身份校验失败");
  };

  /** 订单存在且归属当前客户；否则返回错误结果 */
  const loadOwnedOrder = async (tool: string, customerId: string, orderId: string) => {
    const order = await repo.getOrder(orderId);
    if (!order) return { error: err("NOT_FOUND", "订单不存在") };
    if (order.customerId !== customerId) {
      await audit(tool, "denied", customerId, { reason: "not_owner", orderId });
      return { error: err("FORBIDDEN", "该订单不属于当前客户，无权访问") };
    }
    return { order };
  };

  server.registerTool(
    "list_orders",
    {
      title: "查询订单列表",
      description: "查询当前客户的全部订单，包括金额、支付状态与物流状态。",
      inputSchema: z.object({ ...trusted }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const denied = await checkToken("list_orders", args);
      if (denied) return denied;
      const orders = await repo.listOrders(args.customer_id);
      await audit("list_orders", "call", args.customer_id, { count: orders.length });
      return ok({ orders });
    },
  );

  server.registerTool(
    "get_order",
    {
      title: "查询订单详情",
      description: "按订单号查询当前客户的订单详情（金额、支付状态、物流状态、退款信息）。",
      inputSchema: z.object({ order_id: z.string().min(1), ...trusted }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const denied = await checkToken("get_order", args);
      if (denied) return denied;
      const r = await loadOwnedOrder("get_order", args.customer_id, args.order_id);
      if (r.error) return r.error;
      await audit("get_order", "call", args.customer_id, { orderId: args.order_id });
      const { customerId: _omit, ...order } = r.order;
      return ok({ order });
    },
  );

  server.registerTool(
    "get_payment_status",
    {
      title: "查询支付状态",
      description: "按订单号查询支付记录与支付状态。",
      inputSchema: z.object({ order_id: z.string().min(1), ...trusted }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const denied = await checkToken("get_payment_status", args);
      if (denied) return denied;
      const r = await loadOwnedOrder("get_payment_status", args.customer_id, args.order_id);
      if (r.error) return r.error;
      const payment = await repo.getPayment(args.order_id);
      if (!payment) return err("NOT_FOUND", "该订单没有支付记录");
      await audit("get_payment_status", "call", args.customer_id, { orderId: args.order_id });
      return ok({
        payment,
        orderPaymentStatus: r.order.paymentStatus,
        orderPaymentStatusText: r.order.paymentStatusText,
      });
    },
  );

  server.registerTool(
    "get_refund_status",
    {
      title: "查询退款状态",
      description: "按订单号或退款申请编号查询退款申请状态。",
      inputSchema: z.object({
        order_id: z.string().optional(),
        refund_request_id: z.string().optional(),
        ...trusted,
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const denied = await checkToken("get_refund_status", args);
      if (denied) return denied;
      if (!args.order_id && !args.refund_request_id) {
        return err("INVALID_ARGUMENT", "请提供订单号或退款申请编号");
      }
      if (args.refund_request_id) {
        const refund = await repo.getRefund(args.refund_request_id);
        if (!refund) return err("NOT_FOUND", "退款申请不存在");
        if (refund.customerId !== args.customer_id) {
          await audit("get_refund_status", "denied", args.customer_id, {
            reason: "not_owner",
            refundRequestId: args.refund_request_id,
            orderId: refund.orderId,
          });
          return err("FORBIDDEN", "该退款申请不属于当前客户，无权访问");
        }
        await audit("get_refund_status", "call", args.customer_id, {
          refundRequestId: args.refund_request_id,
          orderId: refund.orderId,
        });
        const { customerId: _omit, ...view } = refund;
        return ok({ refunds: [view] });
      }
      const r = await loadOwnedOrder("get_refund_status", args.customer_id, args.order_id!);
      if (r.error) return r.error;
      const refunds = await repo.listRefundsByOrder(args.order_id!);
      await audit("get_refund_status", "call", args.customer_id, { orderId: args.order_id });
      return ok({ refunds });
    },
  );

  return server;
}

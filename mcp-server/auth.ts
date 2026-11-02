// 可信上下文令牌：主进程用共享密钥对 customerId 做 HMAC-SHA256 签名，MCP 子进程校验。
// 主进程（server/agent/tools/mcp.ts）也 import 本文件的 signContextToken。
import { createHmac, timingSafeEqual } from "node:crypto";

export function signContextToken(secret: string, customerId: string): string {
  return createHmac("sha256", secret).update(customerId).digest("hex");
}

export function verifyContextToken(secret: string, customerId: string, token: string): boolean {
  const expected = Buffer.from(signContextToken(secret, customerId), "utf8");
  const actual = Buffer.from(token, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

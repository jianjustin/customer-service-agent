import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

/** 项目根目录（以 server/util.ts 所在位置推算，带结尾分隔符） */
export const PROJECT_ROOT: string = fileURLToPath(new URL("..", import.meta.url));

/** 当前 UTC 时间的 ISO 字符串（毫秒精度） */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 生成 `${prefix}-` + 10 位大写 base36 随机串，例如 TK-3F9K2A7QXZ */
export function randomId(prefix: string): string {
  const bytes = crypto.randomBytes(10);
  let s = "";
  for (const b of bytes) s += (b % 36).toString(36);
  return `${prefix}-${s.toUpperCase()}`;
}

/** 退款申请号 RF-YYYYMMDD-XXXXXX（日期为 UTC，6 位大写十六进制随机） */
export function newRefundId(now: Date = new Date()): string {
  const d = now.toISOString().slice(0, 10).replaceAll("-", "");
  const rand = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `RF-${d}-${rand}`;
}

/** 金额（分）→ 展示文本，例如 59900 → ¥599.00 */
export function formatMoney(minor: number): string {
  return `¥${(minor / 100).toFixed(2)}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

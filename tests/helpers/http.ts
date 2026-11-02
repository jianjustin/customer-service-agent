// HTTP 测试辅助（docs/SPEC.md §K.1）。
import type { AddressInfo } from "node:net";
import { createApp } from "../../server/app";
import type { Container } from "../../server/container";
import type { Role } from "../../server/domain/types";

export async function startHttp(c: Container): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createApp(c).listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

export async function call<T = any>(
  baseUrl: string,
  method: "GET" | "POST",
  path: string,
  who: { role: Role; id: string } | null,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (who) {
    headers["x-role"] = who.role;
    headers["x-actor-id"] = who.id;
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed as T };
}

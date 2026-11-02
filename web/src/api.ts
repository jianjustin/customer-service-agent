import type { Role } from "./types";

export type Identity = { role: Role; id: string };

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** 调用后端 API。path 形如 "/customer/tickets"（自动补 /api 前缀）。非 2xx 抛 ApiError。 */
export async function api<T>(
  identity: Identity | null,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (identity) {
    headers["x-role"] = identity.role;
    headers["x-actor-id"] = identity.id;
  }
  const url = path.startsWith("/api") ? path : `/api${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new ApiError(0, "NETWORK", "无法连接后端服务，请确认服务已启动");
  }
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? "HTTP_ERROR",
      err?.message ?? `请求失败（HTTP ${res.status}），后端服务可能尚未启动`,
    );
  }
  return json as T;
}

export function newClientId(): string {
  return crypto.randomUUID();
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

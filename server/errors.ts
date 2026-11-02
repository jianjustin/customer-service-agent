import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "TICKET_CLOSED"
  | "NOT_TAKEN_OVER"
  | "SEAT_UNAVAILABLE"
  | "ALREADY_DECIDED"
  | "INVALID_STATE"
  | "NOT_RETRYABLE"
  | "CONFLICT"
  | "INTERNAL";

export class AppError extends Error {
  constructor(
    public status: 401 | 403 | 404 | 409 | 422 | 500,
    public code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Express 错误中间件：统一响应 `{ error: { code, message } }` */
export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first && first.path.length > 0 ? `（${first.path.join(".")}）` : "";
    res.status(422).json({ error: { code: "VALIDATION_ERROR", message: `请求参数不合法${where}` } });
    return;
  }
  console.error("[server] 未处理的错误：", err);
  res.status(500).json({ error: { code: "INTERNAL", message: "服务器内部错误" } });
}

// Express 应用装配（SPEC §D）：cors → json(64kb) → /api 路由 → 错误中间件。
import cors from "cors";
import express, { type ErrorRequestHandler, type Express } from "express";
import type { Container } from "./container";
import { AppError, errorMiddleware } from "./errors";
import { agentRouter } from "./routes/agent";
import { authenticate, requireRole } from "./routes/auth";
import { bootstrapRouter } from "./routes/bootstrap";
import { customerRouter } from "./routes/customer";
import { reviewerRouter } from "./routes/reviewer";

/** body-parser 的解析错误（非法 JSON、体积超限）统一转为 422 */
const bodyParserErrors: ErrorRequestHandler = (err, _req, _res, next) => {
  const type = err && typeof err === "object" ? (err as { type?: unknown }).type : undefined;
  if (typeof type === "string" && type.startsWith("entity.")) {
    return next(new AppError(422, "VALIDATION_ERROR", "请求体不是合法的 JSON 或超出大小限制"));
  }
  next(err);
};

export function createApp(c: Container): Express {
  const app = express();
  // 仅允许本机开发来源（Vite 等）；其余来源不返回 CORS 头，浏览器会拒绝跨域读取
  app.use(cors({ origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/] }));
  app.use(express.json({ limit: "64kb" }));

  const api = express.Router();
  api.use("/bootstrap", bootstrapRouter(c));
  api.use("/customer", authenticate(c), requireRole("customer"), customerRouter(c));
  api.use("/agent", authenticate(c), requireRole("agent"), agentRouter(c));
  api.use("/reviewer", authenticate(c), requireRole("reviewer"), reviewerRouter(c));
  api.use((_req, _res, next) => next(new AppError(404, "NOT_FOUND", "接口不存在")));
  app.use("/api", api);

  app.use(bodyParserErrors);
  app.use(errorMiddleware);
  return app;
}

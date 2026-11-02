import path from "node:path";
import { z } from "zod";
import { PROJECT_ROOT } from "./util";

export const DEFAULT_MCP_SHARED_SECRET = "change-me-local-demo-secret";

/** 空串视为未设置（便于 .env 中留空的变量走默认值） */
const optionalString = z.preprocess((v) => (v === "" ? undefined : v), z.string().optional());

export const configSchema = z.object({
  port: z.coerce.number().int().default(3001),
  dbPath: z.string().default("data/app.db").transform((v) => path.resolve(PROJECT_ROOT, v)),
  checkpointPath: z.string().default("data/checkpoints.db").transform((v) => path.resolve(PROJECT_ROOT, v)),
  mcpSharedSecret: z.string().min(8).default(DEFAULT_MCP_SHARED_SECRET),
  modelProvider: z.enum(["mock", "anthropic", "openai"]).default("mock"),
  modelName: optionalString,
  anthropicApiKey: optionalString,
  openaiApiKey: optionalString,
  openaiBaseUrl: optionalString,
  outboxPollMs: z.coerce.number().int().min(10).default(1000),
  outboxMaxAttempts: z.coerce.number().int().min(1).default(8),
  mockDelayMs: z.coerce.number().int().min(0).default(0),
});

export type AppConfig = z.infer<typeof configSchema>;

/**
 * 从环境变量解析配置。调用方（server/index.ts、init-db.ts）需先 `import "dotenv/config"`。
 * 环境变量中的空串一律视为未设置。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const pick = (k: string): string | undefined => (env[k] === "" ? undefined : env[k]);
  return configSchema.parse({
    // 后端端口优先读 SERVER_PORT（避免与 Vite/预览工具注入的 PORT 冲突），再回退 PORT
    port: pick("SERVER_PORT") ?? pick("PORT"),
    dbPath: pick("DB_PATH"),
    checkpointPath: pick("CHECKPOINT_DB_PATH"),
    mcpSharedSecret: pick("MCP_SHARED_SECRET"),
    modelProvider: pick("MODEL_PROVIDER"),
    modelName: pick("MODEL_NAME"),
    anthropicApiKey: pick("ANTHROPIC_API_KEY"),
    openaiApiKey: pick("OPENAI_API_KEY"),
    openaiBaseUrl: pick("OPENAI_BASE_URL"),
    outboxPollMs: pick("OUTBOX_POLL_MS"),
    outboxMaxAttempts: pick("OUTBOX_MAX_ATTEMPTS"),
    mockDelayMs: pick("MOCK_DELAY_MS"),
  });
}

/** 共享密钥仍为默认值时打印告警（仅限本地演示）；返回是否触发了告警 */
export function warnIfDefaultSecret(config: Pick<AppConfig, "mcpSharedSecret">, log: (msg: string) => void = console.error): boolean {
  if (config.mcpSharedSecret !== DEFAULT_MCP_SHARED_SECRET) return false;
  log("[config] 警告：MCP_SHARED_SECRET 仍为默认值，仅限本地演示；部署前请在 .env 中设置为随机长字符串。");
  return true;
}

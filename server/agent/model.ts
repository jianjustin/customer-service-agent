// 模型工厂（SPEC §F.7）：mock 默认；anthropic/openai 缺凭据自动回落 mock 并给出原因。
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import { initChatModel } from "langchain";
import type { AppConfig } from "../config";
import { MockChatModel } from "./mock-model";
import type { ModelInfo } from "./types";

export type { ModelInfo } from "./types";

type ChatModelLike = BaseChatModel | Awaited<ReturnType<typeof initChatModel>>;

export async function createChatModel(
  config: AppConfig,
  opts: { mockDelayMs?: number; override?: BaseChatModel } = {},
): Promise<{ model: ChatModelLike; info: ModelInfo }> {
  const log = (info: ModelInfo) => console.error(`[model] ${info.label}${info.reason ? `（${info.reason}）` : ""}`);

  if (opts.override) {
    const info: ModelInfo = { mode: "mock", label: "测试脚本模型", modelName: null, reason: "测试注入的脚本模型" };
    return { model: opts.override, info };
  }

  const delayMs = opts.mockDelayMs ?? config.mockDelayMs;
  const mock = (reason: string): { model: ChatModelLike; info: ModelInfo } => {
    const info: ModelInfo = { mode: "mock", label: "Mock 模式", modelName: null, reason };
    log(info);
    return { model: new MockChatModel({ delayMs }), info };
  };

  const name = config.modelName;
  if (config.modelProvider === "anthropic") {
    const missing = [!config.anthropicApiKey && "ANTHROPIC_API_KEY", !name && "MODEL_NAME"].filter(Boolean).join("、");
    if (missing) return mock(`未配置 ${missing}，已自动使用 Mock 模式`);
    const model = await initChatModel(name!, { modelProvider: "anthropic", apiKey: config.anthropicApiKey, temperature: 0 });
    const info: ModelInfo = { mode: "anthropic", label: `Anthropic · ${name}`, modelName: name!, reason: null };
    log(info);
    return { model, info };
  }
  if (config.modelProvider === "openai") {
    const missing = [!config.openaiApiKey && "OPENAI_API_KEY", !name && "MODEL_NAME"].filter(Boolean).join("、");
    if (missing) return mock(`未配置 ${missing}，已自动使用 Mock 模式`);
    const model = new ChatOpenAI({
      model: name!,
      apiKey: config.openaiApiKey,
      temperature: 0,
      configuration: config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : undefined,
    });
    const info: ModelInfo = { mode: "openai", label: `OpenAI 兼容 · ${name}`, modelName: name!, reason: null };
    log(info);
    return { model, info };
  }
  return mock("MODEL_PROVIDER=mock");
}

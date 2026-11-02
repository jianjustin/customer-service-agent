// 渠道适配器接口（SPEC §A.5）。
import type { ChannelName } from "../domain/types";

export interface ChannelAdapter {
  readonly channel: ChannelName;
  /** 将系统通知投递到该渠道会话。必须幂等：同一 dedupeKey 只产生一条消息。 */
  deliverSystemMessage(input: {
    conversationId: string;
    text: string;
    dedupeKey: string;
  }): Promise<{ messageId: number | null; duplicate: boolean }>;
}

export class ChannelNotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelNotImplementedError";
  }
}

export interface ChannelRegistry {
  get(channel: ChannelName): ChannelAdapter;
}

export function createChannelRegistry(adapters: ChannelAdapter[]): ChannelRegistry {
  const map = new Map<ChannelName, ChannelAdapter>(adapters.map((a) => [a.channel, a]));
  return {
    get(channel) {
      const a = map.get(channel);
      if (!a) throw new ChannelNotImplementedError(`未注册的渠道：${channel}`);
      return a;
    },
  };
}

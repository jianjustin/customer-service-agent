// Web 渠道：AI/人工消息直接落 messages 表（前端轮询即为投递），只有系统通知经适配器。
import type { Db } from "../db/connection";
import { tx } from "../db/connection";
import type { Repos } from "../repos/interfaces";
import { nowIso } from "../util";
import type { ChannelAdapter } from "./types";

/** faults.failTimes > 0 时每次投递先自减并抛错（测试用故障注入，用于验证 outbox 重试） */
export function createWebChannel(repos: Repos, db: Db, faults?: { failTimes?: number }): ChannelAdapter {
  let failTimes = faults?.failTimes ?? 0;
  return {
    channel: "web",
    async deliverSystemMessage({ conversationId, text, dedupeKey }) {
      if (failTimes > 0) {
        failTimes -= 1;
        throw new Error("模拟渠道投递失败");
      }
      const { row, duplicate } = tx(db, () =>
        repos.messages.insertIgnoreByClientId({
          conversationId,
          senderType: "system",
          senderId: null,
          content: text,
          clientMessageId: "o:" + dedupeKey,
          at: nowIso(),
        }),
      );
      return { messageId: row.id, duplicate };
    },
  };
}

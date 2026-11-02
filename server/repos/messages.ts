import type { Db } from "../db/connection";
import type { MessageRow } from "../domain/types";
import type { MessageInsert, MessageRepo } from "./interfaces";

const INSERT_SQL = (verb: "INSERT" | "INSERT OR IGNORE") => `${verb} INTO messages(conversation_id, seq, sender_type, sender_id,
    content, sources_json, ai_run_id, client_message_id, created_at)
  VALUES (@conversationId,
    (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conversation_id = @conversationId),
    @senderType, @senderId, @content, @sourcesJson, @aiRunId, @clientMessageId, @at)
  RETURNING *`;

function params(m: MessageInsert) {
  return {
    conversationId: m.conversationId,
    senderType: m.senderType,
    senderId: m.senderId,
    content: m.content,
    sourcesJson: JSON.stringify(m.sources ?? []),
    aiRunId: m.aiRunId ?? null,
    clientMessageId: m.clientMessageId ?? null,
    at: m.at,
  };
}

export function createMessageRepo(db: Db): MessageRepo {
  const insertStmt = db.prepare(INSERT_SQL("INSERT"));
  const insertIgnoreStmt = db.prepare(INSERT_SQL("INSERT OR IGNORE"));
  const byConvClient = db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND client_message_id = ?");
  const byCustomerClient = db.prepare(
    "SELECT * FROM messages WHERE sender_type = 'customer' AND sender_id = ? AND client_message_id = ?",
  );

  return {
    insert: (m) => insertStmt.get(params(m)) as MessageRow,
    insertIgnoreByClientId(m) {
      const row = insertIgnoreStmt.get(params(m)) as MessageRow | undefined;
      if (row) return { row, duplicate: false };
      // OR IGNORE 吸收了唯一约束冲突：读出已存在的那条
      const existing =
        (byConvClient.get(m.conversationId, m.clientMessageId) as MessageRow | undefined) ??
        (m.senderType === "customer" && m.senderId
          ? (byCustomerClient.get(m.senderId, m.clientMessageId) as MessageRow | undefined)
          : undefined);
      if (!existing) throw new Error("insertIgnoreByClientId：插入被忽略但未找到已存在的消息");
      return { row: existing, duplicate: true };
    },
    findCustomerMessageByClientId: (customerId, clientMessageId) =>
      byCustomerClient.get(customerId, clientMessageId) as MessageRow | undefined,
    list(conversationId, afterSeq) {
      if (afterSeq !== undefined) {
        return db
          .prepare("SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq")
          .all(conversationId, afterSeq) as MessageRow[];
      }
      return db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq").all(conversationId) as MessageRow[];
    },
    get: (id) => db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined,
  };
}

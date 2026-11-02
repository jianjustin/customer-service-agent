import type { Db } from "../db/connection";
import type { OutboxRow } from "../domain/types";
import type { OutboxRepo } from "./interfaces";

export function createOutboxRepo(db: Db): OutboxRepo {
  return {
    enqueue(e) {
      const info = db
        .prepare(
          `INSERT OR IGNORE INTO outbox(kind, dedupe_key, conversation_id, payload_json, status, attempts, next_attempt_at, created_at)
           VALUES ('customer_notification', ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .run(e.dedupeKey, e.conversationId, JSON.stringify(e.payload), e.at, e.at);
      return { inserted: info.changes === 1 };
    },
    due: (now, limit) =>
      db
        .prepare("SELECT * FROM outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?")
        .all(now, limit) as OutboxRow[],
    markSent: (id, at) =>
      db
        .prepare("UPDATE outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ? AND status = 'pending'")
        .run(at, id).changes,
    markRetry: (id, attempts, nextAt, error) =>
      db
        .prepare("UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ? AND status = 'pending'")
        .run(attempts, nextAt, error, id).changes,
    markFailed: (id, attempts, error) =>
      db
        .prepare("UPDATE outbox SET status = 'failed', attempts = ?, last_error = ? WHERE id = ? AND status = 'pending'")
        .run(attempts, error, id).changes,
    listByConversation: (conversationId) =>
      db.prepare("SELECT * FROM outbox WHERE conversation_id = ? ORDER BY id").all(conversationId) as OutboxRow[],
    listByDedupePrefix: (prefix) => {
      // 用 substr 比较做前缀匹配，避免 LIKE 对 % _ 的转义问题
      return db
        .prepare("SELECT * FROM outbox WHERE substr(dedupe_key, 1, ?) = ? ORDER BY id")
        .all(prefix.length, prefix) as OutboxRow[];
    },
  };
}

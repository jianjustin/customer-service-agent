import type { Db } from "../db/connection";
import type { AiRunRow } from "../domain/types";
import type { AiRunRepo } from "./interfaces";

export function createAiRunRepo(db: Db): AiRunRepo {
  return {
    insert: (conversationId, triggerMessageId, generation, at) =>
      db
        .prepare(
          `INSERT INTO ai_runs(conversation_id, trigger_message_id, generation, status, created_at)
           VALUES (?, ?, ?, 'queued', ?) RETURNING *`,
        )
        .get(conversationId, triggerMessageId, generation, at) as AiRunRow,
    get: (id) => db.prepare("SELECT * FROM ai_runs WHERE id = ?").get(id) as AiRunRow | undefined,
    markRunning: (id, at) =>
      db.prepare("UPDATE ai_runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'").run(at, id).changes,
    complete: (id, replyMessageId, at) =>
      db
        .prepare("UPDATE ai_runs SET status = 'completed', reply_message_id = ?, finished_at = ? WHERE id = ? AND status = 'running'")
        .run(replyMessageId, at, id).changes,
    suppress: (id, at) =>
      db
        .prepare("UPDATE ai_runs SET status = 'suppressed', finished_at = ? WHERE id = ? AND status IN ('running','cancelled')")
        .run(at, id).changes,
    fail: (id, error, at) =>
      db
        .prepare("UPDATE ai_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status IN ('queued','running')")
        .run(error, at, id).changes,
    cancelActive: (conversationId, at) =>
      db
        .prepare("UPDATE ai_runs SET status = 'cancelled', finished_at = ? WHERE conversation_id = ? AND status IN ('queued','running')")
        .run(at, conversationId).changes,
    markHandoverRequested: (id) =>
      db.prepare("UPDATE ai_runs SET handover_requested = 1 WHERE id = ? AND status = 'running'").run(id).changes,
    listActive: () => db.prepare("SELECT * FROM ai_runs WHERE status IN ('queued','running') ORDER BY id").all() as AiRunRow[],
    hasPending: (conversationId) =>
      db.prepare("SELECT 1 FROM ai_runs WHERE conversation_id = ? AND status IN ('queued','running') LIMIT 1").get(conversationId) !==
      undefined,
    listByConversation: (conversationId, limit) =>
      db.prepare("SELECT * FROM ai_runs WHERE conversation_id = ? ORDER BY id DESC LIMIT ?").all(conversationId, limit) as AiRunRow[],
  };
}

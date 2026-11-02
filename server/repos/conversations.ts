import type { Db } from "../db/connection";
import type { ConversationRow } from "../domain/types";
import type { ConversationRepo } from "./interfaces";

export function createConversationRepo(db: Db): ConversationRepo {
  return {
    get: (id) => db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationRow | undefined,
    getByTicket: (ticketId) =>
      db.prepare("SELECT * FROM conversations WHERE ticket_id = ?").get(ticketId) as ConversationRow | undefined,
    insert(row) {
      db.prepare(
        `INSERT INTO conversations(id, ticket_id, customer_id, channel, channel_session_id, thread_id, handling_mode,
           ai_generation, created_at, updated_at)
         VALUES (@id, @ticket_id, @customer_id, @channel, @channel_session_id, @thread_id, @handling_mode,
           @ai_generation, @created_at, @updated_at)`,
      ).run(row);
    },
    takeover: (id, at) =>
      db
        .prepare(
          "UPDATE conversations SET handling_mode = 'human', ai_generation = ai_generation + 1, updated_at = ? WHERE id = ? AND handling_mode = 'ai'",
        )
        .run(at, id).changes,
    resumeAi: (id, at) =>
      db
        .prepare("UPDATE conversations SET handling_mode = 'ai', updated_at = ? WHERE id = ? AND handling_mode = 'human'")
        .run(at, id).changes,
    bumpGeneration: (id, at) =>
      db.prepare("UPDATE conversations SET ai_generation = ai_generation + 1, updated_at = ? WHERE id = ?").run(at, id).changes,
  };
}

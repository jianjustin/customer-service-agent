import type { Db } from "../db/connection";
import type { AssignmentStateRepo } from "./interfaces";

export function createAssignmentStateRepo(db: Db): AssignmentStateRepo {
  return {
    get: (key) => (db.prepare("SELECT value FROM assignment_state WHERE key = ?").get(key) as { value: string } | undefined)?.value,
    set(key, value) {
      db.prepare("INSERT INTO assignment_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
    },
  };
}

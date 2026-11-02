import type { Db } from "../db/connection";
import type { ExecutionLogRow } from "../domain/types";
import { nowIso } from "../util";
import type { LogRepo } from "./interfaces";

export function createLogRepo(db: Db): LogRepo {
  return {
    write(e) {
      const verb = e.dedupeKey ? "INSERT OR IGNORE" : "INSERT";
      db.prepare(
        `${verb} INTO execution_logs(scope, ref_id, node, event, detail_json, dedupe_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(e.scope, e.refId, e.node, e.event, JSON.stringify(e.detail ?? {}), e.dedupeKey ?? null, e.at ?? nowIso());
    },
    list: (scope, refId) =>
      db.prepare("SELECT * FROM execution_logs WHERE scope = ? AND ref_id = ? ORDER BY id").all(scope, refId) as ExecutionLogRow[],
    count(scope, filter) {
      const conds = ["scope = ?"];
      const args: unknown[] = [scope];
      if (filter?.event !== undefined) {
        conds.push("event = ?");
        args.push(filter.event);
      }
      if (filter?.node !== undefined) {
        conds.push("node = ?");
        args.push(filter.node);
      }
      return (db.prepare(`SELECT COUNT(*) AS n FROM execution_logs WHERE ${conds.join(" AND ")}`).get(...args) as { n: number }).n;
    },
  };
}

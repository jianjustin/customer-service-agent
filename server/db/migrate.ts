import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nowIso } from "../util";
import { tx, type Db } from "./connection";

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

/** 应用尚未执行的迁移，返回本次新应用的版本列表（文件名去掉 .sql）。 */
export function migrate(db: Db, dir: string = DEFAULT_MIGRATIONS_DIR): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: string }>).map((r) => r.version),
  );
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const done: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    tx(db, () => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(version, nowIso());
    });
    done.push(version);
  }
  return done;
}

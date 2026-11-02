import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type Db = import("better-sqlite3").Database;

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  return db;
}

/**
 * 在 BEGIN IMMEDIATE 事务内执行 fn；抛错则回滚。
 * 注意：fn 必须是同步函数，事务内禁止 await。
 */
export function tx<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate();
}

import "dotenv/config";
import { loadConfig } from "../config";
import { openDb } from "../db/connection";
import { migrate } from "../db/migrate";
import { seed } from "../db/seed";

const config = loadConfig();
const db = openDb(config.dbPath);
try {
  const applied = migrate(db);
  seed(db);
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  console.log(`数据库：${config.dbPath}`);
  console.log(`本次应用迁移：${applied.length > 0 ? applied.join(", ") : "（无，已是最新）"}`);
  console.log(
    [
      `客户 ${count("customers")}`,
      `席位 ${count("seats")}`,
      `审核员 ${count("reviewers")}`,
      `订单 ${count("orders")}`,
      `支付 ${count("payments")}`,
      `知识 ${count("knowledge_entries")}`,
    ].join(" / "),
  );
} finally {
  db.close();
}

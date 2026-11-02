import type { Db } from "../db/connection";
import type { KnowledgeEntry } from "../domain/types";
import type { KnowledgeRepo } from "./interfaces";

interface KnowledgeDbRow {
  id: string;
  title: string;
  version: number;
  category: string;
  content: string;
  keywords_json: string;
}

export function createKnowledgeRepo(db: Db): KnowledgeRepo {
  return {
    upsertAll(entries, at) {
      const stmt = db.prepare(
        `INSERT INTO knowledge_entries(id, title, version, category, content, keywords_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, version=excluded.version, category=excluded.category,
           content=excluded.content, keywords_json=excluded.keywords_json, updated_at=excluded.updated_at`,
      );
      const run = db.transaction((list: KnowledgeEntry[]) => {
        for (const e of list) stmt.run(e.id, e.title, e.version, e.category, e.content, JSON.stringify(e.keywords), at);
      });
      run(entries);
    },
    listAll() {
      const rows = db
        .prepare("SELECT id, title, version, category, content, keywords_json FROM knowledge_entries ORDER BY id")
        .all() as KnowledgeDbRow[];
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        version: r.version,
        category: r.category,
        content: r.content,
        keywords: JSON.parse(r.keywords_json) as string[],
      }));
    },
  };
}

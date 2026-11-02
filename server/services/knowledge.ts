// 知识检索：纯本地、确定性（算法见 docs/SPEC.md §C.2）。
import type { KnowledgeEntry } from "../domain/types";

export interface KnowledgeHit {
  id: string;
  title: string;
  version: number;
  category: string;
  snippet: string;
  score: number;
}
export interface KnowledgeService {
  search(query: string, topK?: number): KnowledgeHit[];
  all(): KnowledgeEntry[];
}

export const KNOWLEDGE_THRESHOLD = 0.45;
export const KNOWLEDGE_TOP_K = 3;

const STOP_WORDS = [
  "请问", "你们", "我们", "我的", "什么", "怎么办", "怎么", "如何", "可以", "是否", "一下", "为什么",
  "吗", "呢", "吧", "啊", "的", "了", "是", "有", "么", "我", "要", "想",
].sort((a, b) => b.length - a.length); // 按长度降序（稳定排序）依次删除

/** 小写后删除所有不属于 [一-龥a-z0-9] 的字符 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^一-龥a-z0-9]/g, "");
}

function stripStop(s: string): string {
  let r = normalize(s);
  for (const w of STOP_WORDS) r = r.split(w).join("");
  return r;
}

function bigrams(s: string): Set<string> {
  const set = new Set<string>();
  if (s.length === 0) return set;
  if (s.length === 1) {
    set.add(s);
    return set;
  }
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/** 文本规范化后的相邻 2 字符集合（单字符文本返回该字符；空返回空集） */
export function tokenizeBigrams(text: string): Set<string> {
  return bigrams(normalize(text));
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

export function createKnowledgeService(entries: KnowledgeEntry[]): KnowledgeService {
  const indexed = entries.map((entry) => ({
    entry,
    full: bigrams(normalize(entry.title + entry.content)),
    title: bigrams(normalize(entry.title)),
    keywords: entry.keywords.map(normalize).filter((k) => k.length > 0),
  }));

  return {
    search(query: string, topK: number = KNOWLEDGE_TOP_K): KnowledgeHit[] {
      const nq = normalize(query);
      const q = bigrams(stripStop(query));
      if (q.size === 0) return [];
      const hits: KnowledgeHit[] = [];
      for (const { entry, full, title, keywords } of indexed) {
        const bigramScore = intersectionSize(q, full) / q.size;
        const titleScore = intersectionSize(q, title) / q.size;
        const kwHits = keywords.filter((k) => nq.includes(k)).length;
        const score = round4(bigramScore + 0.2 * titleScore + 0.25 * Math.min(kwHits, 4));
        if (score >= KNOWLEDGE_THRESHOLD && (kwHits >= 1 || bigramScore >= 0.6)) {
          const snippet = entry.content.length > 80 ? entry.content.slice(0, 80) + "…" : entry.content;
          hits.push({
            id: entry.id,
            title: entry.title,
            version: entry.version,
            category: entry.category,
            snippet,
            score,
          });
        }
      }
      hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return hits.slice(0, topK);
    },
    all(): KnowledgeEntry[] {
      return entries;
    },
  };
}

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { knowledgeEntriesSchema } from "../server/db/seed";
import { createKnowledgeService, KNOWLEDGE_THRESHOLD, tokenizeBigrams } from "../server/services/knowledge";
import { PROJECT_ROOT } from "../server/util";

const entries = knowledgeEntriesSchema.parse(
  JSON.parse(readFileSync(path.join(PROJECT_ROOT, "knowledge/entries.json"), "utf8")),
);
const svc = createKnowledgeService(entries);

describe("知识库数据", () => {
  it("14 条，id 唯一", () => {
    expect(entries).toHaveLength(14);
    expect(new Set(entries.map((e) => e.id)).size).toBe(14);
  });
});

describe("知识检索 — 命中样例（SPEC §C.2 样例表）", () => {
  const hitCases: Array<[query: string, id: string, version?: number, score?: number]> = [
    ["怎么修改收货地址？", "kb-001", 2, 1.45],
    ["支付成功但订单显示未支付怎么办？", "kb-003", undefined, 1.7],
    ["退款多久到账", "kb-007", undefined, 0.98],
    ["退款政策是什么", "kb-006"],
    ["手表怎么配对", "kb-011"],
    ["我想换绑手机号", "kb-010"],
    ["人工客服几点上班", "kb-014"],
  ];
  for (const [query, id, version, score] of hitCases) {
    it(`命中：${query} → ${id}`, () => {
      const hits = svc.search(query);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].id).toBe(id);
      if (version !== undefined) expect(hits[0].version).toBe(version);
      if (score !== undefined) expect(hits[0].score).toBeCloseTo(score, 4);
      expect(hits[0].score).toBeGreaterThanOrEqual(KNOWLEDGE_THRESHOLD);
    });
  }
});

describe("知识检索 — 不命中样例", () => {
  const missCases = [
    "你们对宠物保险的理赔政策是什么？",
    "员工内部折扣政策有哪些",
    "海外直邮关税谁承担",
    "会员积分怎么兑换",
    "你好",
  ];
  for (const query of missCases) {
    it(`不命中：${query}`, () => {
      expect(svc.search(query)).toEqual([]);
    });
  }
});

describe("知识检索 — 其它性质", () => {
  it("空串/纯停用词/纯标点返回空", () => {
    expect(svc.search("")).toEqual([]);
    expect(svc.search("请问")).toEqual([]);
    expect(svc.search("？？！！")).toEqual([]);
  });
  it("topK 生效，排序为 score 降序、id 升序，且是确定性的", () => {
    const a = svc.search("退款", 2);
    expect(a.length).toBeLessThanOrEqual(2);
    for (let i = 1; i < a.length; i++) {
      const prev = a[i - 1];
      const cur = a[i];
      expect(prev.score > cur.score || (prev.score === cur.score && prev.id < cur.id)).toBe(true);
    }
    expect(svc.search("退款", 2)).toEqual(a);
  });
  it("snippet 超过 80 字符时截断并加省略号", () => {
    const hit = svc.search("支付成功但订单显示未支付怎么办？")[0];
    expect(hit.snippet.endsWith("…")).toBe(true);
    expect(hit.snippet.length).toBe(81);
  });
  it("tokenizeBigrams：规范化后取相邻 2 字符；单字符返回自身；空返回空集", () => {
    expect([...tokenizeBigrams("退款 A1!")]).toEqual(["退款", "款a", "a1"]);
    expect([...tokenizeBigrams("退")]).toEqual(["退"]);
    expect(tokenizeBigrams("？？").size).toBe(0);
  });
  it("all() 返回全部条目", () => {
    expect(svc.all()).toHaveLength(14);
  });
});

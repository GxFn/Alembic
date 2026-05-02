/**
 * BootstrapDedup — 冷启动期间的会话级去重缓存
 *
 * 生命周期: 随 bootstrap session 创建/销毁
 * 作用:
 *   1. 缓存当前 session 已提交的候选摘要（解决 DB 写入延迟导致的盲区）
 *   2. 提供快速结构相似度比较（纯内存，不查 DB）
 *   3. 同步写入，避免并行维度竞态
 *
 * 相似度算法: 复用 ConsolidationAdvisor 的 4 维权重
 *   title 0.2 + clause 0.3 + code 0.3 + guard 0.2
 */

/* ────────────────────── Types ────────────────────── */

export interface CandidateSummary {
  id: string;
  title: string;
  category: string;
  coreCode: string;
  doClause: string;
  dontClause: string;
  guardPattern?: string;
}

export interface DedupMatch {
  existingId: string;
  existingTitle: string;
  similarity: number;
}

/* ────────────────────── Constants ────────────────────── */

/** 默认去重阈值 — 低于 Gateway SimilarityCheck(0.7)，提前拦截明显重复 */
const DEFAULT_THRESHOLD = 0.65;

const WEIGHTS = { title: 0.2, clause: 0.3, code: 0.3, guard: 0.2 };

/* ────────────────────── Class ────────────────────── */

export class BootstrapDedup {
  readonly #candidates: CandidateSummary[] = [];

  /** 注册已提交的候选（knowledge 提交成功后调用） */
  register(summary: CandidateSummary): void {
    this.#candidates.push(summary);
  }

  /** 检查新候选是否与已注册候选重复 */
  findDuplicate(candidate: CandidateSummary, threshold = DEFAULT_THRESHOLD): DedupMatch | null {
    let best: DedupMatch | null = null;
    for (const existing of this.#candidates) {
      const sim = computeSimilarity(candidate, existing);
      if (sim >= threshold && (best === null || sim > best.similarity)) {
        best = {
          existingId: existing.id,
          existingTitle: existing.title,
          similarity: Math.round(sim * 100) / 100,
        };
      }
    }
    return best;
  }

  /** 批量检查（返回所有匹配到重复的条目） */
  findDuplicates(candidates: CandidateSummary[], threshold = DEFAULT_THRESHOLD): DedupMatch[] {
    return candidates
      .map((c) => this.findDuplicate(c, threshold))
      .filter((m): m is DedupMatch => m !== null);
  }

  /** 清空（session 结束时调用） */
  clear(): void {
    this.#candidates.length = 0;
  }

  get count(): number {
    return this.#candidates.length;
  }
}

/* ────────────────────── Similarity ────────────────────── */

function computeSimilarity(a: CandidateSummary, b: CandidateSummary): number {
  const d1 = titleJaccard(a.title, b.title);
  const d2 = clauseJaccard([a.doClause, a.dontClause], [b.doClause, b.dontClause]);
  const d3 = codeSimilarity(a.coreCode, b.coreCode);
  const d4 = a.guardPattern && b.guardPattern && a.guardPattern === b.guardPattern ? 1.0 : 0;

  return WEIGHTS.title * d1 + WEIGHTS.clause * d2 + WEIGHTS.code * d3 + WEIGHTS.guard * d4;
}

/* ── Title Jaccard ── */

function extractWords(text: string): Set<string> {
  const words = new Set<string>();
  // 拆分 CamelCase、snake_case、kebab-case、中文、英文
  const tokens = text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-/\\.:@]+/g, ' ')
    .toLowerCase()
    .split(/\s+/);
  for (const t of tokens) {
    if (t.length >= 2) {
      words.add(t);
    }
  }
  // 中文分词 — 按 2-gram
  const cjk = text.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) {
    words.add(cjk.slice(i, i + 2));
  }
  return words;
}

function titleJaccard(a: string, b: string): number {
  const wa = extractWords(a);
  const wb = extractWords(b);
  if (wa.size === 0 && wb.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const w of wa) {
    if (wb.has(w)) {
      intersection++;
    }
  }
  const union = wa.size + wb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/* ── Clause Jaccard ── */

function clauseJaccard(clausesA: string[], clausesB: string[]): number {
  const textA = clausesA.filter(Boolean).join(' ');
  const textB = clausesB.filter(Boolean).join(' ');
  if (!textA || !textB) {
    return 0;
  }
  const wa = extractWords(textA);
  const wb = extractWords(textB);
  if (wa.size === 0 && wb.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const w of wa) {
    if (wb.has(w)) {
      intersection++;
    }
  }
  const union = wa.size + wb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/* ── Code Similarity (n-gram Jaccard, n=3) ── */

function codeSimilarity(codeA: string, codeB: string): number {
  if (!codeA || !codeB) {
    return 0;
  }
  const a = codeA.replace(/\s+/g, '');
  const b = codeB.replace(/\s+/g, '');
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  return ngramJaccard(a, b, 3);
}

function ngramJaccard(a: string, b: string, n: number): number {
  const gramsA = new Set<string>();
  const gramsB = new Set<string>();
  for (let i = 0; i <= a.length - n; i++) {
    gramsA.add(a.slice(i, i + n));
  }
  for (let i = 0; i <= b.length - n; i++) {
    gramsB.add(b.slice(i, i + n));
  }
  if (gramsA.size === 0 && gramsB.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const g of gramsA) {
    if (gramsB.has(g)) {
      intersection++;
    }
  }
  const union = gramsA.size + gramsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

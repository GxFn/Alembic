/**
 * RecipeSimilarity — 统一 5 维相似度算法
 *
 * 从 ConsolidationAdvisor 与 RedundancyAnalyzer 中提取共享的相似度计算，
 * 消除两套独立实现的偏差（文档 §7.3.1）。
 *
 * 5 个维度及权重:
 *   title   (0.15) — 标题关键词 Jaccard
 *   clause  (0.25) — doClause + dontClause 关键词 Jaccard
 *   code    (0.15) — coreCode 去空白后 3-gram Jaccard（结构相似度）
 *   content (0.30) — 全字段代码标识符 token Jaccard（语义相似度）
 *   guard   (0.15) — guardPattern 精确匹配 (0 | 1)
 *
 * content 维度复用 shared/recipe-tokens 的 extractRecipeTokens()，
 * 从 coreCode + content.markdown 代码块 + content.pattern + content.steps
 * 提取 API 标识符，做 Jaccard 集合比对。
 *
 * 额外提供 Layer 1.5 字段级分析（文档 §7.4.3）：
 *   triggerConflict  — trigger 是否语义冲突
 *   doClauseSubset   — 候选 doClause 是否为已有 Recipe 的子集
 *   coreCodeOverlap  — 共享代码模式比率 (0-1)
 *   categoryMatch    — 同 category
 *
 * @module domain/evolution/RecipeSimilarity
 */

import { extractRecipeTokens } from '../../shared/recipe-tokens.js';

/* ────────────────────── Stop Words ────────────────────── */

const STOP_WORDS = new Set([
  '我们',
  '使用',
  '项目',
  '需要',
  '可以',
  '应该',
  '建议',
  '目前',
  '已经',
  '这个',
  '那个',
  '一个',
  '进行',
  '通过',
  '对于',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'can',
  'this',
  'that',
  'these',
  'those',
  'for',
  'and',
  'but',
  'with',
  'not',
  'from',
  'use',
  'all',
  'any',
]);

/* ────────────────────── Types ────────────────────── */

/** 参与相似度计算的最小字段集 */
export interface RecipeLike {
  title: string;
  doClause?: string | null;
  dontClause?: string | null;
  coreCode?: string | null;
  category?: string | null;
  trigger?: string | null;
  guardPattern?: string | null;
  content?: {
    markdown?: string | null;
    pattern?: string | null;
    steps?: Array<{ code?: string }>;
  } | null;
}

/** 5 维分解得分 */
export interface SimilarityDimensions {
  title: number;
  clause: number;
  code: number;
  content: number;
  guard: number;
}

/** Layer 1.5 字段级分析结果（文档 §7.4.3） */
export interface FieldAnalysis {
  triggerConflict: boolean;
  doClauseSubset: boolean;
  coreCodeOverlap: number;
  categoryMatch: boolean;
}

/* ────────────────────── Constants ────────────────────── */

export const WEIGHTS = {
  title: 0.15,
  clause: 0.25,
  code: 0.15,
  content: 0.3,
  guard: 0.15,
} as const;

/* ────────────────────── Class ────────────────────── */

export class RecipeSimilarity {
  /**
   * 计算两条 Recipe（或候选）之间的 5 维加权相似度 (0-1)
   */
  static compute(a: RecipeLike, b: RecipeLike): number {
    const dims = RecipeSimilarity.computeDimensions(a, b);
    return (
      WEIGHTS.title * dims.title +
      WEIGHTS.clause * dims.clause +
      WEIGHTS.code * dims.code +
      WEIGHTS.content * dims.content +
      WEIGHTS.guard * dims.guard
    );
  }

  /**
   * 计算各维度分解得分（不加权），供 RedundancyResult 等展示用
   */
  static computeDimensions(a: RecipeLike, b: RecipeLike): SimilarityDimensions {
    return {
      title: RecipeSimilarity.titleJaccard(a.title, b.title),
      clause: RecipeSimilarity.clauseJaccard(
        [a.doClause, a.dontClause],
        [b.doClause, b.dontClause]
      ),
      code: RecipeSimilarity.codeSimilarity(a.coreCode ?? null, b.coreCode ?? null),
      content: RecipeSimilarity.contentTokenSimilarity(a, b),
      guard: RecipeSimilarity.guardMatch(a.guardPattern ?? null, b.guardPattern ?? null),
    };
  }

  /**
   * Layer 1.5 字段级语义分析（文档 §7.4.3）
   *
   * 用于 ConsolidationAdvisor 在 0.4-0.65 模糊区间做更精确判断：
   *   - triggerConflict: 同命名空间下 trigger 冲突
   *   - doClauseSubset: 候选 doClause 是否为已有 Recipe 的子集
   *   - coreCodeOverlap: coreCode 共享模式比率
   *   - categoryMatch: 同 category
   */
  static analyzeFields(candidate: RecipeLike, existing: RecipeLike): FieldAnalysis {
    return {
      triggerConflict: RecipeSimilarity.#isTriggerConflict(
        candidate.trigger ?? null,
        existing.trigger ?? null
      ),
      doClauseSubset: RecipeSimilarity.#isDoClauseSubset(
        candidate.doClause ?? null,
        existing.doClause ?? null
      ),
      coreCodeOverlap: RecipeSimilarity.codeSimilarity(
        candidate.coreCode ?? null,
        existing.coreCode ?? null
      ),
      categoryMatch: !!(
        candidate.category &&
        existing.category &&
        candidate.category === existing.category
      ),
    };
  }

  /* ════════════════════ 维度计算（公开静态，供外部直接调用） ════════════════════ */

  /** 提取主题词（过滤停用词和短词） */
  static extractTopicWords(text: string): Set<string> {
    if (!text) {
      return new Set();
    }

    const tokens = text
      .toLowerCase()
      .split(/[\s,;:!?。，；：！？\-_/\\|()[\]{}'"<>·、]+/)
      .filter((t) => t.length >= 2);

    return new Set(tokens.filter((t) => !STOP_WORDS.has(t)));
  }

  /** 维度 1: 标题关键词 Jaccard */
  static titleJaccard(titleA: string, titleB: string): number {
    const wordsA = RecipeSimilarity.extractTopicWords(titleA);
    const wordsB = RecipeSimilarity.extractTopicWords(titleB);
    return RecipeSimilarity.#jaccard(wordsA, wordsB);
  }

  /** 维度 2: doClause + dontClause 关键词 Jaccard */
  static clauseJaccard(
    clausesA: (string | null | undefined)[],
    clausesB: (string | null | undefined)[]
  ): number {
    const textA = clausesA.filter(Boolean).join(' ');
    const textB = clausesB.filter(Boolean).join(' ');
    if (!textA || !textB) {
      return 0;
    }
    const wordsA = RecipeSimilarity.extractTopicWords(textA);
    const wordsB = RecipeSimilarity.extractTopicWords(textB);
    return RecipeSimilarity.#jaccard(wordsA, wordsB);
  }

  /** 维度 3: coreCode 去空白后 3-gram Jaccard */
  static codeSimilarity(codeA: string | null, codeB: string | null): number {
    if (!codeA || !codeB) {
      return 0;
    }
    const a = codeA.replace(/\s+/g, '');
    const b = codeB.replace(/\s+/g, '');
    if (a.length === 0 || b.length === 0) {
      return 0;
    }
    return RecipeSimilarity.#ngramJaccard(a, b, 3);
  }

  /** 维度 4: guardPattern 精确匹配 */
  static guardMatch(patternA: string | null, patternB: string | null): number {
    if (!patternA || !patternB) {
      return 0;
    }
    return patternA === patternB ? 1.0 : 0;
  }

  /**
   * 维度 5: 全字段代码标识符 token Jaccard（语义相似度）
   *
   * 使用 shared/recipe-tokens.extractRecipeTokens() 从两条 Recipe 的
   * coreCode + content.markdown 代码块 + content.pattern + content.steps
   * 提取 API 标识符集合，计算 Jaccard 相似度。
   *
   * 与 codeSimilarity（3-gram 结构比对）互补：
   *   - codeSimilarity 捕获字符级排列顺序
   *   - contentTokenSimilarity 捕获语义级 API 标识符重叠
   */
  static contentTokenSimilarity(a: RecipeLike, b: RecipeLike): number {
    const tokensA = extractRecipeTokens({
      coreCode: a.coreCode ?? undefined,
      content: a.content
        ? {
            markdown: a.content.markdown ?? undefined,
            pattern: a.content.pattern ?? undefined,
            steps: a.content.steps,
          }
        : undefined,
    });
    const tokensB = extractRecipeTokens({
      coreCode: b.coreCode ?? undefined,
      content: b.content
        ? {
            markdown: b.content.markdown ?? undefined,
            pattern: b.content.pattern ?? undefined,
            steps: b.content.steps,
          }
        : undefined,
    });
    return RecipeSimilarity.#jaccard(tokensA.tokens, tokensB.tokens);
  }

  /* ════════════════════ 内部工具 ════════════════════ */

  static #jaccard(setA: Set<string>, setB: Set<string>): number {
    if (setA.size === 0 && setB.size === 0) {
      return 0;
    }
    let intersection = 0;
    for (const w of setA) {
      if (setB.has(w)) {
        intersection++;
      }
    }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  static #ngramJaccard(a: string, b: string, n: number): number {
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

  /**
   * trigger 语义冲突检测：同一 @前缀命名空间下的不同 trigger
   * 例如 @lazy-category-loading vs @lazy-tab-loading 都在 @lazy- 空间
   */
  static #isTriggerConflict(triggerA: string | null, triggerB: string | null): boolean {
    if (!triggerA || !triggerB) {
      return false;
    }
    if (triggerA === triggerB) {
      return true; // 完全相同 = 冲突
    }
    // 提取 @前缀（到第二个 - 为止）
    const prefixA = RecipeSimilarity.#triggerPrefix(triggerA);
    const prefixB = RecipeSimilarity.#triggerPrefix(triggerB);
    // 共享前缀且前缀有意义（长度 > 3）
    return prefixA.length > 3 && prefixA === prefixB;
  }

  static #triggerPrefix(trigger: string): string {
    if (!trigger.startsWith('@')) {
      return '';
    }
    // @xxx-yyy-zzz → @xxx-yyy（取到第二个 - 之前的部分）
    const parts = trigger.split('-');
    if (parts.length >= 2) {
      return `${parts[0]}-${parts[1]}`;
    }
    return trigger;
  }

  /**
   * doClause 子集检测：候选的关键词是否全被已有 Recipe 覆盖
   */
  static #isDoClauseSubset(candidateDo: string | null, existingDo: string | null): boolean {
    if (!candidateDo || !existingDo) {
      return false;
    }
    const candidateWords = RecipeSimilarity.extractTopicWords(candidateDo);
    const existingWords = RecipeSimilarity.extractTopicWords(existingDo);
    if (candidateWords.size === 0) {
      return false;
    }
    let covered = 0;
    for (const w of candidateWords) {
      if (existingWords.has(w)) {
        covered++;
      }
    }
    // 80% 以上的候选关键词被已有覆盖 → 子集
    return covered / candidateWords.size >= 0.8;
  }
}

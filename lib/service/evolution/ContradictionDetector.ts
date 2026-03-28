/**
 * ContradictionDetector — Recipe 级矛盾检测
 *
 * 从 MemoryConsolidator 提升：Memory 层只做 session 内去重，
 * Recipe 层做跨 lifecycle 的持久化矛盾检测。
 *
 * 检测维度：
 *   1. 否定模式检测（中/英双语 negation patterns）
 *   2. 主题词重叠 ≥ 30% Jaccard
 *   3. doClause vs dontClause 交叉引用
 *   4. guard regex 互斥检测
 *
 * 结果：硬矛盾 (confidence ≥ 0.8) / 软矛盾 (0.4-0.8)
 */

import Logger from '../../infrastructure/logging/Logger.js';

import type { SignalBus } from '../../infrastructure/signal/SignalBus.js';

/* ────────────────────── Types ────────────────────── */

interface DatabaseLike {
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
  };
}

export interface ContradictionResult {
  recipeA: string;
  recipeB: string;
  confidence: number;
  type: 'hard' | 'soft';
  evidence: string[];
}

interface RecipeEntry {
  id: string;
  title: string;
  lifecycle: string;
  doClause: string | null;
  dontClause: string | null;
  guardPattern: string | null;
  description: string | null;
  content_markdown: string | null;
}

/* ────────────────────── Constants ────────────────────── */

const NEGATION_PATTERNS_ZH = /不(再)?使用|禁止|废弃|移除|取消|停止|不要|不采用|弃用|淘汰/;
const NEGATION_PATTERNS_EN =
  /\b(don'?t|do\s+not|never|no\s+longer|removed?|deprecated?|stop|avoid|disable|abandon|drop)\b/i;

const MIN_TOPIC_OVERLAP_WORDS = 2;
const MIN_TOPIC_OVERLAP_RATIO = 0.3;

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

/* ────────────────────── Class ────────────────────── */

export class ContradictionDetector {
  #db: DatabaseLike;
  #signalBus: SignalBus | null;
  #logger = Logger.getInstance();

  constructor(db: DatabaseLike, options: { signalBus?: SignalBus } = {}) {
    this.#db = db;
    this.#signalBus = options.signalBus ?? null;
  }

  /**
   * 检测所有 active/staging/evolving Recipe 之间的矛盾
   */
  detectAll(): ContradictionResult[] {
    const recipes = this.#loadRecipes();
    const results: ContradictionResult[] = [];

    for (let i = 0; i < recipes.length; i++) {
      for (let j = i + 1; j < recipes.length; j++) {
        const result = this.detectPair(recipes[i], recipes[j]);
        if (result) {
          results.push(result);
        }
      }
    }

    // 发射矛盾信号
    if (this.#signalBus && results.length > 0) {
      for (const r of results) {
        this.#signalBus.send('lifecycle', 'ContradictionDetector', r.confidence, {
          target: r.recipeA,
          metadata: {
            contradictsWith: r.recipeB,
            type: r.type,
            evidence: r.evidence,
          },
        });
      }
    }

    this.#logger.debug(`ContradictionDetector: found ${results.length} contradictions`);
    return results;
  }

  /**
   * 检测两条 Recipe 是否矛盾
   */
  detectPair(a: RecipeEntry, b: RecipeEntry): ContradictionResult | null {
    const evidence: string[] = [];
    let score = 0;

    // 维度 1: 否定模式 + 主题重叠
    const textA = [a.title, a.description, a.doClause, a.dontClause, a.content_markdown]
      .filter(Boolean)
      .join(' ');
    const textB = [b.title, b.description, b.doClause, b.dontClause, b.content_markdown]
      .filter(Boolean)
      .join(' ');

    if (this.#hasNegationConflict(textA, textB)) {
      evidence.push('negation_pattern_conflict');
      score += 0.4;
    }

    // 维度 2: doClause vs dontClause 交叉引用
    if (a.doClause && b.dontClause && this.#hasTopicOverlap(a.doClause, b.dontClause)) {
      evidence.push('doClause_vs_dontClause_cross');
      score += 0.3;
    }
    if (b.doClause && a.dontClause && this.#hasTopicOverlap(b.doClause, a.dontClause)) {
      evidence.push('dontClause_vs_doClause_cross');
      score += 0.3;
    }

    // 维度 3: guard regex 互斥检测
    if (a.guardPattern && b.guardPattern) {
      if (this.#areRegexMutuallyExclusive(a.guardPattern, b.guardPattern)) {
        evidence.push('guard_regex_mutual_exclusive');
        score += 0.2;
      }
    }

    if (evidence.length === 0) {
      return null;
    }

    const confidence = Math.min(1, score);
    const type = confidence >= 0.8 ? 'hard' : 'soft';

    return {
      recipeA: a.id,
      recipeB: b.id,
      confidence,
      type,
      evidence,
    };
  }

  /* ── Internal ── */

  #loadRecipes(): RecipeEntry[] {
    try {
      const rows = this.#db
        .prepare(
          `SELECT id, title, lifecycle, description,
                json_extract(content, '$.markdown') AS content_markdown,
                do_clause AS doClause,
                dont_clause AS dontClause,
                json_extract(content, '$.pattern') AS guardPattern
         FROM knowledge_entries
         WHERE lifecycle IN ('active', 'staging', 'evolving')`
        )
        .all();
      return rows.map((r) => ({
        id: r.id as string,
        title: r.title as string,
        lifecycle: r.lifecycle as string,
        doClause: (r.doClause as string) ?? null,
        dontClause: (r.dontClause as string) ?? null,
        guardPattern: (r.guardPattern as string) ?? null,
        description: (r.description as string) ?? null,
        content_markdown: (r.content_markdown as string) ?? null,
      }));
    } catch {
      return [];
    }
  }

  #hasNegationConflict(textA: string, textB: string): boolean {
    if (!textA || !textB) {
      return false;
    }

    const aNeg = NEGATION_PATTERNS_ZH.test(textA) || NEGATION_PATTERNS_EN.test(textA);
    const bNeg = NEGATION_PATTERNS_ZH.test(textB) || NEGATION_PATTERNS_EN.test(textB);

    // 同极性不算矛盾
    if (aNeg === bNeg) {
      return false;
    }

    return this.#hasTopicOverlap(textA, textB);
  }

  #hasTopicOverlap(textA: string, textB: string): boolean {
    const wordsA = ContradictionDetector.extractTopicWords(textA);
    const wordsB = ContradictionDetector.extractTopicWords(textB);

    let overlap = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) {
        overlap++;
      }
    }

    const minSize = Math.min(wordsA.size, wordsB.size);
    if (minSize === 0) {
      return false;
    }

    return overlap >= MIN_TOPIC_OVERLAP_WORDS || overlap / minSize >= MIN_TOPIC_OVERLAP_RATIO;
  }

  #areRegexMutuallyExclusive(patternA: string, patternB: string): boolean {
    // 简单启发式：如果两个 pattern 的核心词完全相同但一个含否定前缀
    // 例如 "use.*SnapKit" vs "(?!.*SnapKit)" 或 "avoid.*SnapKit"
    try {
      const coreA = patternA
        .replace(/[\\^$.*+?()[\]{}|]/g, ' ')
        .trim()
        .toLowerCase();
      const coreB = patternB
        .replace(/[\\^$.*+?()[\]{}|]/g, ' ')
        .trim()
        .toLowerCase();

      const wordsA = new Set(coreA.split(/\s+/).filter((w) => w.length >= 3));
      const wordsB = new Set(coreB.split(/\s+/).filter((w) => w.length >= 3));

      let overlap = 0;
      for (const w of wordsA) {
        if (wordsB.has(w)) {
          overlap++;
        }
      }

      // 高重叠 + 一个含否定前瞻
      if (overlap >= 2 && (patternA.includes('(?!') || patternB.includes('(?!'))) {
        return true;
      }
    } catch {
      // regex parsing error
    }
    return false;
  }

  /** 提取主题词（公开为静态方法，供 RedundancyAnalyzer 复用） */
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
}

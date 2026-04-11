/**
 * ConsolidationAdvisor — 提交前融合顾问
 *
 * 解决问题：Agent 逐条提交 Recipe 导致碎片化、低价值条目激增。
 *
 * 设计思路：在新知识提交前分析已有知识库，给出 4 种建议之一：
 *   create       — 独立有价值，正常新建（走正常可信度判断）
 *   merge        — 与 1 条 Recipe 相似，将候选内容合并到已有 Recipe，合并后 Recipe → staging
 *   reorganize   — 与多条 Recipe 交叉重叠，将候选功能拆分到已有 Recipe 上，被修改的 Recipe → staging
 *   insufficient — 独立价值不足且已有足够 Recipe 覆盖，交给 Agent 与开发者决定
 *
 * 分析维度：
 *   1. 结构相似度 — 复用 RedundancyAnalyzer 的 4 维算法
 *   2. 语义域覆盖 — category + trigger 是否落在已有 Recipe 管辖范围
 *   3. 独立价值   — 内容长度、具体性、是否有独立 coreCode
 */

import { COUNTABLE_LIFECYCLES } from '../../domain/knowledge/Lifecycle.js';
import Logger from '../../infrastructure/logging/Logger.js';
import type KnowledgeRepositoryImpl from '../../repository/knowledge/KnowledgeRepository.impl.js';
import { ContradictionDetector } from './ContradictionDetector.js';

/* ────────────────────── Types ────────────────────── */

/** 提交候选的必要字段 */
export interface CandidateForConsolidation {
  title: string;
  description?: string;
  doClause?: string;
  dontClause?: string;
  coreCode?: string;
  category?: string;
  trigger?: string;
  whenClause?: string;
  kind?: string;
  content?: { pattern?: string; markdown?: string; [key: string]: unknown };
}

/** 建议类型 */
export type ConsolidationAction = 'create' | 'merge' | 'reorganize' | 'insufficient';

/** 融合方向分析 — 描述候选能为已有 Recipe 补充什么 */
export interface MergeDirection {
  /** 候选提供的新维度（已有 Recipe 缺失的） */
  addedDimensions: string[];
  /** 融合建议摘要 */
  summary: string;
}

/** 融合分析结果 */
export interface ConsolidationAdvice {
  action: ConsolidationAction;
  confidence: number;
  reason: string;
  /** action=merge 时，将候选内容合并到的目标 Recipe */
  targetRecipe?: { id: string; title: string; similarity: number };
  /** action=merge 时，候选能为目标 Recipe 补充的新维度 */
  mergeDirection?: MergeDirection;
  /** action=reorganize 时，需要重新组织的 Recipe 列表 */
  reorganizeTargets?: { id: string; title: string; similarity: number }[];
  /** action=insufficient 时，已覆盖该领域的 Recipe */
  coveredBy?: { id: string; title: string; similarity: number }[];
  /** 需要 Agent 关注的上下文 */
  relatedRecipes?: { id: string; title: string; similarity: number }[];
}

/** 批量分析结果 — 每个候选一条分析 + 批次内重叠检测 */
export interface BatchConsolidationResult {
  items: { index: number; advice: ConsolidationAdvice }[];
  /** 批次内部候选之间的重叠 */
  internalOverlaps: { indexA: number; indexB: number; similarity: number }[];
}

/** 内部用：从 DB 读取的 Recipe 简要信息 */
interface RecipeSummary {
  id: string;
  title: string;
  doClause: string | null;
  dontClause: string | null;
  coreCode: string | null;
  category: string | null;
  trigger: string | null;
  whenClause: string | null;
  guardPattern: string | null;
}

/* ────────────────────── Constants ────────────────────── */

/** 低于此阈值的 Recipe 被视为内容不足 / 碎片化 */
const MIN_SUBSTANCE_SCORE = 0.3;

/** 结构相似度达到此阈值 → enhance 建议 */
const ENHANCE_THRESHOLD = 0.4;

/** 结构相似度达到此阈值 → 判定为高度重叠 */
const HIGH_OVERLAP_THRESHOLD = 0.65;

/** 最多分析多少条同域 Recipe（控制性能） */
const MAX_CANDIDATES_PER_ANALYSIS = 30;

const WEIGHTS = { title: 0.2, clause: 0.3, code: 0.3, guard: 0.2 };

/* ────────────────────── Class ────────────────────── */

export class ConsolidationAdvisor {
  readonly #knowledgeRepo: KnowledgeRepositoryImpl;
  readonly #logger = Logger.getInstance();

  constructor(knowledgeRepo: KnowledgeRepositoryImpl) {
    this.#knowledgeRepo = knowledgeRepo;
  }

  /**
   * 分析候选知识与现有知识库的关系，返回融合建议。
   *
   * @param candidate - 待提交的候选数据
   * @returns ConsolidationAdvice — 建议 + 理由 + 上下文
   */
  async analyze(candidate: CandidateForConsolidation): Promise<ConsolidationAdvice> {
    // ── Step 1: 独立价值评估 ──
    const substanceScore = this.#assessSubstance(candidate);

    // ── Step 2: 加载同域 / 相关 Recipe ──
    const related = await this.#loadRelatedRecipes(candidate);

    // ── Step 3: insufficient — 独立价值不足，交给 Agent 与开发者决定 ──
    if (substanceScore < MIN_SUBSTANCE_SCORE) {
      if (related.length > 0) {
        const scored = related.map((r) => ({
          recipe: r,
          similarity: this.#computeSimilarity(candidate, r),
        }));
        scored.sort((a, b) => b.similarity - a.similarity);
        return {
          action: 'insufficient',
          confidence: 0.85,
          reason: this.#buildInsufficientReason(candidate, substanceScore, scored.slice(0, 3)),
          coveredBy: scored.slice(0, 5).map((s) => ({
            id: s.recipe.id,
            title: s.recipe.title,
            similarity: Math.round(s.similarity * 100) / 100,
          })),
        };
      }
      return {
        action: 'insufficient',
        confidence: 0.8,
        reason: this.#buildInsufficientReason(candidate, substanceScore, []),
      };
    }

    // ── Step 4: 无相关 Recipe → 正常新建 ──
    if (related.length === 0) {
      return {
        action: 'create',
        confidence: 0.95,
        reason: `在 ${candidate.category || '全库'} 中未找到相关 Recipe，可安全新建。`,
      };
    }

    // ── Step 5: 结构相似度分析 ──
    const scored = related.map((r) => ({
      recipe: r,
      similarity: this.#computeSimilarity(candidate, r),
    }));
    scored.sort((a, b) => b.similarity - a.similarity);

    const top = scored[0];
    const highOverlaps = scored.filter((s) => s.similarity >= HIGH_OVERLAP_THRESHOLD);
    const moderateOverlaps = scored.filter(
      (s) => s.similarity >= ENHANCE_THRESHOLD && s.similarity < HIGH_OVERLAP_THRESHOLD
    );

    // ── Step 6: 多条高度重叠 → reorganize（合并重新拆分，旧 Recipe 状态回退） ──
    if (highOverlaps.length >= 2) {
      return {
        action: 'reorganize',
        confidence: Math.min(0.9, top.similarity),
        reason:
          `候选与 ${highOverlaps.length} 条现有 Recipe 高度重叠（最高相似度 ${(top.similarity * 100).toFixed(0)}%），` +
          `建议将候选功能拆分到这些已有 Recipe 上（保留已有 Recipe 的质量数据），被修改的 Recipe 状态转为 staging。` +
          `修改后的 Recipe 走正常可信度判断。`,
        reorganizeTargets: highOverlaps.map((s) => ({
          id: s.recipe.id,
          title: s.recipe.title,
          similarity: Math.round(s.similarity * 100) / 100,
        })),
        relatedRecipes: scored.slice(0, 5).map((s) => ({
          id: s.recipe.id,
          title: s.recipe.title,
          similarity: Math.round(s.similarity * 100) / 100,
        })),
      };
    }

    // ── Step 7: 与 1 条高度重叠 → merge（融合为新 Recipe，旧 Recipe 状态回退） ──
    if (highOverlaps.length === 1) {
      const direction = this.#computeMergeDirection(candidate, top.recipe);
      return {
        action: 'merge',
        confidence: top.similarity,
        reason:
          `候选与「${top.recipe.title}」高度重叠（${(top.similarity * 100).toFixed(0)}%），` +
          `建议将候选内容合并到该 Recipe（保留已有 Recipe 的质量数据），合并后 Recipe 状态转为 staging。` +
          `${direction.summary}修改后走正常可信度判断。`,
        targetRecipe: {
          id: top.recipe.id,
          title: top.recipe.title,
          similarity: Math.round(top.similarity * 100) / 100,
        },
        mergeDirection: direction,
        relatedRecipes: scored.slice(0, 5).map((s) => ({
          id: s.recipe.id,
          title: s.recipe.title,
          similarity: Math.round(s.similarity * 100) / 100,
        })),
      };
    }

    // ── Step 8: 中度重叠 → 判断新建还是融合 ──
    if (moderateOverlaps.length > 0) {
      const direction = this.#computeMergeDirection(candidate, top.recipe);
      if (direction.addedDimensions.length === 0) {
        // 候选不提供任何新维度 → merge
        return {
          action: 'merge',
          confidence: top.similarity,
          reason:
            `候选与「${top.recipe.title}」有中度重叠（${(top.similarity * 100).toFixed(0)}%），` +
            `且未提供新维度，建议将候选内容合并到该 Recipe（保留已有 Recipe 的质量数据），合并后 Recipe 状态转为 staging。` +
            `修改后走正常可信度判断。`,
          targetRecipe: {
            id: top.recipe.id,
            title: top.recipe.title,
            similarity: Math.round(top.similarity * 100) / 100,
          },
          mergeDirection: direction,
          relatedRecipes: scored.slice(0, 5).map((s) => ({
            id: s.recipe.id,
            title: s.recipe.title,
            similarity: Math.round(s.similarity * 100) / 100,
          })),
        };
      }

      // 候选提供了新维度 → 可以新建，但附带上下文
      return {
        action: 'create',
        confidence: 0.7,
        reason:
          `候选与「${top.recipe.title}」有中度重叠（${(top.similarity * 100).toFixed(0)}%），` +
          `但提供了新维度（${direction.addedDimensions.join('、')}），允许新建。` +
          `请确保新 Recipe 职责边界清晰。`,
        relatedRecipes: scored.slice(0, 5).map((s) => ({
          id: s.recipe.id,
          title: s.recipe.title,
          similarity: Math.round(s.similarity * 100) / 100,
        })),
      };
    }

    // ── Step 9: 无显著重叠 → 正常新建 ──
    return {
      action: 'create',
      confidence: 0.9,
      reason: `候选与最相似 Recipe「${top.recipe.title}」相似度仅 ${(top.similarity * 100).toFixed(0)}%，可安全新建。`,
      relatedRecipes: scored.slice(0, 3).map((s) => ({
        id: s.recipe.id,
        title: s.recipe.title,
        similarity: Math.round(s.similarity * 100) / 100,
      })),
    };
  }

  /**
   * 批量分析候选知识与现有知识库的关系。
   *
   * 除了对每个候选独立运行 analyze() 外，
   * 还检测批次内部候选之间的重叠（防止批量提交碎片化）。
   *
   * @param candidates - 待提交的候选数组
   * @returns BatchConsolidationResult — 每条分析 + 批次内重叠
   */
  async analyzeBatch(candidates: CandidateForConsolidation[]): Promise<BatchConsolidationResult> {
    // 对每个候选独立分析（vs DB）
    const items: { index: number; advice: ConsolidationAdvice }[] = [];
    for (let index = 0; index < candidates.length; index++) {
      items.push({ index, advice: await this.analyze(candidates[index]) });
    }

    // 检测批次内候选之间的相互重叠
    const internalOverlaps: BatchConsolidationResult['internalOverlaps'] = [];
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const sim = this.#computeCandidateSimilarity(candidates[i], candidates[j]);
        if (sim >= ENHANCE_THRESHOLD) {
          internalOverlaps.push({ indexA: i, indexB: j, similarity: Math.round(sim * 100) / 100 });
        }
      }
    }

    return { items, internalOverlaps };
  }

  /* ════════════════════ 独立价值评估 ════════════════════ */

  /**
   * 评估候选是否具备独立成条的"实质性"（0-1）。
   *
   * 维度:
   *   1. 内容充实度 (0.4) — doClause+dontClause 长度 + coreCode 存在
   *   2. 具体性 (0.3) — 是否有具体的 trigger + whenClause（非通用）
   *   3. 独立代码 (0.3) — coreCode 是否足够独立（非 snippet 级别）
   */
  #assessSubstance(c: CandidateForConsolidation): number {
    let contentScore = 0;
    const doLen = (c.doClause || '').length;
    const dontLen = (c.dontClause || '').length;
    const clauseLen = doLen + dontLen;

    // doClause + dontClause 内容长度评估
    if (clauseLen >= 100) {
      contentScore = 1.0;
    } else if (clauseLen >= 40) {
      contentScore = 0.6;
    } else if (clauseLen > 0) {
      contentScore = 0.3;
    }

    // 有 coreCode 加分
    const codeLen = (c.coreCode || '').trim().length;
    if (codeLen >= 50) {
      contentScore = Math.min(1.0, contentScore + 0.2);
    }

    // 具体性: trigger + whenClause
    let specificityScore = 0;
    if (c.trigger?.startsWith('@') && c.trigger.length > 3) {
      specificityScore += 0.5;
    }
    if (c.whenClause && c.whenClause.length >= 20) {
      specificityScore += 0.5;
    }

    // 代码独立性
    let codeScore = 0;
    if (codeLen >= 100) {
      codeScore = 1.0;
    } else if (codeLen >= 30) {
      codeScore = 0.5;
    } else if (codeLen > 0) {
      codeScore = 0.2;
    }

    const total = contentScore * 0.4 + specificityScore * 0.3 + codeScore * 0.3;
    return Math.round(total * 100) / 100;
  }

  #buildInsufficientReason(
    c: CandidateForConsolidation,
    score: number,
    topRelated: { recipe: RecipeSummary; similarity: number }[]
  ): string {
    const issues: string[] = [];
    if ((c.doClause || '').length < 40) {
      issues.push('doClause 过短');
    }
    if ((c.dontClause || '').length < 20) {
      issues.push('dontClause 过短');
    }
    if ((c.coreCode || '').trim().length < 30) {
      issues.push('coreCode 不足');
    }
    if (!c.trigger || !c.trigger.startsWith('@')) {
      issues.push('缺少有效 trigger');
    }
    if (!c.whenClause || c.whenClause.length < 20) {
      issues.push('whenClause 过于笼统');
    }

    let msg =
      `候选实质性评分 ${(score * 100).toFixed(0)}% 不足（阈值 ${MIN_SUBSTANCE_SCORE * 100}%）。` +
      `问题: ${issues.join('、')}。`;

    if (topRelated.length > 0) {
      const coverList = topRelated.map((r) => `「${r.recipe.title}」`).join('、');
      msg +=
        `该领域已有 Recipe 覆盖（${coverList}），` +
        `建议与开发者讨论: 是补齐已有 Recipe 还是放弃此候选。`;
    } else {
      msg += `建议补充更多具体细节后再提交，或将此内容合并到更广泛的 Recipe 中。`;
    }

    return msg;
  }

  /* ════════════════════ 相关 Recipe 加载 ════════════════════ */

  async #loadRelatedRecipes(candidate: CandidateForConsolidation): Promise<RecipeSummary[]> {
    try {
      const category = candidate.category || '';
      const trigger = candidate.trigger || '';
      const triggerPrefix = trigger.startsWith('@')
        ? trigger.slice(
            0,
            Math.max(3, trigger.indexOf('-', 1) > 0 ? trigger.indexOf('-', 1) : trigger.length)
          )
        : '';

      const toSummary = (e: {
        id: string;
        title: string;
        doClause: string;
        dontClause: string;
        coreCode: string;
        category: string;
        trigger: string;
        whenClause: string;
        content?: { pattern?: string };
      }): RecipeSummary => ({
        id: e.id,
        title: e.title,
        doClause: e.doClause || null,
        dontClause: e.dontClause || null,
        coreCode: e.coreCode || null,
        category: e.category || null,
        trigger: e.trigger || null,
        whenClause: e.whenClause || null,
        guardPattern: e.content?.pattern || null,
      });

      if (category) {
        const entries = await this.#knowledgeRepo.findAllByLifecyclesAndCategory(
          COUNTABLE_LIFECYCLES,
          category,
          MAX_CANDIDATES_PER_ANALYSIS
        );
        const results = entries.map(toSummary);

        if (results.length < 5 && triggerPrefix.length >= 3) {
          const extra = await this.#knowledgeRepo.findByLifecyclesAndTriggerPrefix(
            COUNTABLE_LIFECYCLES,
            category,
            triggerPrefix,
            MAX_CANDIDATES_PER_ANALYSIS - results.length
          );
          const existingIds = new Set(results.map((r) => r.id));
          for (const e of extra) {
            const s = toSummary(e);
            if (!existingIds.has(s.id)) {
              results.push(s);
            }
          }
        }
        return results;
      }

      const entries = await this.#knowledgeRepo.findAllByLifecycles(COUNTABLE_LIFECYCLES);
      return entries.slice(0, MAX_CANDIDATES_PER_ANALYSIS).map(toSummary);
    } catch (err: unknown) {
      this.#logger.warn(
        `ConsolidationAdvisor: failed to load recipes: ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }
  }

  /* ════════════════════ 结构相似度计算 ════════════════════ */

  /**
   * 计算候选与某条 Recipe 的 4 维结构相似度。
   * 复用 RedundancyAnalyzer 的权重配比。
   */
  #computeSimilarity(candidate: CandidateForConsolidation, recipe: RecipeSummary): number {
    const d1 = ConsolidationAdvisor.#titleJaccard(candidate.title, recipe.title);
    const d2 = ConsolidationAdvisor.#clauseJaccard(
      [candidate.doClause, candidate.dontClause],
      [recipe.doClause, recipe.dontClause]
    );
    const d3 = ConsolidationAdvisor.#codeSimilarity(
      candidate.coreCode ?? null,
      recipe.coreCode ?? null
    );
    const candidatePattern = candidate.content?.pattern ?? null;
    const d4 =
      candidatePattern && recipe.guardPattern && candidatePattern === recipe.guardPattern ? 1.0 : 0;

    return WEIGHTS.title * d1 + WEIGHTS.clause * d2 + WEIGHTS.code * d3 + WEIGHTS.guard * d4;
  }

  /**
   * 计算两个候选之间的结构相似度（批次内重叠检测用）。
   * 复用 title / clause / code 三维，跳过 guardPattern。
   */
  #computeCandidateSimilarity(a: CandidateForConsolidation, b: CandidateForConsolidation): number {
    const d1 = ConsolidationAdvisor.#titleJaccard(a.title, b.title);
    const d2 = ConsolidationAdvisor.#clauseJaccard(
      [a.doClause, a.dontClause],
      [b.doClause, b.dontClause]
    );
    const d3 = ConsolidationAdvisor.#codeSimilarity(a.coreCode ?? null, b.coreCode ?? null);

    // 批次内无 guardPattern，权重重分配: title 0.25 / clause 0.4 / code 0.35
    return 0.25 * d1 + 0.4 * d2 + 0.35 * d3;
  }

  /* ════════════════════ 融合方向分析 ════════════════════ */

  /**
   * 分析候选能为已有 Recipe 补充哪些新「维度」。
   * 如果候选不提供任何新维度 → 纯重复，应合并到已有 Recipe。
   */
  #computeMergeDirection(
    candidate: CandidateForConsolidation,
    target: RecipeSummary
  ): MergeDirection {
    const added: string[] = [];

    // 1. 候选有 coreCode 但目标无（或很短）
    const candidateCodeLen = (candidate.coreCode || '').trim().length;
    const targetCodeLen = (target.coreCode || '').trim().length;
    if (candidateCodeLen > 30 && targetCodeLen < 30) {
      added.push('coreCode');
    }

    // 2. 候选有 dontClause 但目标无
    if ((candidate.dontClause || '').length > 20 && !(target.dontClause || '').trim()) {
      added.push('dontClause');
    }

    // 3. 候选有更具体的 whenClause
    if ((candidate.whenClause || '').length > 30 && (target.whenClause || '').length < 15) {
      added.push('whenClause');
    }

    // 4. 候选的 doClause 提供了 target 未涵盖的关键词
    const candidateKeywords = ConsolidationAdvisor.#extractKeyTerms(candidate.doClause || '');
    const targetKeywords = ConsolidationAdvisor.#extractKeyTerms(
      [target.doClause, target.dontClause].filter(Boolean).join(' ')
    );
    const newTerms = [...candidateKeywords].filter((t) => !targetKeywords.has(t));
    if (newTerms.length >= 3) {
      added.push(`新关键词(${newTerms.slice(0, 3).join(',')})`);
    }

    let summary: string;
    if (added.length > 0) {
      summary = `候选可为已有 Recipe 补充: ${added.join('、')}。`;
    } else {
      summary = `候选未提供已有 Recipe 缺失的维度，合并后内容以已有 Recipe 为主。`;
    }

    return { addedDimensions: added, summary };
  }

  /* ════════════════════ 静态工具方法 ════════════════════ */

  static #titleJaccard(titleA: string, titleB: string): number {
    const wordsA = ContradictionDetector.extractTopicWords(titleA);
    const wordsB = ContradictionDetector.extractTopicWords(titleB);

    if (wordsA.size === 0 && wordsB.size === 0) {
      return 0;
    }

    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) {
        intersection++;
      }
    }

    const union = wordsA.size + wordsB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  static #clauseJaccard(
    clausesA: (string | null | undefined)[],
    clausesB: (string | null | undefined)[]
  ): number {
    const textA = clausesA.filter(Boolean).join(' ');
    const textB = clausesB.filter(Boolean).join(' ');

    if (!textA || !textB) {
      return 0;
    }

    const wordsA = ContradictionDetector.extractTopicWords(textA);
    const wordsB = ContradictionDetector.extractTopicWords(textB);

    if (wordsA.size === 0 && wordsB.size === 0) {
      return 0;
    }

    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) {
        intersection++;
      }
    }

    const union = wordsA.size + wordsB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  static #codeSimilarity(codeA: string | null, codeB: string | null): number {
    if (!codeA || !codeB) {
      return 0;
    }

    const a = codeA.replace(/\s+/g, '');
    const b = codeB.replace(/\s+/g, '');

    if (a.length === 0 || b.length === 0) {
      return 0;
    }

    // n-gram Jaccard (n=3) — 适合中等长度代码比较
    return ConsolidationAdvisor.#ngramJaccard(a, b, 3);
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
   * 从文本中提取关键术语（过滤掉小词和常见停用词）
   */
  static #extractKeyTerms(text: string): Set<string> {
    const words = ContradictionDetector.extractTopicWords(text);
    const STOP = new Set([
      'use',
      'using',
      'used',
      'make',
      'code',
      'file',
      'class',
      'method',
      'function',
      'should',
      'must',
      'will',
      'can',
      'need',
      'when',
      'for',
      'with',
      'from',
      '使用',
      '需要',
      '可以',
      '应该',
      '不要',
      '必须',
      '进行',
      '方法',
      '函数',
    ]);
    const result = new Set<string>();
    for (const w of words) {
      if (!STOP.has(w) && w.length >= 3) {
        result.add(w);
      }
    }
    return result;
  }
}

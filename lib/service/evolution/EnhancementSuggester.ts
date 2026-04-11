/**
 * EnhancementSuggester — 使用数据反推增强建议
 *
 * 4 种增强策略：
 *   ① Guard 频繁命中但无 coreCode → 建议补充代码示例
 *   ② Search 高频命中但 adoptions=0 → 建议改善 usageGuide
 *   ③ 同类知识中 authority 偏低 → 建议补充 whenClause
 *   ④ 关联 Recipe 已 deprecated → 建议检查引用是否过时
 */

import type { KnowledgeEntry } from '../../domain/knowledge/index.js';
import { Lifecycle, PUBLISHED_LIFECYCLES } from '../../domain/knowledge/Lifecycle.js';
import Logger from '../../infrastructure/logging/Logger.js';
import type { ReportStore } from '../../infrastructure/report/ReportStore.js';
import type { SignalBus } from '../../infrastructure/signal/SignalBus.js';
import type KnowledgeRepositoryImpl from '../../repository/knowledge/KnowledgeRepository.impl.js';

export type EnhancementType =
  | 'missing_code_example'
  | 'low_adoption'
  | 'low_authority'
  | 'deprecated_reference';

export interface EnhancementSuggestion {
  recipeId: string;
  title: string;
  type: EnhancementType;
  description: string;
  priority: 'high' | 'medium' | 'low';
  evidence: string[];
}

/* ────────────────────── Constants ────────────────────── */

const GUARD_HIT_THRESHOLD = 5;
const SEARCH_HIT_THRESHOLD = 10;
const LOW_AUTHORITY_PERCENTILE = 0.25;

/* ────────────────────── Class ────────────────────── */

export class EnhancementSuggester {
  #knowledgeRepo: KnowledgeRepositoryImpl;
  #signalBus: SignalBus | null;
  #reportStore: ReportStore | null;
  #logger = Logger.getInstance();

  constructor(
    knowledgeRepo: KnowledgeRepositoryImpl,
    options: { signalBus?: SignalBus; reportStore?: ReportStore } = {}
  ) {
    this.#knowledgeRepo = knowledgeRepo;
    this.#signalBus = options.signalBus ?? null;
    this.#reportStore = options.reportStore ?? null;
  }

  /**
   * 运行全部 4 种增强策略
   */
  async analyzeAll(): Promise<EnhancementSuggestion[]> {
    const entries = await this.#knowledgeRepo.findAllByLifecycles(PUBLISHED_LIFECYCLES);
    const suggestions: EnhancementSuggestion[] = [
      ...this.#checkMissingCodeExamples(entries),
      ...this.#checkLowAdoption(entries),
      ...this.#checkLowAuthority(entries),
      ...(await this.#checkDeprecatedReferences(entries)),
    ];

    if (this.#reportStore && suggestions.length > 0) {
      void this.#reportStore.write({
        category: 'analysis',
        type: 'enhancement_suggestions',
        producer: 'EnhancementSuggester',
        data: {
          count: suggestions.length,
          byType: this.#countByType(suggestions),
        },
        timestamp: Date.now(),
      });
    }

    this.#logger.info(`EnhancementSuggester: ${suggestions.length} suggestions generated`);
    return suggestions;
  }

  /* ── Strategy ①: Guard 频繁命中但无 coreCode ── */

  #checkMissingCodeExamples(entries: KnowledgeEntry[]): EnhancementSuggestion[] {
    const rules = entries.filter((e) => e.kind === 'rule');
    const suggestions: EnhancementSuggestion[] = [];

    for (const entry of rules) {
      const hasCode = entry.coreCode && entry.coreCode.trim().length > 10;
      if (hasCode) {
        continue;
      }

      const stats = (entry.stats ?? {}) as unknown as Record<string, unknown>;
      const guardHits = (stats.guardHits as number) || 0;
      if (guardHits >= GUARD_HIT_THRESHOLD) {
        suggestions.push({
          recipeId: entry.id,
          title: entry.title,
          type: 'missing_code_example',
          description: `Guard 已命中 ${guardHits} 次但无代码示例，建议补充 coreCode 帮助开发者理解正确用法`,
          priority: guardHits >= GUARD_HIT_THRESHOLD * 3 ? 'high' : 'medium',
          evidence: [`guardHits: ${guardHits}`, 'coreCode: empty'],
        });
      }
    }

    return suggestions;
  }

  /* ── Strategy ②: Search 高频命中但 adoptions=0 ── */

  #checkLowAdoption(entries: KnowledgeEntry[]): EnhancementSuggestion[] {
    const suggestions: EnhancementSuggestion[] = [];

    for (const entry of entries) {
      const stats = (entry.stats ?? {}) as unknown as Record<string, unknown>;
      const searchHits = (stats.searchHits as number) || 0;
      const adoptions = (stats.adoptions as number) || 0;

      if (searchHits >= SEARCH_HIT_THRESHOLD && adoptions === 0) {
        suggestions.push({
          recipeId: entry.id,
          title: entry.title,
          type: 'low_adoption',
          description: `搜索命中 ${searchHits} 次但采纳为 0，建议改善 usageGuide 或 whenClause 使知识更具可操作性`,
          priority: searchHits >= SEARCH_HIT_THRESHOLD * 3 ? 'high' : 'medium',
          evidence: [`searchHits: ${searchHits}`, `adoptions: ${adoptions}`],
        });
      }
    }

    return suggestions;
  }

  /* ── Strategy ③: 同类知识中 authority 偏低 ── */

  #checkLowAuthority(entries: KnowledgeEntry[]): EnhancementSuggestion[] {
    const byCategory = new Map<string, { id: string; title: string; authority: number }[]>();

    for (const entry of entries) {
      const stats = (entry.stats ?? {}) as unknown as Record<string, unknown>;
      const authority = (stats.authority as number) || 0;
      const cat = entry.category || 'general';
      if (!byCategory.has(cat)) {
        byCategory.set(cat, []);
      }
      byCategory.get(cat)?.push({ id: entry.id, title: entry.title, authority });
    }

    const suggestions: EnhancementSuggestion[] = [];

    for (const [category, entries] of byCategory) {
      if (entries.length < 3) {
        continue; // 同类太少，无法比较
      }

      const sorted = entries.sort((a, b) => a.authority - b.authority);
      const cutoff = Math.floor(sorted.length * LOW_AUTHORITY_PERCENTILE);

      for (let i = 0; i < cutoff; i++) {
        const entry = sorted[i];
        suggestions.push({
          recipeId: entry.id,
          title: entry.title,
          type: 'low_authority',
          description: `在 "${category}" 类别中 authority 偏低 (${entry.authority})，建议补充 whenClause 和上下文描述`,
          priority: 'low',
          evidence: [
            `authority: ${entry.authority}`,
            `category: ${category}`,
            `rank: ${i + 1}/${sorted.length}`,
          ],
        });
      }
    }

    return suggestions;
  }

  /* ── Strategy ④: 关联 Recipe 已 deprecated ── */

  async #checkDeprecatedReferences(entries: KnowledgeEntry[]): Promise<EnhancementSuggestion[]> {
    const suggestions: EnhancementSuggestion[] = [];

    for (const entry of entries) {
      const relations = (entry.relations ?? {}) as unknown as Record<string, unknown>;

      const relatedIds: string[] = [];
      for (const [bucket, ids] of Object.entries(relations)) {
        if (bucket === 'deprecated_by') {
          continue; // 自身的 deprecated_by 不算
        }
        if (Array.isArray(ids)) {
          relatedIds.push(...ids);
        }
      }

      if (relatedIds.length === 0) {
        continue;
      }

      // 批量检查关联条目的 lifecycle
      for (const relId of relatedIds) {
        const relEntry = await this.#knowledgeRepo.findById(relId);
        if (relEntry && relEntry.lifecycle === Lifecycle.DEPRECATED) {
          suggestions.push({
            recipeId: entry.id,
            title: entry.title,
            type: 'deprecated_reference',
            description: `引用了已废弃的 Recipe "${relEntry.title}" (${relEntry.id})，建议检查引用是否过时`,
            priority: 'high',
            evidence: [`referenced: ${relEntry.id}`, `referenced_title: ${relEntry.title}`],
          });
        }
      }
    }

    return suggestions;
  }

  /* ── Helpers ── */

  #countByType(suggestions: EnhancementSuggestion[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const s of suggestions) {
      counts[s.type] = (counts[s.type] || 0) + 1;
    }
    return counts;
  }
}

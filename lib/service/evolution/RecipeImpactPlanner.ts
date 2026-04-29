/**
 * RecipeImpactPlanner — 批量进化候选生成器
 *
 * 基于 FileDiffSnapshotStore.computeDiff 的 hash diff 结果（非 git diff），
 * 批量分析所有变更文件对 Recipe 的影响，生成 EvolutionCandidatePlan。
 *
 * 与 FileChangeHandler 的区别:
 *   - FileChangeHandler 处理实时 IDE 事件，使用 git diff HEAD，逐个文件分析
 *   - RecipeImpactPlanner 处理 rescan 批量 diff，消费 runAllPhases 的 incrementalPlan 产出
 *
 * @module service/evolution/RecipeImpactPlanner
 */

import type { EvolutionAuditRecipe } from '../../agent/runs/evolution/EvolutionAgentRun.js';
import type KnowledgeRepositoryImpl from '../../repository/knowledge/KnowledgeRepository.impl.js';
import type { RecipeSourceRefRepositoryImpl } from '../../repository/sourceref/RecipeSourceRefRepository.js';
import { extractRecipeTokens } from '../../shared/recipe-tokens.js';
import { assessImpactUnified } from './ContentImpactAnalyzer.js';

// ── Types ──────────────────────────────────────────────

export type EvolutionCandidateReason =
  | 'source-deleted'
  | 'source-deleted-partial'
  | 'source-modified-pattern'
  | 'source-missing';

export interface EvolutionCandidate {
  recipeId: string;
  recipeTitle: string;
  reason: EvolutionCandidateReason;
  affectedFiles: string[];
  impactScore: number;
  matchedTokens: string[];
  sourceRefs: string[];
  activeRefCount: number;
}

export interface IgnoredChange {
  filePath: string;
  reason: 'no-recipe-reference' | 'impact-below-threshold' | 'recipe-not-active';
}

export interface EvolutionCandidatePlan {
  candidates: EvolutionCandidate[];
  ignored: IgnoredChange[];
  summary: {
    totalChangedFiles: number;
    filesWithRecipeRef: number;
    candidateCount: number;
    ignoredCount: number;
    byReason: Record<string, number>;
  };
}

export interface DiffInput {
  added: string[];
  modified: string[];
  deleted: string[];
}

// ── Reason priority (higher = more critical) ──

const REASON_PRIORITY: Record<EvolutionCandidateReason, number> = {
  'source-deleted': 4,
  'source-deleted-partial': 3,
  'source-modified-pattern': 2,
  'source-missing': 1,
};

// ── Class ──────────────────────────────────────────────

export class RecipeImpactPlanner {
  readonly #projectRoot: string;
  readonly #sourceRefRepo: RecipeSourceRefRepositoryImpl;
  readonly #knowledgeRepo: KnowledgeRepositoryImpl;

  constructor(
    projectRoot: string,
    sourceRefRepo: RecipeSourceRefRepositoryImpl,
    knowledgeRepo: KnowledgeRepositoryImpl
  ) {
    this.#projectRoot = projectRoot;
    this.#sourceRefRepo = sourceRefRepo;
    this.#knowledgeRepo = knowledgeRepo;
  }

  async plan(diff: DiffInput | null): Promise<EvolutionCandidatePlan> {
    if (!diff) {
      return this.#buildPlanFromStaleOnly();
    }

    const candidateMap = new Map<string, EvolutionCandidate>();
    const ignored: IgnoredChange[] = [];

    // ── Phase A: deleted 文件 → source-deleted / source-deleted-partial ──
    for (const deletedPath of diff.deleted) {
      const refs = this.#sourceRefRepo.findBySourcePath(deletedPath);
      if (refs.length === 0) {
        ignored.push({ filePath: deletedPath, reason: 'no-recipe-reference' });
        continue;
      }
      for (const ref of refs) {
        const allRefs = this.#sourceRefRepo.findByRecipeId(ref.recipeId);
        const activeRefs = allRefs.filter(
          (r) => r.status === 'active' && r.sourcePath !== deletedPath
        );
        const reason: EvolutionCandidateReason =
          activeRefs.length === 0 ? 'source-deleted' : 'source-deleted-partial';
        await this.#mergeCandidate(candidateMap, ref.recipeId, {
          reason,
          affectedFiles: [deletedPath],
          impactScore: reason === 'source-deleted' ? 1.0 : 0.7,
          matchedTokens: [],
          activeRefCount: activeRefs.length,
        });
      }
    }

    // ── Phase B: modified 文件 → source-modified-pattern / ignored ──
    for (const modifiedPath of diff.modified) {
      const refs = this.#sourceRefRepo.findBySourcePath(modifiedPath);
      if (refs.length === 0) {
        ignored.push({ filePath: modifiedPath, reason: 'no-recipe-reference' });
        continue;
      }
      for (const ref of refs) {
        const entry = await this.#knowledgeRepo.findById(ref.recipeId);
        if (!entry || entry.lifecycle !== 'active') {
          ignored.push({ filePath: modifiedPath, reason: 'recipe-not-active' });
          continue;
        }
        const recipeTokens = extractRecipeTokens(entry);
        const impact = assessImpactUnified(this.#projectRoot, modifiedPath, recipeTokens);
        if (impact && impact.level === 'pattern') {
          await this.#mergeCandidate(candidateMap, ref.recipeId, {
            reason: 'source-modified-pattern',
            affectedFiles: [modifiedPath],
            impactScore: impact.score,
            matchedTokens: impact.matchedTokens,
            activeRefCount: -1,
          });
        } else {
          ignored.push({ filePath: modifiedPath, reason: 'impact-below-threshold' });
        }
      }
    }

    // ── Phase C: stale sourceRef → source-missing ──
    const staleRefs = this.#sourceRefRepo.findStale();
    for (const ref of staleRefs) {
      if (!candidateMap.has(ref.recipeId)) {
        await this.#mergeCandidate(candidateMap, ref.recipeId, {
          reason: 'source-missing',
          affectedFiles: [ref.sourcePath],
          impactScore: 0.5,
          matchedTokens: [],
          activeRefCount: -1,
        });
      }
    }

    return this.#buildPlan(candidateMap, ignored, diff);
  }

  // ── Private ──

  async #buildPlanFromStaleOnly(): Promise<EvolutionCandidatePlan> {
    const candidateMap = new Map<string, EvolutionCandidate>();
    const staleRefs = this.#sourceRefRepo.findStale();
    for (const ref of staleRefs) {
      await this.#mergeCandidate(candidateMap, ref.recipeId, {
        reason: 'source-missing',
        affectedFiles: [ref.sourcePath],
        impactScore: 0.5,
        matchedTokens: [],
        activeRefCount: -1,
      });
    }
    return this.#buildPlan(candidateMap, [], null);
  }

  async #mergeCandidate(
    map: Map<string, EvolutionCandidate>,
    recipeId: string,
    data: {
      reason: EvolutionCandidateReason;
      affectedFiles: string[];
      impactScore: number;
      matchedTokens: string[];
      activeRefCount: number;
    }
  ) {
    const existing = map.get(recipeId);
    if (!existing) {
      const entry = await this.#knowledgeRepo.findById(recipeId);
      const allRefs = this.#sourceRefRepo.findByRecipeId(recipeId);
      map.set(recipeId, {
        recipeId,
        recipeTitle: entry?.title ?? '',
        reason: data.reason,
        affectedFiles: [...data.affectedFiles],
        impactScore: data.impactScore,
        matchedTokens: [...data.matchedTokens],
        sourceRefs: allRefs.map((r) => r.sourcePath),
        activeRefCount:
          data.activeRefCount >= 0
            ? data.activeRefCount
            : allRefs.filter((r) => r.status === 'active').length,
      });
      return;
    }

    // Merge: take higher priority reason, higher impact score, union files & tokens
    if (REASON_PRIORITY[data.reason] > REASON_PRIORITY[existing.reason]) {
      existing.reason = data.reason;
    }
    existing.impactScore = Math.max(existing.impactScore, data.impactScore);
    for (const f of data.affectedFiles) {
      if (!existing.affectedFiles.includes(f)) {
        existing.affectedFiles.push(f);
      }
    }
    for (const t of data.matchedTokens) {
      if (!existing.matchedTokens.includes(t)) {
        existing.matchedTokens.push(t);
      }
    }
    if (data.activeRefCount >= 0 && data.activeRefCount < existing.activeRefCount) {
      existing.activeRefCount = data.activeRefCount;
    }
  }

  #buildPlan(
    candidateMap: Map<string, EvolutionCandidate>,
    ignored: IgnoredChange[],
    diff: DiffInput | null
  ): EvolutionCandidatePlan {
    const candidates = [...candidateMap.values()];
    const byReason: Record<string, number> = {};
    for (const c of candidates) {
      byReason[c.reason] = (byReason[c.reason] ?? 0) + 1;
    }

    const totalChangedFiles = diff
      ? diff.added.length + diff.modified.length + diff.deleted.length
      : 0;

    const filesWithRef = new Set<string>();
    for (const c of candidates) {
      for (const f of c.affectedFiles) {
        filesWithRef.add(f);
      }
    }

    return {
      candidates,
      ignored,
      summary: {
        totalChangedFiles,
        filesWithRecipeRef: filesWithRef.size,
        candidateCount: candidates.length,
        ignoredCount: ignored.length,
        byReason,
      },
    };
  }
}

// ── Conversion Helper ──

/**
 * 将 EvolutionCandidate 转换为 EvolutionAuditRecipe（供 runEvolutionAudit 消费）。
 *
 * @param candidate RecipeImpactPlanner.plan() 产出的候选
 * @param knowledgeRepo 用于获取 Recipe 完整内容
 */
export async function toEvolutionAuditRecipe(
  candidate: EvolutionCandidate,
  knowledgeRepo: KnowledgeRepositoryImpl
): Promise<EvolutionAuditRecipe> {
  const entry = await knowledgeRepo.findById(candidate.recipeId);
  let content: EvolutionAuditRecipe['content'];
  try {
    if (entry?.content) {
      const raw = typeof entry.content === 'string' ? JSON.parse(entry.content) : entry.content;
      content = raw as EvolutionAuditRecipe['content'];
    }
  } catch {
    content = undefined;
  }
  return {
    id: candidate.recipeId,
    title: candidate.recipeTitle,
    trigger: entry?.trigger ?? '',
    content,
    sourceRefs: candidate.sourceRefs,
    impactEvidence: {
      reason: candidate.reason,
      affectedFiles: candidate.affectedFiles,
      impactScore: candidate.impactScore,
      matchedTokens: candidate.matchedTokens,
    },
    auditHint: null,
  };
}

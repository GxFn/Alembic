/**
 * ReactiveEvolutionService — 文件变更驱动的 Recipe 实时进化
 *
 * 核心策略：
 *   - 能自动修复的（路径重命名）→ ContentPatcher 修复
 *   - 修不了的（文件/路径删除）→ 直接 deprecated
 *   - 项目结构变化（modified）→ 标记受影响 Recipe + 返回变更摘要供 Agent 进化检查
 *
 * 不做全量扫描，仅处理传入的 FileChangeEvent 列表。
 * 由 HTTP POST /api/v1/evolution/file-changed 或 MCP 触发。
 *
 * @module service/evolution/ReactiveEvolutionService
 */

import Logger from '../../infrastructure/logging/Logger.js';
import type { SignalBus } from '../../infrastructure/signal/SignalBus.js';
import type KnowledgeRepositoryImpl from '../../repository/knowledge/KnowledgeRepository.impl.js';
import type { RecipeSourceRefRepositoryImpl } from '../../repository/sourceref/RecipeSourceRefRepository.js';
import type { FileChangeEvent, ReactiveEvolutionReport } from '../../types/reactive-evolution.js';
import type { ContentPatcher } from './ContentPatcher.js';
import type { RecipeLifecycleSupervisor } from './RecipeLifecycleSupervisor.js';

/* ────────────────────── Class ────────────────────── */

export class ReactiveEvolutionService {
  readonly #sourceRefRepo: RecipeSourceRefRepositoryImpl;
  readonly #knowledgeRepo: KnowledgeRepositoryImpl;
  readonly #contentPatcher: ContentPatcher;
  readonly #lifecycleSupervisor: RecipeLifecycleSupervisor;
  readonly #signalBus: SignalBus | null;
  readonly #logger = Logger.getInstance();

  constructor(
    sourceRefRepo: RecipeSourceRefRepositoryImpl,
    knowledgeRepo: KnowledgeRepositoryImpl,
    contentPatcher: ContentPatcher,
    lifecycleSupervisor: RecipeLifecycleSupervisor,
    options?: { signalBus?: SignalBus }
  ) {
    this.#sourceRefRepo = sourceRefRepo;
    this.#knowledgeRepo = knowledgeRepo;
    this.#contentPatcher = contentPatcher;
    this.#lifecycleSupervisor = lifecycleSupervisor;
    this.#signalBus = options?.signalBus ?? null;
  }

  /**
   * 统一入口 — 处理一批文件变更事件
   *
   * 每个事件按类型分派:
   *   renamed  → 自动修复 sourceRef 路径
   *   deleted  → 检查是否还有其他 active ref，无则弃用
   *   modified → 跳过（结构变化由 Agent 增量扫描处理）
   */
  async handleFileChanges(events: FileChangeEvent[]): Promise<ReactiveEvolutionReport> {
    const report: ReactiveEvolutionReport = {
      fixed: 0,
      deprecated: 0,
      skipped: 0,
      needsReview: 0,
      suggestReview: false,
      details: [],
    };

    for (const event of events) {
      switch (event.type) {
        case 'renamed': {
          if (!event.newPath) {
            this.#logger.warn(
              '[ReactiveEvolution] renamed event missing newPath, treating as deleted',
              { oldPath: event.oldPath }
            );
            await this.#handleDeleted(event.oldPath, report);
          } else {
            await this.#handleRenamed(event.oldPath, event.newPath, report);
          }
          break;
        }
        case 'deleted': {
          await this.#handleDeleted(event.oldPath, report);
          break;
        }
        case 'modified': {
          this.#handleModified(event.oldPath, report);
          break;
        }
      }
    }

    if (report.fixed > 0 || report.deprecated > 0 || report.needsReview > 0) {
      this.#logger.info('[ReactiveEvolution] handleFileChanges complete', {
        fixed: report.fixed,
        deprecated: report.deprecated,
        needsReview: report.needsReview,
        skipped: report.skipped,
      });

      // 发射信号通知其他子系统
      this.#emitSignals(report);
    }

    // 结构性变动较大时建议用户触发进化检查
    report.suggestReview = report.needsReview >= 3 || report.deprecated > 0;

    return report;
  }

  /* ═══════════════════ Renamed ═══════════════════ */

  /**
   * 文件重命名 → 修复所有引用该路径的 Recipe
   *
   * 1. 查 recipe_source_refs 找到受影响 Recipe
   * 2. 用 ContentPatcher 替换 sourceRefs 中的旧路径
   * 3. 更新 recipe_source_refs 记录
   */
  async #handleRenamed(
    oldPath: string,
    newPath: string,
    report: ReactiveEvolutionReport
  ): Promise<void> {
    const affected = this.#sourceRefRepo.findBySourcePath(oldPath);

    if (affected.length === 0) {
      report.skipped++;
      return;
    }

    for (const ref of affected) {
      try {
        // 用 ContentPatcher 修复 Recipe 的 sourceRefs 字段
        const patchResult = await this.#contentPatcher.applyProposal(
          {
            id: `reactive-rename-${ref.recipeId}-${Date.now()}`,
            type: 'correction',
            targetRecipeId: ref.recipeId,
            evidence: [
              {
                suggestedChanges: JSON.stringify({
                  patchVersion: 1,
                  changes: [
                    {
                      field: 'sourceRefs',
                      action: 'replace',
                      newValue: newPath,
                    },
                  ],
                  reasoning: `File renamed: ${oldPath} → ${newPath}`,
                }),
              },
            ],
          },
          'correction'
        );

        // 更新 recipe_source_refs 桥接表
        this.#sourceRefRepo.replaceSourcePath(ref.recipeId, oldPath, newPath, Date.now());

        // 同步更新 reasoning.sources
        await this.#updateReasoningSources(ref.recipeId, oldPath, newPath);

        const title = await this.#getRecipeTitle(ref.recipeId);
        report.fixed++;
        report.details.push({
          recipeId: ref.recipeId,
          recipeTitle: title,
          action: 'fix-rename',
          reason: `sourceRef path updated: ${oldPath} → ${newPath} (patch: ${patchResult.success ? 'ok' : 'skipped'})`,
        });
      } catch (err: unknown) {
        this.#logger.warn('[ReactiveEvolution] rename fix failed', {
          recipeId: ref.recipeId,
          error: (err as Error).message,
        });
        // 修复失败 → 标记 stale，不弃用
        this.#sourceRefRepo.upsert({
          recipeId: ref.recipeId,
          sourcePath: oldPath,
          status: 'stale',
          verifiedAt: Date.now(),
        });
      }
    }
  }

  /* ═══════════════════ Deleted ═══════════════════ */

  /**
   * 文件删除 → 检查 Recipe 是否还有其他 active sourceRef
   *   - 还有 → 只标记该 ref 为 stale
   *   - 没了 → 直接弃用整条 Recipe
   */
  async #handleDeleted(deletedPath: string, report: ReactiveEvolutionReport): Promise<void> {
    const affected = this.#sourceRefRepo.findBySourcePath(deletedPath);

    if (affected.length === 0) {
      report.skipped++;
      return;
    }

    for (const ref of affected) {
      try {
        // 标记当前 ref 为 stale
        this.#sourceRefRepo.upsert({
          recipeId: ref.recipeId,
          sourcePath: deletedPath,
          status: 'stale',
          verifiedAt: Date.now(),
        });

        // 检查该 Recipe 是否还有其他 active 的 sourceRef
        const allRefs = this.#sourceRefRepo.findByRecipeId(ref.recipeId);
        const activeRefs = allRefs.filter(
          (r) => r.sourcePath !== deletedPath && r.status === 'active'
        );

        const title = await this.#getRecipeTitle(ref.recipeId);

        if (activeRefs.length === 0) {
          // 所有来源都没了 → 直接弃用
          const result = await this.#lifecycleSupervisor.transition({
            recipeId: ref.recipeId,
            targetState: 'deprecated',
            trigger: 'decay-detection',
            evidence: {
              reason: `All source references lost (deleted: ${deletedPath})`,
            },
            operatorId: 'ReactiveEvolutionService',
          });

          if (result.success) {
            report.deprecated++;
            report.details.push({
              recipeId: ref.recipeId,
              recipeTitle: title,
              action: 'deprecate',
              reason: `All source references lost (deleted: ${deletedPath})`,
            });
          } else {
            // 转移失败（可能当前状态不允许直接到 deprecated）
            this.#logger.warn('[ReactiveEvolution] deprecation transition failed', {
              recipeId: ref.recipeId,
              error: result.error,
            });
            report.skipped++;
          }
        } else {
          // 还有其他来源 → 只记录 stale，不弃用
          report.details.push({
            recipeId: ref.recipeId,
            recipeTitle: title,
            action: 'skip',
            reason: `Source ref marked stale (${activeRefs.length} active refs remain)`,
          });
          report.skipped++;
        }
      } catch (err: unknown) {
        this.#logger.warn('[ReactiveEvolution] delete handling failed', {
          recipeId: ref.recipeId,
          error: (err as Error).message,
        });
        report.skipped++;
      }
    }
  }

  /* ═══════════════════ Modified ═══════════════════ */

  /**
   * 文件内容变更 → 粗略评估受影响 Recipe
   *
   * 不做 AST 细粒度 diff，只查 recipe_source_refs 判断
   * 该文件是否关联了 Recipe。如果关联了，标记 needs-review
   * 供 Agent 在增量扫描时做进化检查。
   */
  #handleModified(modifiedPath: string, report: ReactiveEvolutionReport): void {
    const affected = this.#sourceRefRepo.findBySourcePath(modifiedPath);

    if (affected.length === 0) {
      report.skipped++;
      return;
    }

    for (const ref of affected) {
      const title = ref.recipeId; // 粗略评估不查 DB 拿标题
      report.needsReview++;
      report.details.push({
        recipeId: ref.recipeId,
        recipeTitle: title,
        action: 'needs-review',
        reason: `Source file modified: ${modifiedPath}`,
      });
    }
  }

  /* ═══════════════════ Helpers ═══════════════════ */

  /** 更新 Recipe 的 reasoning.sources（替换旧路径为新路径） */
  async #updateReasoningSources(recipeId: string, oldPath: string, newPath: string): Promise<void> {
    try {
      const entry = await this.#knowledgeRepo.findSourceFileAndReasoning(recipeId);
      if (!entry?.reasoning) {
        return;
      }

      const reasoning = JSON.parse(entry.reasoning) as Record<string, unknown>;
      const sources = Array.isArray(reasoning.sources) ? [...(reasoning.sources as string[])] : [];

      const idx = sources.indexOf(oldPath);
      if (idx >= 0) {
        sources[idx] = newPath;
        reasoning.sources = sources;
        await this.#knowledgeRepo.updateReasoning(recipeId, JSON.stringify(reasoning), Date.now());
      }
    } catch {
      // reasoning 更新失败不阻塞主流程
    }
  }

  /** 获取 Recipe 标题（用于报告） */
  async #getRecipeTitle(recipeId: string): Promise<string> {
    try {
      const entry = await this.#knowledgeRepo.findById(recipeId);
      return entry?.title ?? recipeId;
    } catch {
      return recipeId;
    }
  }

  /** 发射信号通知其他子系统 */
  #emitSignals(report: ReactiveEvolutionReport): void {
    if (!this.#signalBus) {
      return;
    }
    try {
      if (report.fixed > 0) {
        this.#signalBus.send('quality', 'ReactiveEvolutionService', 0.1, {
          metadata: {
            reason: 'reactive_fix',
            fixed: report.fixed,
          },
        });
      }
      if (report.deprecated > 0) {
        this.#signalBus.send('lifecycle', 'ReactiveEvolutionService', 1.0, {
          metadata: {
            reason: 'reactive_deprecate',
            deprecated: report.deprecated,
          },
        });
      }
      if (report.needsReview > 0) {
        this.#signalBus.send('quality', 'ReactiveEvolutionService', 0.5, {
          metadata: {
            reason: 'reactive_needs_review',
            needsReview: report.needsReview,
            affectedRecipes: report.details
              .filter((d) => d.action === 'needs-review')
              .map((d) => d.recipeId),
          },
        });
      }
    } catch {
      // 信号发射失败不影响主流程
    }
  }
}

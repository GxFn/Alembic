/**
 * FileChangeHandler — 文件变更驱动的 Recipe 实时进化
 *
 * 核心策略：
 *   - 路径重命名 → 通过 Gateway 提交 update proposal，等待人工 review
 *   - 文件/路径删除 → 通过 Gateway 提交 deprecate proposal，等待人工 review
 *   - 项目结构变化（modified）→ 标记受影响 Recipe + 返回变更摘要供 Agent 进化检查
 *
 * 不做全量扫描，仅处理传入的 FileChangeEvent 列表。
 * 由 HTTP POST /api/v1/evolution/file-changed 或 MCP 触发。
 *
 * lifecycle 变更通过 Gateway → LifecycleStateMachine 链路自动完成，
 * lifecycle signal 由 StateMachine 内部发射。本类仅发射 quality signal。
 *
 * @module service/evolution/FileChangeHandler
 */

import type { SignalBus } from '@alembic/core/events';
import {
  assessFileImpact,
  type ContentPatcher,
  type EvolutionGateway,
  extractRecipeTokens,
} from '@alembic/core/evolution';
import { isConsumable, isDegraded } from '@alembic/core/knowledge';
import Logger from '@alembic/core/logging';
import type { KnowledgeRepository, SourceRefRepository } from '@alembic/core/repositories';
import type { FileChangeEvent, ImpactLevel, ReactiveEvolutionReport } from '@alembic/core/types';
import type { FileChangeSubscriber } from '../FileChangeDispatcher.js';

/** impactLevel → quality signal 权重映射（文档 §5.3）
 *
 * v3 语义：
 *   - direct: 文件删除且无其他引用 → 最高权重
 *   - pattern: diff 动到了 30%+ 的 Recipe 关键标识符 → 高权重
 *   - reference: diff 有少量 Recipe 标识符命中 → 低权重
 */
const IMPACT_WEIGHTS: Record<ImpactLevel, number> = {
  direct: 0.8,
  pattern: 0.6,
  reference: 0.3,
};

/* ────────────────────── Class ────────────────────── */

export class FileChangeHandler implements FileChangeSubscriber {
  readonly name = 'FileChangeHandler';
  readonly #sourceRefRepo: SourceRefRepository;
  readonly #knowledgeRepo: KnowledgeRepository;
  readonly #signalBus: SignalBus | null;
  readonly #gateway: EvolutionGateway;
  readonly #projectRoot: string;
  readonly #logger = Logger.getInstance();

  constructor(
    sourceRefRepo: SourceRefRepository,
    knowledgeRepo: KnowledgeRepository,
    _contentPatcher: ContentPatcher,
    options: {
      signalBus?: SignalBus;
      evolutionGateway: EvolutionGateway;
      dataRoot?: string;
      projectRoot?: string;
    }
  ) {
    this.#sourceRefRepo = sourceRefRepo;
    this.#knowledgeRepo = knowledgeRepo;
    this.#signalBus = options.signalBus ?? null;
    this.#gateway = options.evolutionGateway;
    this.#projectRoot = options.projectRoot ?? process.cwd();
  }

  /**
   * FileChangeSubscriber 接口实现 — 适配新事件模型
   */
  async onFileChanges(events: FileChangeEvent[]): Promise<ReactiveEvolutionReport> {
    return this.handleFileChanges(events);
  }

  /**
   * 统一入口 — 处理一批文件变更事件
   *
   * 每个事件按类型分派:
   *   renamed  → 创建 update proposal，不自动改 Recipe/sourceRefs
   *   deleted  → 检查是否还有其他 active ref，无则创建 deprecate proposal
   *   modified → 跳过（结构变化由 Agent 增量扫描处理）
   *   created  → 跳过（新文件不影响已有 Recipe）
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
      if (isIgnoredFileChangePath(event.path) || isIgnoredFileChangePath(event.oldPath ?? '')) {
        report.skipped++;
        continue;
      }

      switch (event.type) {
        case 'renamed': {
          const oldP = event.oldPath ?? event.path;
          const newP = event.oldPath ? event.path : undefined;
          if (!newP) {
            this.#logger.warn(
              '[FileChangeHandler] renamed event missing target path, treating as deleted',
              { oldPath: oldP }
            );
            await this.#handleDeleted(oldP, report);
          } else {
            await this.#handleRenamed(oldP, newP, report);
          }
          break;
        }
        case 'deleted': {
          await this.#handleDeleted(event.path, report);
          break;
        }
        case 'modified': {
          await this.#handleModified(event.path, report);
          break;
        }
        case 'created': {
          // 新文件不影响已有 Recipe，跳过
          report.skipped++;
          break;
        }
      }
    }

    if (report.fixed > 0 || report.deprecated > 0 || report.needsReview > 0) {
      this.#logger.info('[FileChangeHandler] handleFileChanges complete', {
        fixed: report.fixed,
        deprecated: report.deprecated,
        needsReview: report.needsReview,
        skipped: report.skipped,
      });

      // 发射信号通知其他子系统
      this.#emitSignals(report);
    }

    // 结构性变动较大时建议用户触发进化检查。
    // 按文档 §5.4.1 Strategy C：'direct'（删除）或 'pattern'（30%+ token 命中）→ 建议；或 deprecated 发生。
    const hasHighImpact = report.details.some(
      (d) =>
        d.action === 'needs-review' && (d.impactLevel === 'direct' || d.impactLevel === 'pattern')
    );
    report.suggestReview = hasHighImpact || report.deprecated > 0;

    return report;
  }

  /* ═══════════════════ Renamed ═══════════════════ */

  /**
   * 文件重命名 → 为所有引用旧路径的 Recipe 创建 update proposal
   *
   * 1. 查 recipe_source_refs 找到受影响 Recipe
   * 2. 记录 oldPath/newPath evidence
   * 3. 不自动改 Recipe/sourceRefs，交给 review consumer 或后续 Agent enrichment
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
        const title = await this.#getRecipeTitle(ref.recipeId);
        const reason = `Source file renamed: ${oldPath} → ${newPath}; review Recipe sourceRefs before applying.`;
        const gatewayResult = await this.#gateway.submit({
          recipeId: ref.recipeId,
          action: 'update',
          source: 'file-change',
          confidence: 0.85,
          description: reason,
          evidence: [
            {
              changeKind: 'renamed',
              detectedAt: Date.now(),
              newPath,
              oldPath,
              producerKind: 'alembic-file-monitor',
            },
          ],
        });

        if (gatewayResult.outcome === 'error') {
          this.#logger.warn('[FileChangeHandler] Gateway rename proposal failed', {
            recipeId: ref.recipeId,
            error: gatewayResult.error,
          });
          report.skipped++;
          continue;
        }

        report.needsReview++;
        report.details.push({
          recipeId: ref.recipeId,
          recipeTitle: title,
          action: 'needs-review',
          reason,
          impactLevel: 'direct',
          modifiedPath: newPath,
        });
      } catch (err: unknown) {
        this.#logger.warn('[FileChangeHandler] rename proposal failed', {
          recipeId: ref.recipeId,
          error: (err as Error).message,
        });
        report.skipped++;
      }
    }
  }

  /* ═══════════════════ Deleted ═══════════════════ */

  /**
   * 文件删除 → 检查 Recipe 是否还有其他 active sourceRef
   *   - 还有 → 只标记该 ref 为 stale
   *   - 没了 → 创建 deprecate proposal，不立即弃用 Recipe
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
          // 所有来源都没了 → 通过 Gateway 统一创建 deprecate proposal
          const reason = `All source references lost (deleted: ${deletedPath})`;

          const gatewayResult = await this.#gateway.submit({
            recipeId: ref.recipeId,
            action: 'deprecate',
            source: 'file-change',
            confidence: 0.7,
            description: reason,
            evidence: [
              {
                changeKind: 'deleted',
                deletedPath,
                detectedAt: Date.now(),
                producerKind: 'alembic-file-monitor',
                remainingActiveRefs: 0,
              },
            ],
          });

          if (gatewayResult.outcome !== 'error') {
            report.needsReview++;
            report.details.push({
              recipeId: ref.recipeId,
              recipeTitle: title,
              action: 'needs-review',
              reason: `${reason}; deprecate proposal requires review.`,
              impactLevel: 'direct',
              modifiedPath: deletedPath,
            });
          } else {
            this.#logger.warn('[FileChangeHandler] Gateway deprecation failed', {
              recipeId: ref.recipeId,
              error: gatewayResult.error,
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
        this.#logger.warn('[FileChangeHandler] delete handling failed', {
          recipeId: ref.recipeId,
          error: (err as Error).message,
        });
        report.skipped++;
      }
    }
  }

  /* ═══════════════════ Modified ═══════════════════ */

  /**
   * 文件内容变更 → 获取 diff，与每条关联 Recipe 做 diff-based 内容影响评估。
   *
   * v3 流程：
   *   1. `SourceRefRepository.findBySourcePath(path)` → 找到关联 Recipe
   *   2. `getFileDiff` 获取行级变更
   *   3. 解析 diff，提取变更行标识符
   *   4. 与 Recipe 全字段 token 做交集 → 分级
   *
   * 不支持 git 的场景直接跳过，不做降级。
   */
  async #handleModified(modifiedPath: string, report: ReactiveEvolutionReport): Promise<void> {
    const affected = this.#sourceRefRepo.findBySourcePath(modifiedPath);

    if (affected.length === 0) {
      report.skipped++;
      return;
    }

    for (const ref of affected) {
      let title = ref.recipeId;
      let entry: Record<string, unknown> | null = null;
      try {
        entry = (await this.#knowledgeRepo.findById(ref.recipeId)) as unknown as Record<
          string,
          unknown
        > | null;
      } catch {
        entry = null;
      }

      // 只跟踪仍可消费或处于治理中的知识；pending/deprecated 不进入进化链路。
      if (entry && !isEvolutionTrackableLifecycle(entry.lifecycle)) {
        report.skipped++;
        continue;
      }

      if (entry) {
        title = (typeof entry.title === 'string' ? entry.title : '') || ref.recipeId;
      }

      // 提取 Recipe 全字段 token
      const recipeTokens = extractRecipeTokens(entry ?? {});

      // diff-based 影响评估
      const result = assessFileImpact(this.#projectRoot, modifiedPath, recipeTokens);

      // 无法获取 diff（无 git / untracked / 无变更）→ 跳过
      if (!result) {
        report.skipped++;
        continue;
      }

      const { level: impactLevel, score, matchedTokens } = result;

      // pattern 级别：diff 动到了 30%+ 的 Recipe 关键标识符 → 弹窗 + 持久化提案
      if (impactLevel === 'pattern') {
        report.needsReview++;
        const reason = `Recipe 描述的 API/模式被修改 (score=${score.toFixed(2)}, tokens: ${matchedTokens.join(', ')})`;
        report.details.push({
          recipeId: ref.recipeId,
          recipeTitle: title,
          action: 'needs-review',
          reason,
          impactLevel,
          modifiedPath,
        });

        // 通过 Gateway 持久化为 update 提案，确保即使弹窗被忽略也不丢失
        try {
          await this.#gateway.submit({
            recipeId: ref.recipeId,
            action: 'update',
            source: 'file-change',
            confidence: Math.min(0.5 + score, 0.9),
            description: reason,
            evidence: [
              {
                changeKind: 'modified',
                detectedAt: Date.now(),
                matchedTokens,
                modifiedPath,
                producerKind: 'alembic-file-monitor',
                score,
              },
            ],
          });
        } catch {
          // 提案创建失败不影响主流程（signal 仍然发射）
        }
      }

      // 所有级别都发射信号（ProposalExecutor 消费）
      this.#emitSourceModifiedSignal(ref.recipeId, modifiedPath, impactLevel);
    }
  }

  /**
   * 为单条 Recipe 发射一条 `source_modified` signal。
   *
   * 下游消费者：
   *   - ProposalExecutor.#evaluateOnSignal（文档 §9.1）
   *   - 未来 rescan Phase A 的进化前置过滤（文档 §6）
   */
  #emitSourceModifiedSignal(
    recipeId: string,
    modifiedPath: string,
    impactLevel: ImpactLevel
  ): void {
    if (!this.#signalBus) {
      return;
    }
    try {
      this.#signalBus.send('quality', 'FileChangeHandler', IMPACT_WEIGHTS[impactLevel], {
        target: recipeId,
        metadata: {
          reason: 'source_modified',
          modifiedPath,
          impactLevel,
        },
      });
    } catch {
      // 信号发射失败不影响主流程
    }
  }

  /* ═══════════════════ Helpers ═══════════════════ */

  /** 获取 Recipe 标题（用于报告） */
  async #getRecipeTitle(recipeId: string): Promise<string> {
    try {
      const entry = await this.#knowledgeRepo.findById(recipeId);
      return entry?.title ?? recipeId;
    } catch {
      return recipeId;
    }
  }

  /**
   * 发射聚合 quality 信号（仅汇总 fixed 数量；needs-review 已由 #emitSourceModifiedSignal 逐条发射）。
   * lifecycle signal 由 StateMachine 通过 Gateway 链路自动发射。
   */
  #emitSignals(report: ReactiveEvolutionReport): void {
    if (!this.#signalBus) {
      return;
    }
    try {
      if (report.fixed > 0) {
        this.#signalBus.send('quality', 'FileChangeHandler', 0.1, {
          metadata: {
            reason: 'reactive_fix',
            fixed: report.fixed,
          },
        });
      }
    } catch {
      // 信号发射失败不影响主流程
    }
  }
}

/** @deprecated Use FileChangeHandler instead */
export { FileChangeHandler as ReactiveEvolutionService };

function isEvolutionTrackableLifecycle(lifecycle: unknown): boolean {
  return typeof lifecycle === 'string' && (isConsumable(lifecycle) || isDegraded(lifecycle));
}

function isIgnoredFileChangePath(filePath: string): boolean {
  return (
    filePath === '.asd' ||
    filePath === '.git' ||
    filePath === 'node_modules' ||
    filePath.startsWith('.asd/') ||
    filePath.startsWith('.git/') ||
    filePath.startsWith('node_modules/')
  );
}

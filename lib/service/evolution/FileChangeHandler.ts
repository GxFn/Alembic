/**
 * FileChangeHandler — 文件变更驱动的 Recipe 实时进化
 *
 * 核心策略：
 *   - 能自动修复的（路径重命名）→ ContentPatcher 修复
 *   - 修不了的（文件/路径删除）→ 通过 Gateway 提交 deprecate
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

import fs from 'node:fs';
import path from 'node:path';
import Logger from '../../infrastructure/logging/Logger.js';
import type { SignalBus } from '../../infrastructure/signal/SignalBus.js';
import type KnowledgeRepositoryImpl from '../../repository/knowledge/KnowledgeRepository.impl.js';
import type { RecipeSourceRefRepositoryImpl } from '../../repository/sourceref/RecipeSourceRefRepository.js';
import type {
  FileChangeEvent,
  ImpactLevel,
  ReactiveEvolutionReport,
} from '../../types/reactive-evolution.js';
import type { FileChangeSubscriber } from '../FileChangeDispatcher.js';
import { assessFileImpact, extractRecipeTokens } from './ContentImpactAnalyzer.js';
import type { ContentPatcher } from './ContentPatcher.js';
import type { EvolutionGateway } from './EvolutionGateway.js';

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
  readonly #sourceRefRepo: RecipeSourceRefRepositoryImpl;
  readonly #knowledgeRepo: KnowledgeRepositoryImpl;
  readonly #contentPatcher: ContentPatcher;
  readonly #signalBus: SignalBus | null;
  readonly #gateway: EvolutionGateway;
  readonly #dataRoot: string;
  readonly #projectRoot: string;
  readonly #logger = Logger.getInstance();

  constructor(
    sourceRefRepo: RecipeSourceRefRepositoryImpl,
    knowledgeRepo: KnowledgeRepositoryImpl,
    contentPatcher: ContentPatcher,
    options: {
      signalBus?: SignalBus;
      evolutionGateway: EvolutionGateway;
      dataRoot?: string;
      projectRoot?: string;
    }
  ) {
    this.#sourceRefRepo = sourceRefRepo;
    this.#knowledgeRepo = knowledgeRepo;
    this.#contentPatcher = contentPatcher;
    this.#signalBus = options.signalBus ?? null;
    this.#gateway = options.evolutionGateway;
    this.#dataRoot = options.dataRoot ?? process.cwd();
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
   *   renamed  → 自动修复 sourceRef 路径
   *   deleted  → 检查是否还有其他 active ref，无则弃用
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
            type: 'update',
            targetRecipeId: ref.recipeId,
            evidence: [
              {
                suggestedChanges: JSON.stringify({
                  patchVersion: 1,
                  changes: [
                    {
                      field: 'sourceRefs',
                      action: 'replace-item',
                      oldValue: oldPath,
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

        // 全量替换 DB 文本字段 + .md 文件中的路径引用
        await this.#updateAllTextReferences(ref.recipeId, oldPath, newPath);

        const title = await this.#getRecipeTitle(ref.recipeId);
        report.fixed++;
        report.details.push({
          recipeId: ref.recipeId,
          recipeTitle: title,
          action: 'fix-rename',
          reason: `sourceRef path updated: ${oldPath} → ${newPath} (patch: ${patchResult.success ? 'ok' : 'skipped'})`,
        });
      } catch (err: unknown) {
        this.#logger.warn('[FileChangeHandler] rename fix failed', {
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
          // 所有来源都没了 → 通过 Gateway 统一处理弃用
          const reason = `All source references lost (deleted: ${deletedPath})`;

          const gatewayResult = await this.#gateway.submit({
            recipeId: ref.recipeId,
            action: 'deprecate',
            source: 'file-change',
            confidence: 0.9,
            description: reason,
            evidence: [{ deletedPath, remainingActiveRefs: 0 }],
          });

          if (gatewayResult.outcome !== 'error') {
            report.deprecated++;
            report.details.push({
              recipeId: ref.recipeId,
              recipeTitle: title,
              action: 'deprecate',
              reason,
              impactLevel: 'direct',
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

      // 非 active 的 Recipe 不进入 details（文档 §13.1 B5）
      if (entry && typeof entry.lifecycle === 'string' && entry.lifecycle !== 'active') {
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
            evidence: [{ modifiedPath, score, matchedTokens, detectedAt: Date.now() }],
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

  /**
   * 全量替换 Recipe 中所有文本引用（reasoning.sources、content.markdown、coreCode）+ .md 文件
   */
  async #updateAllTextReferences(
    recipeId: string,
    oldPath: string,
    newPath: string
  ): Promise<void> {
    try {
      const entry = await this.#knowledgeRepo.findById(recipeId);
      if (!entry) {
        return;
      }

      const updates: Record<string, unknown> = {};
      const updatedFields: string[] = [];

      // 1. reasoning.sources 数组替换
      const reasoning = entry.reasoning;
      if (reasoning) {
        const sources = [...reasoning.sources];
        const srcIdx = sources.indexOf(oldPath);
        if (srcIdx >= 0) {
          sources[srcIdx] = newPath;
          updates.reasoning = { ...reasoning.toJSON(), sources };
          updatedFields.push('reasoning.sources');
        }
      }

      // 2. content.markdown 全文替换
      const content = entry.content;
      if (content && content.markdown.includes(oldPath)) {
        const contentJson = content.toJSON();
        contentJson.markdown = content.markdown.replaceAll(oldPath, newPath);
        updates.content = contentJson;
        updatedFields.push('content.markdown');
      }

      // 3. coreCode 全文替换
      if (entry.coreCode && entry.coreCode.includes(oldPath)) {
        updates.coreCode = entry.coreCode.replaceAll(oldPath, newPath);
        updatedFields.push('coreCode');
      }

      // 写回 DB
      if (updatedFields.length > 0) {
        await this.#knowledgeRepo.update(recipeId, updates);
        this.#logger.info('[FileChangeHandler] Updated recipe text references in DB', {
          recipeId,
          fields: updatedFields,
          rename: `${oldPath} → ${newPath}`,
        });
      }

      // 4. 同步更新 .md 文件：替换所有旧路径引用
      if (entry.sourceFile) {
        const mdPath = path.resolve(this.#dataRoot, entry.sourceFile);
        if (fs.existsSync(mdPath)) {
          const mdContent = fs.readFileSync(mdPath, 'utf8');
          const mdUpdated = mdContent.replaceAll(oldPath, newPath);
          if (mdUpdated !== mdContent) {
            fs.writeFileSync(mdPath, mdUpdated, 'utf8');
            this.#logger.info('[FileChangeHandler] Updated recipe .md file', {
              recipeId,
              mdPath: entry.sourceFile,
              rename: `${oldPath} → ${newPath}`,
            });
          }
        }
      }
    } catch {
      // 文本引用更新失败不阻塞主流程
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

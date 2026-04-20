/**
 * SourceRefReconciler — Recipe 来源引用健康检查 + 自动修复
 *
 * 从 knowledge_entries.reasoning.sources 填充 recipe_source_refs 桥接表，
 * 验证路径存在性，检测 git rename，修复路径引用。
 *
 * 状态机:
 *   active  — 文件存在，路径有效
 *   renamed — 文件已移动到 new_path，等待修复
 *   stale   — 路径失效，无法自动修复
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import Logger from '../../infrastructure/logging/Logger.js';
import type { SignalBus } from '../../infrastructure/signal/SignalBus.js';
import type KnowledgeRepositoryImpl from '../../repository/knowledge/KnowledgeRepository.impl.js';
import type { RecipeSourceRefRepositoryImpl } from '../../repository/sourceref/RecipeSourceRefRepository.js';

const execFileAsync = promisify(execFile);

export interface ReconcileReport {
  /** 新插入的 sourceRef 条目 */
  inserted: number;
  /** 验证为 active 的条目 */
  active: number;
  /** 标记为 stale 的条目 */
  stale: number;
  /** 跳过的条目（24h 内已验证） */
  skipped: number;
  /** 处理的 recipe 数 */
  recipesProcessed: number;
}

export interface RepairReport {
  /** 成功检测到 rename 的条目 */
  renamed: number;
  /** 仍然 stale 的条目 */
  stillStale: number;
}

export interface ApplyReport {
  /** 成功写回 .md 的条目 */
  applied: number;
  /** 写回失败的条目 */
  failed: number;
}

/* ────────────────────── Class ────────────────────── */

/** 默认跳过 24h 内已验证的条目 */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class SourceRefReconciler {
  #projectRoot: string;
  #sourceRefRepo: RecipeSourceRefRepositoryImpl;
  #knowledgeRepo: KnowledgeRepositoryImpl;
  #signalBus: SignalBus | null;
  #logger = Logger.getInstance();
  #ttlMs: number;

  constructor(
    projectRoot: string,
    sourceRefRepo: RecipeSourceRefRepositoryImpl,
    knowledgeRepo: KnowledgeRepositoryImpl,
    options?: { ttlMs?: number; signalBus?: SignalBus }
  ) {
    this.#projectRoot = projectRoot;
    this.#sourceRefRepo = sourceRefRepo;
    this.#knowledgeRepo = knowledgeRepo;
    this.#signalBus = options?.signalBus ?? null;
    this.#ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * 从 knowledge_entries.reasoning 填充 recipe_source_refs 表。
   * 对已有条目验证路径存在性，更新 status。
   */
  async reconcile(opts?: { force?: boolean }): Promise<ReconcileReport> {
    const force = opts?.force ?? false;
    const report: ReconcileReport = {
      inserted: 0,
      active: 0,
      stale: 0,
      skipped: 0,
      recipesProcessed: 0,
    };

    // 确保表可访问
    if (!this.#sourceRefRepo.isAccessible()) {
      this.#logger.warn('SourceRefReconciler: recipe_source_refs table not accessible, skipping');
      return report;
    }

    // 获取所有有 reasoning 的知识条目
    const rows = await this.#knowledgeRepo.findAllIdAndReasoning();

    const now = Date.now();

    for (const row of rows) {
      let sources: string[] = [];
      try {
        const reasoning = JSON.parse(row.reasoning);
        sources = Array.isArray(reasoning.sources)
          ? reasoning.sources.filter(
              (s: unknown) => typeof s === 'string' && (s as string).length > 0
            )
          : [];
      } catch {
        continue;
      }

      if (sources.length === 0) {
        continue;
      }

      report.recipesProcessed++;

      for (const sourcePath of sources) {
        // 检查是否已有记录
        const existing = this.#sourceRefRepo.findOne(row.id, sourcePath);

        if (existing && !force) {
          // TTL 检查：跳过近期已验证的条目
          if (now - existing.verifiedAt < this.#ttlMs) {
            report.skipped++;
            if (existing.status === 'active') {
              report.active++;
            } else if (existing.status === 'stale') {
              report.stale++;
            }
            continue;
          }
        }

        // 验证路径存在性
        const absPath = path.resolve(this.#projectRoot, sourcePath);
        const exists = fs.existsSync(absPath);

        if (existing) {
          // 更新已有记录
          if (exists) {
            this.#sourceRefRepo.upsert({
              recipeId: row.id,
              sourcePath,
              status: 'active',
              newPath: null,
              verifiedAt: now,
            });
            report.active++;
          } else {
            this.#sourceRefRepo.upsert({
              recipeId: row.id,
              sourcePath,
              status: 'stale',
              verifiedAt: now,
            });
            report.stale++;
          }
        } else {
          // 新增记录
          const status = exists ? 'active' : 'stale';
          this.#sourceRefRepo.upsert({
            recipeId: row.id,
            sourcePath,
            status,
            verifiedAt: now,
          });
          report.inserted++;
          if (exists) {
            report.active++;
          } else {
            report.stale++;
          }
        }
      }
    }

    this.#logger.info('SourceRefReconciler: reconcile complete', {
      inserted: report.inserted,
      active: report.active,
      stale: report.stale,
      skipped: report.skipped,
      recipesProcessed: report.recipesProcessed,
    });

    // 通过 SignalBus 发射信号 — 让 Governance 子系统感知 sourceRef 健康状况
    if (this.#signalBus && report.stale > 0) {
      this.#emitStaleSignals();
    }

    return report;
  }

  /**
   * 为每个有 stale sourceRef 的 Recipe 发射 quality 信号。
   * 信号可被其他组件订阅处理。
   */
  #emitStaleSignals(): void {
    if (!this.#signalBus) {
      return;
    }
    try {
      const staleRecipes = this.#sourceRefRepo.getStaleCountsByRecipe();

      for (const row of staleRecipes) {
        const staleRatio = row.staleCount / row.totalCount;
        this.#signalBus.send('quality', 'SourceRefReconciler', staleRatio, {
          target: row.recipeId,
          metadata: {
            reason: 'source_ref_stale',
            staleCount: row.staleCount,
            totalRefs: row.totalCount,
          },
        });
      }
    } catch {
      // 信号发射失败不影响主流程
    }
  }

  /**
   * 对 stale 条目尝试 git rename 修复。
   * 使用 execFile() 安全执行 git log（防止命令注入）。
   */
  async repairRenames(): Promise<RepairReport> {
    const report: RepairReport = { renamed: 0, stillStale: 0 };

    // 获取所有 stale 条目
    const staleRows = this.#sourceRefRepo.findStale();

    if (staleRows.length === 0) {
      return report;
    }

    // 获取 git rename 映射
    const renameMap = await this.#getGitRenameMap();

    const now = Date.now();
    for (const row of staleRows) {
      const newPath = renameMap.get(row.sourcePath);
      if (newPath) {
        // 验证 newPath 存在
        const absNewPath = path.resolve(this.#projectRoot, newPath);
        if (fs.existsSync(absNewPath)) {
          this.#sourceRefRepo.upsert({
            recipeId: row.recipeId,
            sourcePath: row.sourcePath,
            status: 'renamed',
            newPath,
            verifiedAt: now,
          });
          report.renamed++;
          continue;
        }
      }
      report.stillStale++;
    }

    if (report.renamed > 0) {
      this.#logger.info('SourceRefReconciler: rename repair complete', {
        renamed: report.renamed,
        stillStale: report.stillStale,
      });

      // 修复成功 → 发射正向 quality 信号（value≈0 表示健康方向）
      if (this.#signalBus) {
        this.#signalBus.send('quality', 'SourceRefReconciler', 0.1, {
          metadata: {
            reason: 'source_ref_repaired',
            renamed: report.renamed,
            stillStale: report.stillStale,
          },
        });
      }
    }

    return report;
  }

  /**
   * 将 renamed 条目的 new_path 写回 Recipe .md 文件和 DB。
   * 同时更新 _reasoning.sources 和 _content.markdown 中的路径引用。
   * 完成后 status → active。
   */
  async applyRepairs(): Promise<ApplyReport> {
    const report: ApplyReport = { applied: 0, failed: 0 };

    const renamedRows = this.#sourceRefRepo.findRenamed();

    if (renamedRows.length === 0) {
      return report;
    }

    // 按 recipeId 分组
    const byRecipe = new Map<string, Array<{ sourcePath: string; newPath: string }>>();
    for (const row of renamedRows) {
      if (!byRecipe.has(row.recipeId)) {
        byRecipe.set(row.recipeId, []);
      }
      byRecipe.get(row.recipeId)?.push({ sourcePath: row.sourcePath, newPath: row.newPath! });
    }

    // 获取 recipe 的 sourceFile 以定位 .md 文件
    const now = Date.now();
    for (const [recipeId, renames] of byRecipe) {
      try {
        const entry = await this.#knowledgeRepo.findSourceFileAndReasoning(recipeId);

        if (!entry?.sourceFile || !entry.reasoning) {
          report.failed += renames.length;
          continue;
        }

        const mdPath = path.resolve(this.#projectRoot, entry.sourceFile);
        if (!fs.existsSync(mdPath)) {
          report.failed += renames.length;
          continue;
        }

        // 读取 .md 文件
        let mdContent = fs.readFileSync(mdPath, 'utf8');
        let reasoning: Record<string, unknown>;
        try {
          reasoning = JSON.parse(entry.reasoning);
        } catch {
          report.failed += renames.length;
          continue;
        }

        const sources = Array.isArray(reasoning.sources) ? [...reasoning.sources] : [];
        let modified = false;

        for (const rename of renames) {
          const idx = sources.indexOf(rename.sourcePath);
          if (idx >= 0) {
            sources[idx] = rename.newPath;
            modified = true;
          }
          // 替换 .md 文件中所有旧路径引用（_reasoning、_content、正文）
          mdContent = mdContent.replaceAll(rename.sourcePath, rename.newPath);
        }

        if (modified) {
          reasoning.sources = sources;
          const updatedReasoning = JSON.stringify(reasoning);

          // 写回 .md 文件
          fs.writeFileSync(mdPath, mdContent, 'utf8');

          // 更新 DB reasoning 列
          await this.#knowledgeRepo.updateReasoning(recipeId, updatedReasoning, now);

          // 更新 DB content.markdown 和 coreCode 中的路径引用
          const fullEntry = await this.#knowledgeRepo.findById(recipeId);
          if (fullEntry) {
            const updates: Record<string, unknown> = {};
            const content = fullEntry.content;
            let updatedMarkdown = content?.markdown ?? '';
            let updatedCoreCode = fullEntry.coreCode ?? '';
            let contentModified = false;

            for (const rename of renames) {
              if (updatedMarkdown.includes(rename.sourcePath)) {
                updatedMarkdown = updatedMarkdown.replaceAll(rename.sourcePath, rename.newPath);
                contentModified = true;
              }
              if (updatedCoreCode.includes(rename.sourcePath)) {
                updatedCoreCode = updatedCoreCode.replaceAll(rename.sourcePath, rename.newPath);
                updates.coreCode = updatedCoreCode;
              }
            }
            if (contentModified && content) {
              const contentJson = content.toJSON();
              contentJson.markdown = updatedMarkdown;
              updates.content = contentJson;
            }
            if (Object.keys(updates).length > 0) {
              await this.#knowledgeRepo.update(recipeId, updates);
            }
          }

          // 更新 recipe_source_refs 状态
          for (const rename of renames) {
            this.#sourceRefRepo.replaceSourcePath(recipeId, rename.sourcePath, rename.newPath, now);
          }

          this.#logger.info('SourceRefReconciler: repaired recipe file', {
            recipeId,
            renames: renames.map((r) => `${r.sourcePath} → ${r.newPath}`),
          });

          report.applied += renames.length;
        } else {
          report.failed += renames.length;
        }
      } catch (err: unknown) {
        this.#logger.warn('SourceRefReconciler: applyRepairs failed for recipe', {
          recipeId,
          error: (err as Error).message,
        });
        report.failed += renames.length;
      }
    }

    if (report.applied > 0) {
      this.#logger.info('SourceRefReconciler: applyRepairs complete', report);
    }

    return report;
  }

  /* ═══ Private helpers ═══════════════════════════════ */

  /**
   * 通过 git log 获取 rename 映射（旧路径 → 新路径）
   * 使用 execFile 防止命令注入
   */
  async #getGitRenameMap(): Promise<Map<string, string>> {
    const renameMap = new Map<string, string>();

    try {
      const { stdout } = await execFileAsync(
        'git',
        ['log', '--diff-filter=R', '--name-status', '--pretty=format:', '-n', '200'],
        {
          cwd: this.#projectRoot,
          timeout: 10000,
          maxBuffer: 1024 * 1024,
        }
      );

      // 解析 git log 输出: R100\told_path\tnew_path
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('R')) {
          continue;
        }
        const parts = trimmed.split('\t');
        if (parts.length >= 3) {
          const oldPath = parts[1];
          const newPath = parts[2];
          if (oldPath && newPath) {
            renameMap.set(oldPath, newPath);
          }
        }
      }
    } catch {
      // git 不可用或不在 git 仓库中 — 跳过 rename 检测
      this.#logger.debug('SourceRefReconciler: git rename detection unavailable');
    }

    return renameMap;
  }
}

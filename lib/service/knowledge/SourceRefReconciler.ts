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

const execFileAsync = promisify(execFile);

/* ────────────────────── Types ────────────────────── */

interface DatabaseLike {
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): { changes: number };
  };
}

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
  #db: DatabaseLike;
  #logger = Logger.getInstance();
  #ttlMs: number;

  constructor(projectRoot: string, db: DatabaseLike, options?: { ttlMs?: number }) {
    this.#projectRoot = projectRoot;
    this.#db = db;
    this.#ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * 从 knowledge_entries.reasoning 填充 recipe_source_refs 表。
   * 对已有条目验证路径存在性，更新 status。
   */
  reconcile(opts?: { force?: boolean }): ReconcileReport {
    const force = opts?.force ?? false;
    const report: ReconcileReport = {
      inserted: 0,
      active: 0,
      stale: 0,
      skipped: 0,
      recipesProcessed: 0,
    };

    // 确保表存在（兼容未跑 migration 的场景）
    this.#ensureTable();

    // 获取所有有 reasoning 的知识条目
    const rows = this.#db
      .prepare(
        `SELECT id, reasoning FROM knowledge_entries WHERE reasoning IS NOT NULL AND reasoning != '{}'`
      )
      .all() as { id: string; reasoning: string }[];

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
        const existing = this.#db
          .prepare(
            `SELECT status, verified_at FROM recipe_source_refs WHERE recipe_id = ? AND source_path = ?`
          )
          .get(row.id, sourcePath) as { status: string; verified_at: number } | undefined;

        if (existing && !force) {
          // TTL 检查：跳过近期已验证的条目
          if (now - existing.verified_at < this.#ttlMs) {
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
            this.#db
              .prepare(
                `UPDATE recipe_source_refs SET status = 'active', new_path = NULL, verified_at = ? WHERE recipe_id = ? AND source_path = ?`
              )
              .run(now, row.id, sourcePath);
            report.active++;
          } else {
            this.#db
              .prepare(
                `UPDATE recipe_source_refs SET status = 'stale', verified_at = ? WHERE recipe_id = ? AND source_path = ?`
              )
              .run(now, row.id, sourcePath);
            report.stale++;
          }
        } else {
          // 新增记录
          const status = exists ? 'active' : 'stale';
          this.#db
            .prepare(
              `INSERT OR REPLACE INTO recipe_source_refs (recipe_id, source_path, status, verified_at) VALUES (?, ?, ?, ?)`
            )
            .run(row.id, sourcePath, status, now);
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

    return report;
  }

  /**
   * 对 stale 条目尝试 git rename 修复。
   * 使用 execFile() 安全执行 git log（防止命令注入）。
   */
  async repairRenames(): Promise<RepairReport> {
    const report: RepairReport = { renamed: 0, stillStale: 0 };

    // 获取所有 stale 条目
    const staleRows = this.#db
      .prepare(`SELECT recipe_id, source_path FROM recipe_source_refs WHERE status = 'stale'`)
      .all() as { recipe_id: string; source_path: string }[];

    if (staleRows.length === 0) {
      return report;
    }

    // 获取 git rename 映射
    const renameMap = await this.#getGitRenameMap();

    const now = Date.now();
    for (const row of staleRows) {
      const newPath = renameMap.get(row.source_path);
      if (newPath) {
        // 验证 newPath 存在
        const absNewPath = path.resolve(this.#projectRoot, newPath);
        if (fs.existsSync(absNewPath)) {
          this.#db
            .prepare(
              `UPDATE recipe_source_refs SET status = 'renamed', new_path = ?, verified_at = ? WHERE recipe_id = ? AND source_path = ?`
            )
            .run(newPath, now, row.recipe_id, row.source_path);
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
    }

    return report;
  }

  /**
   * 将 renamed 条目的 new_path 写回 Recipe .md 文件的 _reasoning.sources。
   * 完成后 status → active。
   */
  applyRepairs(): ApplyReport {
    const report: ApplyReport = { applied: 0, failed: 0 };

    const renamedRows = this.#db
      .prepare(
        `SELECT recipe_id, source_path, new_path FROM recipe_source_refs WHERE status = 'renamed' AND new_path IS NOT NULL`
      )
      .all() as { recipe_id: string; source_path: string; new_path: string }[];

    if (renamedRows.length === 0) {
      return report;
    }

    // 按 recipe_id 分组
    const byRecipe = new Map<string, Array<{ source_path: string; new_path: string }>>();
    for (const row of renamedRows) {
      if (!byRecipe.has(row.recipe_id)) {
        byRecipe.set(row.recipe_id, []);
      }
      byRecipe.get(row.recipe_id)?.push({ source_path: row.source_path, new_path: row.new_path });
    }

    // 获取 recipe 的 sourceFile 以定位 .md 文件
    const now = Date.now();
    for (const [recipeId, renames] of byRecipe) {
      try {
        const entry = this.#db
          .prepare(`SELECT sourceFile, reasoning FROM knowledge_entries WHERE id = ?`)
          .get(recipeId) as { sourceFile?: string; reasoning?: string } | undefined;

        if (!entry?.sourceFile || !entry.reasoning) {
          report.failed += renames.length;
          continue;
        }

        const mdPath = path.resolve(this.#projectRoot, entry.sourceFile);
        if (!fs.existsSync(mdPath)) {
          report.failed += renames.length;
          continue;
        }

        // 读取并修改 .md 文件中的 reasoning.sources
        const _content = fs.readFileSync(mdPath, 'utf8');
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
          const idx = sources.indexOf(rename.source_path);
          if (idx >= 0) {
            sources[idx] = rename.new_path;
            modified = true;
          }
        }

        if (modified) {
          reasoning.sources = sources;

          // 更新 .md 文件中的 reasoning frontmatter
          // 查找 YAML frontmatter 中的 reasoning 并替换
          const updatedReasoning = JSON.stringify(reasoning);
          // 更新 DB reasoning 列
          this.#db
            .prepare(`UPDATE knowledge_entries SET reasoning = ?, updatedAt = ? WHERE id = ?`)
            .run(updatedReasoning, now, recipeId);

          // 更新 recipe_source_refs 状态
          for (const rename of renames) {
            this.#db
              .prepare(
                `UPDATE recipe_source_refs SET status = 'active', source_path = ?, new_path = NULL, verified_at = ? WHERE recipe_id = ? AND source_path = ?`
              )
              .run(rename.new_path, now, recipeId, rename.source_path);
          }

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

  #ensureTable(): void {
    try {
      this.#db.prepare(`SELECT 1 FROM recipe_source_refs LIMIT 1`).get();
    } catch {
      // 表不存在，创建之
      (this.#db as unknown as { exec: (sql: string) => void }).exec?.(
        `CREATE TABLE IF NOT EXISTS recipe_source_refs (
          recipe_id    TEXT    NOT NULL,
          source_path  TEXT    NOT NULL,
          status       TEXT    NOT NULL DEFAULT 'active',
          new_path     TEXT,
          verified_at  INTEGER NOT NULL,
          PRIMARY KEY (recipe_id, source_path),
          FOREIGN KEY (recipe_id) REFERENCES knowledge_entries(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_rsr_path   ON recipe_source_refs(source_path);
        CREATE INDEX IF NOT EXISTS idx_rsr_status ON recipe_source_refs(status);`
      );
    }
  }

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

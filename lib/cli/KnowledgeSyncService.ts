/**
 * KnowledgeSyncService — 将 .md 文件增量同步到 SQLite DB（knowledge_entries 表）
 *
 * 统一替代 SyncService (Recipe) + CandidateSyncService。
 *
 * 设计原则：
 *  - .md 文件 = 完整唯一数据源（Source of Truth），DB = 索引缓存
 *  - 通过 contentHash 检测手写/手改 .md → 进入违规统计（audit_logs）
 *  - 孤儿 Entry（DB 有但 .md 不存在）→ 自动标记 deprecated
 *  - 同时扫描 AutoSnippet/candidates/ 和 AutoSnippet/recipes/ 两个目录
 *
 * 使用方式：
 *  - CLI: `asd sync` 委托调用
 *  - 内部: SetupService.stepDatabase() 委托调用（skipViolations = true）
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CANDIDATES_DIR, RECIPES_DIR } from '../infrastructure/config/Defaults.js';
import Logger from '../infrastructure/logging/Logger.js';
import {
  computeKnowledgeHash,
  parseKnowledgeMarkdown,
} from '../service/knowledge/KnowledgeFileWriter.js';
import type {
  ApplyReport,
  ReconcileReport,
  RepairReport,
} from '../service/knowledge/SourceRefReconciler.js';
import { SourceRefReconciler } from '../service/knowledge/SourceRefReconciler.js';

export interface SyncAllReport {
  synced: number;
  created: number;
  updated: number;
  violations: string[];
  orphaned: string[];
  skipped: number;
  reconcileReport?: ReconcileReport;
  repairReport?: RepairReport;
  applyReport?: ApplyReport;
}

export class KnowledgeSyncService {
  candidatesDir: string;
  logger: ReturnType<typeof Logger.getInstance>;
  projectRoot: string;
  recipesDir: string;
  #sourceRefReconciler: SourceRefReconciler | null;

  constructor(projectRoot: string, options?: { sourceRefReconciler?: SourceRefReconciler }) {
    this.projectRoot = projectRoot;
    this.recipesDir = path.join(projectRoot, RECIPES_DIR);
    this.candidatesDir = path.join(projectRoot, CANDIDATES_DIR);
    this.logger = Logger.getInstance();
    this.#sourceRefReconciler = options?.sourceRefReconciler ?? null;
  }

  /**
   * 完整同步入口 — sync + reconcile + repair
   *
   * asd sync CLI 和 asd ui 启动都调用此方法。
   *
   * @param db better-sqlite3 原始句柄
   * @param opts 同步选项
   * @returns 包含 sync + reconcile + repair 报告的综合结果
   */
  async syncAll(
    db: Parameters<KnowledgeSyncService['sync']>[0],
    opts: { dryRun?: boolean; force?: boolean; skipViolations?: boolean } = {}
  ): Promise<SyncAllReport> {
    // 1. .md → DB 同步
    const syncReport = this.sync(db, opts);

    const report: SyncAllReport = { ...syncReport };

    // 2. 填充/验证 recipe_source_refs 桥接表
    try {
      const reconciler =
        this.#sourceRefReconciler ??
        new SourceRefReconciler(
          this.projectRoot,
          db as unknown as ConstructorParameters<typeof SourceRefReconciler>[1]
        );
      report.reconcileReport = reconciler.reconcile({ force: opts.force });

      // 3. git rename 修复
      report.repairReport = await reconciler.repairRenames();

      // 4. 写回修复
      if (report.repairReport.renamed > 0) {
        report.applyReport = reconciler.applyRepairs();
      }
    } catch (err: unknown) {
      this.logger.warn('KnowledgeSyncService: sourceRef reconcile failed (non-blocking)', {
        error: (err as Error).message,
      });
    }

    return report;
  }

  /**
   * 执行增量同步：.md → DB（knowledge_entries 表）
   *
   * 同时扫描 candidates/ 和 recipes/ 两个目录。
   *
   * @param db better-sqlite3 原始句柄
   * @param [opts.dryRun=false] 只报告不写入
   * @param [opts.force=false] 忽略 hash，强制覆盖
   * @param [opts.skipViolations=false] 跳过违规记录（setup 场景）
   * @returns }
   */
  sync(
    db: {
      prepare: (sql: string) => {
        run: (...args: unknown[]) => void;
        get: (...args: unknown[]) => unknown;
        all: () => Array<Record<string, unknown>>;
      };
    },
    opts: { dryRun?: boolean; force?: boolean; skipViolations?: boolean } = {}
  ) {
    const { dryRun = false, force = false, skipViolations = false } = opts;

    const report = {
      synced: 0,
      created: 0,
      updated: 0,
      violations: [] as string[], // 手动编辑的文件列表
      orphaned: [] as string[], // DB 有但 .md 不存在
      skipped: 0,
    };

    // ── 1. 收集 .md 文件（两个目录） ──
    const mdFiles = [
      ...this._collectMdFiles(this.candidatesDir, CANDIDATES_DIR),
      ...this._collectMdFiles(this.recipesDir, RECIPES_DIR),
    ];

    if (mdFiles.length === 0) {
      this.logger.info('KnowledgeSyncService: no .md files found');
      return report;
    }

    // ── 2. 准备 upsert 语句 ──
    const upsertStmt = dryRun ? null : this._prepareUpsert(db);
    const auditStmt = dryRun || skipViolations ? null : this._prepareAuditInsert(db);

    // ── 3. 逐文件同步 ──
    const syncedIds = new Set<string>();

    for (const { absPath, relPath } of mdFiles) {
      try {
        const content = fs.readFileSync(absPath, 'utf8');
        const parsed = parseKnowledgeMarkdown(content, relPath) as Record<string, unknown>;

        if (!parsed.id) {
          this.logger.warn(`KnowledgeSyncService: skip file without id — ${relPath}`);
          report.skipped++;
          continue;
        }

        syncedIds.add(parsed.id as string);

        // ── 检测手动编辑 ──
        const actualHash = computeKnowledgeHash(content);
        const storedHash = parsed.contentHash;
        const isManualEdit = storedHash && storedHash !== actualHash && !force;

        if (isManualEdit) {
          report.violations.push(relPath);
          if (auditStmt) {
            this._logViolation(
              auditStmt,
              parsed.id as string,
              relPath,
              storedHash as string,
              actualHash
            );
          }
        }

        // ── upsert ──
        if (!dryRun) {
          const existed = this._entryExists(db, parsed.id as string);
          const row = this._buildDbRow(parsed, relPath, content);
          upsertStmt?.run(...Object.values(row));

          if (existed) {
            report.updated++;
          } else {
            report.created++;
          }
        }

        report.synced++;
      } catch (err: unknown) {
        this.logger.error(`KnowledgeSyncService: failed to sync ${relPath}`, {
          error: (err as Error).message,
        });
        report.skipped++;
      }
    }

    // ── 4. 检测孤儿 ──
    report.orphaned = this._detectOrphans(db, syncedIds, dryRun);

    this.logger.info('KnowledgeSyncService: sync complete', {
      synced: report.synced,
      created: report.created,
      updated: report.updated,
      violations: report.violations.length,
      orphaned: report.orphaned.length,
      skipped: report.skipped,
    });

    return report;
  }

  /* ═══ 文件收集 ═══════════════════════════════════════════ */

  /**
   * 递归收集指定目录下所有 .md 文件（跳过 _ 前缀模板）
   * @param dir 绝对目录路径
   * @param prefix 相对路径前缀 (e.g. 'AutoSnippet/candidates')
   * @returns []}
   */
  _collectMdFiles(dir: string, prefix: string) {
    if (!fs.existsSync(dir)) {
      return [];
    }

    const results: { absPath: string; relPath: string }[] = [];
    const walk = (curDir: string, base: string) => {
      for (const entry of fs.readdirSync(curDir, { withFileTypes: true })) {
        const full = path.join(curDir, entry.name);
        const rel = base ? `${base}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          walk(full, rel);
        } else if (entry.name.endsWith('.md') && !entry.name.startsWith('_')) {
          results.push({
            absPath: full,
            relPath: `${prefix}/${rel}`,
          });
        }
      }
    };
    walk(dir, '');
    return results;
  }

  /* ═══ DB 操作 ═══════════════════════════════════════════ */

  /**
   * 从 parseKnowledgeMarkdown 的结果构建 DB row
   * wire format → DB 列映射（与 KnowledgeRepository.impl 对齐）
   */
  _buildDbRow(parsed: Record<string, unknown>, relPath: string, rawContent: string) {
    const now = Math.floor(Date.now() / 1000);

    // 内容 hash
    const contentHash = computeKnowledgeHash(rawContent);

    return {
      id: parsed.id,
      title: parsed.title || '',
      trigger: parsed.trigger || '',
      description: parsed.description || '',
      lifecycle: parsed.lifecycle || 'pending',
      lifecycleHistory: JSON.stringify(parsed.lifecycleHistory || []),
      autoApprovable: parsed.autoApprovable ? 1 : 0,
      language: parsed.language || 'unknown',
      category: parsed.category || 'general',
      kind: parsed.kind || 'pattern',
      knowledgeType: parsed.knowledgeType || 'code-pattern',
      complexity: parsed.complexity || 'intermediate',
      scope: parsed.scope || 'universal',
      difficulty: parsed.difficulty || null,
      tags: JSON.stringify(parsed.tags || []),
      content: JSON.stringify(parsed.content || {}),
      relations: JSON.stringify(parsed.relations || {}),
      constraints: JSON.stringify(parsed.constraints || {}),
      reasoning: JSON.stringify(parsed.reasoning || {}),
      quality: JSON.stringify(parsed.quality || {}),
      stats: JSON.stringify(parsed.stats || {}),
      headers: JSON.stringify(parsed.headers || []),
      headerPaths: JSON.stringify(parsed.headerPaths || []),
      moduleName: parsed.moduleName || '',
      includeHeaders: parsed.includeHeaders ? 1 : 0,
      topicHint: parsed.topicHint || null,
      whenClause: parsed.whenClause || null,
      doClause: parsed.doClause || null,
      dontClause: parsed.dontClause || null,
      coreCode: parsed.coreCode || null,
      agentNotes: parsed.agentNotes ? JSON.stringify(parsed.agentNotes) : null,
      aiInsight: parsed.aiInsight || null,
      reviewedBy: parsed.reviewedBy || null,
      reviewedAt: parsed.reviewedAt || null,
      rejectionReason: parsed.rejectionReason || null,
      source: parsed.source || 'file-sync',
      sourceFile: relPath,
      sourceCandidateId: parsed.sourceCandidateId || null,
      createdBy: parsed.createdBy || 'file-sync',
      createdAt: parsed.createdAt || now,
      updatedAt: parsed.updatedAt || now,
      publishedAt: parsed.publishedAt || null,
      publishedBy: parsed.publishedBy || null,
      contentHash: contentHash,
    };
  }

  /** 准备 upsert 语句（INSERT ... ON CONFLICT DO UPDATE 全字段） */
  _prepareUpsert(db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } }) {
    const cols = [
      'id',
      'title',
      'trigger',
      'description',
      'lifecycle',
      'lifecycleHistory',
      'autoApprovable',
      'language',
      'category',
      'kind',
      'knowledgeType',
      'complexity',
      'scope',
      'difficulty',
      'tags',
      'content',
      'relations',
      'constraints',
      'reasoning',
      'quality',
      'stats',
      'headers',
      'headerPaths',
      'moduleName',
      'includeHeaders',
      'topicHint',
      'whenClause',
      'doClause',
      'dontClause',
      'coreCode',
      'agentNotes',
      'aiInsight',
      'reviewedBy',
      'reviewedAt',
      'rejectionReason',
      'source',
      'sourceFile',
      'sourceCandidateId',
      'createdBy',
      'createdAt',
      'updatedAt',
      'publishedAt',
      'publishedBy',
      'contentHash',
    ];

    // ON CONFLICT 更新除 id, createdBy, createdAt 以外的所有列
    const updateCols = cols.filter((c) => !['id', 'createdBy', 'createdAt'].includes(c));
    const setClauses = updateCols.map((c) => `${c} = excluded.${c}`).join(',\n      ');

    const sql = `
      INSERT INTO knowledge_entries (${cols.join(', ')})
      VALUES (${cols.map(() => '?').join(', ')})
      ON CONFLICT(id) DO UPDATE SET
      ${setClauses}
    `;

    return db.prepare(sql);
  }

  /** 检查 entry 是否已存在于 DB */
  _entryExists(
    db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } },
    id: string
  ) {
    const row = db.prepare('SELECT 1 FROM knowledge_entries WHERE id = ?').get(id);
    return !!row;
  }

  /* ═══ 违规记录 ═══════════════════════════════════════════ */

  _prepareAuditInsert(db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } }) {
    try {
      return db.prepare(`
        INSERT INTO audit_logs (id, timestamp, actor, actor_context, action, resource, operation_data, result, error_message, duration)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    } catch {
      return null;
    }
  }

  _logViolation(
    stmt: { run: (...args: unknown[]) => void },
    entryId: string,
    filePath: string,
    expectedHash: string,
    actualHash: string
  ) {
    try {
      stmt.run(
        randomUUID(),
        Math.floor(Date.now() / 1000),
        'sync',
        JSON.stringify({ source: 'cli' }),
        'manual_knowledge_edit',
        entryId,
        JSON.stringify({ file: filePath, expectedHash, actualHash }),
        'violation_detected',
        null,
        0
      );
    } catch (err: unknown) {
      this.logger.warn('KnowledgeSyncService: failed to log violation', {
        entryId,
        error: (err as Error).message,
      });
    }
  }

  /* ═══ 孤儿检测 ═══════════════════════════════════════════ */

  /**
   * 检测 DB 中存在但 .md 已删除的 Entry → 标记 deprecated
   * @returns 孤儿 entry id 列表
   */
  _detectOrphans(
    db: {
      prepare: (sql: string) => {
        run: (...args: unknown[]) => void;
        all: () => Array<Record<string, unknown>>;
      };
    },
    syncedIds: Set<string>,
    dryRun: boolean
  ) {
    const orphanIds: string[] = [];
    try {
      const rows = db
        .prepare(
          `SELECT id, sourceFile FROM knowledge_entries 
         WHERE lifecycle NOT IN ('deprecated') 
         AND sourceFile IS NOT NULL`
        )
        .all();

      for (const row of rows) {
        if (!syncedIds.has(row.id as string)) {
          orphanIds.push(row.id as string);
          if (!dryRun) {
            const now = Math.floor(Date.now() / 1000);
            db.prepare(
              `UPDATE knowledge_entries 
               SET lifecycle = 'deprecated', 
                   rejectionReason = ?, 
                   updatedAt = ?
               WHERE id = ?`
            ).run('源文件已删除（孤儿条目）', now, row.id);
          }
        }
      }
    } catch (err: unknown) {
      this.logger.warn('KnowledgeSyncService: orphan detection failed', {
        error: (err as Error).message,
      });
    }
    return orphanIds;
  }
}

export default KnowledgeSyncService;

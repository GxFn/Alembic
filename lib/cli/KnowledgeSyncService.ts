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

export class KnowledgeSyncService {
  candidatesDir: any;
  logger: any;
  projectRoot: any;
  recipesDir: any;
  /**
   * @param {string} projectRoot
   */
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.recipesDir = path.join(projectRoot, RECIPES_DIR);
    this.candidatesDir = path.join(projectRoot, CANDIDATES_DIR);
    this.logger = Logger.getInstance();
  }

  /**
   * 执行增量同步：.md → DB（knowledge_entries 表）
   *
   * 同时扫描 candidates/ 和 recipes/ 两个目录。
   *
   * @param {import('better-sqlite3').Database} db  better-sqlite3 原始句柄
   * @param {Object}  [opts={}]
   * @param {boolean} [opts.dryRun=false]        只报告不写入
   * @param {boolean} [opts.force=false]         忽略 hash，强制覆盖
   * @param {boolean} [opts.skipViolations=false] 跳过违规记录（setup 场景）
   * @returns {{ synced: number, created: number, updated: number, violations: string[], orphaned: string[], skipped: number }}
   */
  sync(db, opts: any = {}) {
    const { dryRun = false, force = false, skipViolations = false } = opts;

    const report = {
      synced: 0,
      created: 0,
      updated: 0,
      violations: [], // 手动编辑的文件列表
      orphaned: [], // DB 有但 .md 不存在
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
    const syncedIds = new Set();

    for (const { absPath, relPath } of mdFiles) {
      try {
        const content = fs.readFileSync(absPath, 'utf8');
        const parsed: any = parseKnowledgeMarkdown(content, relPath);

        if (!parsed.id) {
          this.logger.warn(`KnowledgeSyncService: skip file without id — ${relPath}`);
          report.skipped++;
          continue;
        }

        syncedIds.add(parsed.id);

        // ── 检测手动编辑 ──
        const actualHash = computeKnowledgeHash(content);
        const storedHash = parsed.contentHash;
        const isManualEdit = storedHash && storedHash !== actualHash && !force;

        if (isManualEdit) {
          report.violations.push(relPath);
          if (auditStmt) {
            this._logViolation(auditStmt, parsed.id, relPath, storedHash, actualHash);
          }
        }

        // ── upsert ──
        if (!dryRun) {
          const existed = this._entryExists(db, parsed.id);
          const row = this._buildDbRow(parsed, relPath, content);
          upsertStmt.run(...Object.values(row));

          if (existed) {
            report.updated++;
          } else {
            report.created++;
          }
        }

        report.synced++;
      } catch (err: any) {
        this.logger.error(`KnowledgeSyncService: failed to sync ${relPath}`, {
          error: err.message,
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
   * @param {string} dir    绝对目录路径
   * @param {string} prefix 相对路径前缀 (e.g. 'AutoSnippet/candidates')
   * @returns {{ absPath: string, relPath: string }[]}
   */
  _collectMdFiles(dir, prefix) {
    if (!fs.existsSync(dir)) {
      return [];
    }

    const results = [];
    const walk = (curDir, base) => {
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
  _buildDbRow(parsed, relPath, rawContent) {
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

  /**
   * 准备 upsert 语句（INSERT ... ON CONFLICT DO UPDATE 全字段）
   */
  _prepareUpsert(db) {
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

  /**
   * 检查 entry 是否已存在于 DB
   */
  _entryExists(db, id) {
    const row = db.prepare('SELECT 1 FROM knowledge_entries WHERE id = ?').get(id);
    return !!row;
  }

  /* ═══ 违规记录 ═══════════════════════════════════════════ */

  _prepareAuditInsert(db) {
    try {
      return db.prepare(`
        INSERT INTO audit_logs (id, timestamp, actor, actor_context, action, resource, operation_data, result, error_message, duration)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    } catch {
      return null;
    }
  }

  _logViolation(stmt, entryId, filePath, expectedHash, actualHash) {
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
    } catch (err: any) {
      this.logger.warn('KnowledgeSyncService: failed to log violation', {
        entryId,
        error: err.message,
      });
    }
  }

  /* ═══ 孤儿检测 ═══════════════════════════════════════════ */

  /**
   * 检测 DB 中存在但 .md 已删除的 Entry → 标记 deprecated
   * @returns {string[]} 孤儿 entry id 列表
   */
  _detectOrphans(db, syncedIds, dryRun) {
    const orphanIds = [];
    try {
      const rows = db
        .prepare(
          `SELECT id, sourceFile FROM knowledge_entries 
         WHERE lifecycle NOT IN ('deprecated') 
         AND sourceFile IS NOT NULL`
        )
        .all();

      for (const row of rows) {
        if (!syncedIds.has(row.id)) {
          orphanIds.push(row.id);
          if (!dryRun) {
            const now = Math.floor(Date.now() / 1000);
            db.prepare(
              `UPDATE knowledge_entries 
               SET lifecycle = 'deprecated', 
                   rejectionReason = ?, 
                   updatedAt = ?
               WHERE id = ?`
            ).run('source file deleted (orphan)', now, row.id);
          }
        }
      }
    } catch (err: any) {
      this.logger.warn('KnowledgeSyncService: orphan detection failed', {
        error: err.message,
      });
    }
    return orphanIds;
  }
}

export default KnowledgeSyncService;

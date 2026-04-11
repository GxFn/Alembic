/**
 * SearchRepoAdapter — SearchEngine 用的轻量级仓储适配器
 *
 * 当完整的 KnowledgeRepositoryImpl / RecipeSourceRefRepositoryImpl 不可用时
 * （例如单元测试中只传入 raw db），SearchEngine 自动使用这些适配器。
 * 放在 lib/repository/ 下，允许使用 raw SQL（lint 白名单目录）。
 */

import type { SearchDb } from '../../service/search/SearchTypes.js';

/** 解包 DatabaseConnection → raw SearchDb（若已是 raw db 则直接返回） */
export function unwrapSearchDb(db: SearchDb & { getDb?: () => SearchDb }): SearchDb {
  return typeof db.getDb === 'function' ? db.getDb() : db;
}

/**
 * 通用 db 解包：接受 raw db 或 { getDb() } wrapper，返回 raw db。
 * 可用于 SearchDb、DatabaseLike 等不同 db 类型的构造函数。
 */
export function unwrapRawDb<T>(db: T | (T & { getDb(): T })): T {
  if (
    db !== null &&
    db !== undefined &&
    typeof db === 'object' &&
    'getDb' in db &&
    typeof (db as Record<string, unknown>).getDb === 'function'
  ) {
    return ((db as Record<string, unknown>).getDb as () => T)();
  }
  return db as T;
}

/** SearchEngine 需要的 KnowledgeRepo 最小接口 */
export interface SearchKnowledgeRepo {
  findNonDeprecatedSync(): Record<string, unknown>[];
  keywordSearchSync(pattern: string, limit: number): Record<string, unknown>[];
  findByIdsDetailSync(ids: string[]): Record<string, unknown>[];
  findUpdatedSinceSync(sinceIso: string): Record<string, unknown>[];
}

/** SearchEngine 需要的 SourceRefRepo 最小接口 */
export interface SearchSourceRefRepo {
  findActiveByRecipeIds(ids: string[]): Array<{
    recipeId: string;
    sourcePath: string;
    status: string;
    newPath: string | null;
  }>;
}

/**
 * Raw-db 适配器：实现 SearchKnowledgeRepo 接口
 * 仅在 KnowledgeRepositoryImpl 不可用时降级使用。
 */
export class RawDbKnowledgeAdapter implements SearchKnowledgeRepo {
  #db: SearchDb;
  constructor(db: SearchDb) {
    this.#db = db;
  }

  findNonDeprecatedSync() {
    return this.#db
      .prepare(
        `SELECT id, title, description, language, category, knowledgeType, kind,
                content, lifecycle, tags, trigger, difficulty, quality, stats,
                updatedAt, createdAt
         FROM knowledge_entries WHERE lifecycle != 'deprecated'`
      )
      .all();
  }

  keywordSearchSync(pattern: string, limit: number) {
    return this.#db
      .prepare(
        `SELECT id, title, description, language, category, knowledgeType, kind, lifecycle as status, content, trigger, headers, moduleName, 'knowledge' as type
         FROM knowledge_entries
         WHERE lifecycle != 'deprecated' AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR trigger LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
         LIMIT ?`
      )
      .all(pattern, pattern, pattern, pattern, limit);
  }

  findByIdsDetailSync(ids: string[]) {
    if (ids.length === 0) {
      return [];
    }
    const placeholders = ids.map(() => '?').join(',');
    return this.#db
      .prepare(
        `SELECT id, content, description, trigger, headers, moduleName,
                tags, language, category, updatedAt, createdAt, quality, stats, difficulty,
                whenClause, doClause
         FROM knowledge_entries WHERE id IN (${placeholders})`
      )
      .all(...ids);
  }

  findUpdatedSinceSync(sinceIso: string) {
    return this.#db
      .prepare(
        `SELECT id, title, description, language, category, knowledgeType, kind,
                content, lifecycle, tags, trigger, difficulty, quality, stats,
                updatedAt, createdAt
         FROM knowledge_entries WHERE updatedAt > ?`
      )
      .all(sinceIso);
  }
}

/**
 * Raw-db 适配器：实现 SearchSourceRefRepo 接口
 * 仅在 RecipeSourceRefRepositoryImpl 不可用时降级使用。
 */
export class RawDbSourceRefAdapter implements SearchSourceRefRepo {
  #db: SearchDb;
  constructor(db: SearchDb) {
    this.#db = db;
  }

  findActiveByRecipeIds(ids: string[]) {
    if (ids.length === 0) {
      return [];
    }
    const placeholders = ids.map(() => '?').join(',');
    return this.#db
      .prepare(
        `SELECT recipe_id, source_path, status, new_path
         FROM recipe_source_refs
         WHERE recipe_id IN (${placeholders}) AND status != 'stale'`
      )
      .all(...ids) as unknown as Array<{
      recipeId: string;
      sourcePath: string;
      status: string;
      newPath: string | null;
    }>;
  }
}

/* ═══ Guard 适配器 ═══════════════════════════════════════════ */

/** GuardCheckEngine 需要的 KnowledgeRepo 最小接口 */
export interface GuardKnowledgeRepo {
  findGuardRulesSync(lifecycles: readonly string[]): Record<string, unknown>[];
  incrementGuardHitsSync(id: string, hits: number): void;
}

/**
 * Raw-db 适配器：实现 GuardKnowledgeRepo 接口
 * 仅在 KnowledgeRepositoryImpl 不可用时降级使用。
 */
export class RawDbGuardAdapter implements GuardKnowledgeRepo {
  #db: {
    prepare(sql: string): {
      all(...args: unknown[]): Record<string, unknown>[];
      run(...args: unknown[]): unknown;
    };
  };
  constructor(db: {
    prepare(sql: string): {
      all(...args: unknown[]): Record<string, unknown>[];
      run(...args: unknown[]): unknown;
    };
  }) {
    this.#db = db;
  }

  findGuardRulesSync(lifecycles: readonly string[]) {
    const placeholders = lifecycles.map(() => '?').join(',');
    return this.#db
      .prepare(
        `SELECT id, title, description, language, scope, constraints, lifecycle
         FROM knowledge_entries WHERE kind = 'rule' AND lifecycle IN (${placeholders})`
      )
      .all(...lifecycles);
  }

  incrementGuardHitsSync(id: string, hits: number) {
    this.#db
      .prepare(
        `UPDATE knowledge_entries
         SET stats = json_set(COALESCE(stats, '{}'), '$.guardHits', COALESCE(json_extract(stats, '$.guardHits'), 0) + ?),
             updatedAt = strftime('%s', 'now')
         WHERE id = ?`
      )
      .run(hits, id);
  }
}

/* ═══ Vector Sync 适配器 ═══════════════════════════════════ */

/** 从 raw db 查询非 deprecated 的基本条目信息（SyncCoordinator 对账用） */
export function queryNonDeprecatedEntries(db: {
  prepare(sql: string): { all(): Array<Record<string, unknown>> };
}) {
  return db
    .prepare(
      `SELECT id, title, content, kind FROM knowledge_entries WHERE lifecycle != 'deprecated'`
    )
    .all() as Array<{ id: string; title?: string; content?: string; kind?: string }>;
}

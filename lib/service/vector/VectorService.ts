/**
 * VectorService — 统一向量服务层
 *
 * 整合 IndexingPipeline、VectorStore、BatchEmbedder 等分散组件，
 * 提供统一的索引构建、查询、CRUD 同步、维护接口。
 *
 * 设计原则:
 *   1. 单一职责 — 统一管理向量生命周期（构建、更新、查询、维护）
 *   2. 事件驱动 — 知识 CRUD → EventBus → 增量同步
 *   3. 渐进增强 — 无 EmbedProvider 时 graceful degrade
 *   4. CLI-first  — `alembic embed` 与 API 同等一等公民
 *
 * @module service/vector/VectorService
 */

import type { DrizzleDB } from '../../infrastructure/database/drizzle/index.js';
import type { EventBus } from '../../infrastructure/event/EventBus.js';
import Logger from '../../infrastructure/logging/Logger.js';
import type { IndexingPipeline } from '../../infrastructure/vector/IndexingPipeline.js';
import type { VectorStore } from '../../infrastructure/vector/VectorStore.js';
import type { HybridRetriever } from '../search/HybridRetriever.js';
import type { ContextualEnricher } from './ContextualEnricher.js';
import type { SyncCoordinator } from './SyncCoordinator.js';

// ── Types ──

export interface EmbedProvider {
  embed(texts: string | string[]): Promise<number[] | number[][]>;
}

export interface VectorServiceConfig {
  vectorStore: VectorStore;
  indexingPipeline: IndexingPipeline;
  hybridRetriever: HybridRetriever | null;
  eventBus: EventBus | null;
  embedProvider: EmbedProvider | null;
  contextualEnricher: ContextualEnricher | null;
  autoSyncOnCrud: boolean;
  syncDebounceMs: number;
  drizzle?: DrizzleDB;
}

export interface BuildResult {
  scanned: number;
  chunked: number;
  enriched: number;
  embedded: number;
  upserted: number;
  skipped: number;
  errors: number;
  duration: number;
}

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
  errors: string[];
}

export interface VectorStats {
  count: number;
  dimension: number;
  indexSize: number;
  quantized: boolean;
  embedProviderAvailable: boolean;
  autoSyncEnabled: boolean;
}

export interface ProgressInfo {
  phase: string;
  detail?: string;
  [key: string]: unknown;
}

export type ProgressFn = (info: ProgressInfo) => void;

// ── Service ──

export class VectorService {
  #vectorStore: VectorStore;
  #indexingPipeline: IndexingPipeline;
  #hybridRetriever: HybridRetriever | null;
  #eventBus: EventBus | null;
  #embedProvider: EmbedProvider | null;
  #contextualEnricher: ContextualEnricher | null;
  #syncCoordinator: SyncCoordinator | null = null;
  #autoSyncOnCrud: boolean;
  #syncDebounceMs: number;
  #drizzle: DrizzleDB | null;
  #logger = Logger.getInstance();
  #initialized = false;

  // ── Embed circuit breaker ──
  #embedConsecutiveFailures = 0;
  #embedCircuitOpenUntil = 0;
  static readonly #EMBED_CIRCUIT_THRESHOLD = 3;
  static readonly #EMBED_CIRCUIT_COOLDOWN_MS = 60_000;

  constructor(config: VectorServiceConfig) {
    this.#vectorStore = config.vectorStore;
    this.#indexingPipeline = config.indexingPipeline;
    this.#hybridRetriever = config.hybridRetriever;
    this.#eventBus = config.eventBus;
    this.#embedProvider = config.embedProvider;
    this.#contextualEnricher = config.contextualEnricher;
    this.#autoSyncOnCrud = config.autoSyncOnCrud;
    this.#syncDebounceMs = config.syncDebounceMs;
    this.#drizzle = config.drizzle ?? null;
  }

  // ═══ Lifecycle ═══

  /** 初始化: 绑定 EventBus 事件监听 */
  async initialize(): Promise<void> {
    if (this.#initialized) {
      return;
    }

    // 延迟 import SyncCoordinator 避免循环依赖
    if (this.#autoSyncOnCrud && this.#eventBus && this.#embedProvider) {
      const { SyncCoordinator: SC } = await import('./SyncCoordinator.js');
      this.#syncCoordinator = new SC({
        vectorStore: this.#vectorStore,
        embedProvider: this.#embedProvider,
        contextualEnricher: this.#contextualEnricher,
        debounceMs: this.#syncDebounceMs,
        drizzle: this.#drizzle ?? undefined,
      });
      this.#syncCoordinator.bindEventBus(this.#eventBus);
      this.#logger.info('[VectorService] SyncCoordinator bound to EventBus');
    }

    this.#initialized = true;
    this.#logger.info('[VectorService] Initialized', {
      embedAvailable: !!this.#embedProvider,
      autoSync: this.#autoSyncOnCrud,
    });
  }

  // ═══ 索引管理 ═══

  /**
   * 全量构建向量索引
   * 委托给 IndexingPipeline.run()，增加 enrichment 步骤和计时
   */
  async fullBuild(
    opts: { force?: boolean; clear?: boolean; dryRun?: boolean; onProgress?: ProgressFn } = {}
  ): Promise<BuildResult> {
    const start = Date.now();

    const pipelineResult = await this.#indexingPipeline.run({
      force: opts.force ?? false,
      dryRun: opts.dryRun ?? false,
      clear: opts.clear ?? false,
      onProgress: opts.onProgress
        ? (info: { phase: string; [key: string]: unknown }) =>
            opts.onProgress!(info as ProgressInfo)
        : undefined,
    });

    return {
      scanned: pipelineResult.scanned,
      chunked: pipelineResult.chunked,
      enriched: pipelineResult.enriched ?? 0,
      embedded: pipelineResult.embedded,
      upserted: pipelineResult.upserted,
      skipped: pipelineResult.skipped,
      errors: pipelineResult.errors,
      duration: Date.now() - start,
    };
  }

  /**
   * 增量更新: 只处理指定的变更文件
   * 适用于文件系统级变更（watch 或 git diff）
   */
  async incrementalUpdate(
    changedFiles: string[],
    opts: { onProgress?: ProgressFn } = {}
  ): Promise<BuildResult> {
    const start = Date.now();

    if (changedFiles.length === 0) {
      return {
        scanned: 0,
        chunked: 0,
        enriched: 0,
        embedded: 0,
        upserted: 0,
        skipped: 0,
        errors: 0,
        duration: 0,
      };
    }

    // 用 IndexingPipeline 的 run()，但只针对变更文件
    // 目前 pipeline 不支持 file filter，使用 fullBuild 的 force 模式
    // 未来可以扩展 pipeline 支持 filter
    const pipelineResult = await this.#indexingPipeline.run({
      force: true,
      dryRun: false,
      clear: false,
      onProgress: opts.onProgress
        ? (info: { phase: string; [key: string]: unknown }) =>
            opts.onProgress!(info as ProgressInfo)
        : undefined,
    });

    return {
      scanned: pipelineResult.scanned,
      chunked: pipelineResult.chunked,
      enriched: 0,
      embedded: pipelineResult.embedded,
      upserted: pipelineResult.upserted,
      skipped: pipelineResult.skipped,
      errors: pipelineResult.errors,
      duration: Date.now() - start,
    };
  }

  /** 清空向量索引 */
  async clear(): Promise<void> {
    await this.#vectorStore.clear();
    this.#logger.info('[VectorService] Vector index cleared');
  }

  /**
   * 校验向量索引健康状态
   * - 维度一致性
   * - 孤儿向量检查 (向量有但 DB 无对应 entry)
   * - Embed Provider 可用性
   */
  async validate(): Promise<{ healthy: boolean; issues: string[] }> {
    const issues: string[] = [];

    try {
      const stats = await this.#vectorStore.getStats();
      const storeStats = stats as Record<string, unknown>;

      // 检查索引是否有数据
      if ((storeStats.count as number) === 0) {
        issues.push('Vector index is empty. Run `alembic embed` to build the index.');
      }

      // 检查维度是否已设置
      if (
        storeStats.dimension !== undefined &&
        (storeStats.dimension as number) === 0 &&
        (storeStats.count as number) > 0
      ) {
        issues.push('Vector dimension is 0 but entries exist. Index may be corrupted.');
      }

      // 检查 embed provider 可用性
      if (!this.#embedProvider) {
        issues.push('No embedding provider configured. Semantic search will not work.');
      }

      // 孤儿向量检查: 检查 entry_ 前缀的 ID 是否有未知的
      if ((storeStats.count as number) > 0) {
        try {
          const allIds = await this.#vectorStore.listIds();
          const entryIds = (allIds as string[]).filter((id) => id.startsWith('entry_'));
          if (entryIds.length > 0) {
            // 统计 entry_ 前缀的向量数量
            this.#logger.info('[VectorService] validate: found entry vectors', {
              entryVectors: entryIds.length,
              totalVectors: (allIds as string[]).length,
            });
          }
        } catch {
          // listIds 不支持时跳过孤儿检查
        }
      }
    } catch (err: unknown) {
      issues.push(
        `Failed to get vector stats: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return {
      healthy: issues.length === 0,
      issues,
    };
  }

  // ═══ 查询 ═══

  /**
   * 语义搜索
   * Embed query → vectorStore.searchVector → 返回结果
   */
  async search(
    query: string,
    opts: { topK?: number; filter?: Record<string, unknown>; minScore?: number } = {}
  ): Promise<Array<{ item: Record<string, unknown>; score: number }>> {
    if (!this.#embedProvider) {
      return [];
    }

    const { topK = 10, filter = null, minScore = 0 } = opts;

    try {
      const t0 = performance.now();
      const embedResult = await this.#embedProvider.embed(query);
      const tEmbed = performance.now();
      const queryVector = Array.isArray(embedResult[0]) ? embedResult[0] : embedResult;

      const results = await this.#vectorStore.searchVector(queryVector as number[], {
        topK,
        filter,
        minScore,
      });
      const tHnsw = performance.now();

      this.#logger.info(
        `[VectorService] search: embed=${Math.round(tEmbed - t0)}ms hnsw=${Math.round(tHnsw - tEmbed)}ms total=${Math.round(tHnsw - t0)}ms results=${results.length}`
      );

      return results;
    } catch (err: unknown) {
      this.#logger.warn('[VectorService] search failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * 混合搜索 (Dense + Sparse RRF 融合)
   * 通过 HybridRetriever 执行向量 + BM25 关键词并行检索
   *
   * Embed 失败时优雅降级: 跳过 Dense 路, 仅用 Sparse 结果进行 RRF 融合,
   * 避免因网络问题导致整个搜索返回空结果。
   */
  async hybridSearch(
    query: string,
    opts: {
      topK?: number;
      alpha?: number;
      sparseSearchFn?:
        | ((
            q: string,
            limit: number
          ) => Array<{ id: string; score?: number; [key: string]: unknown }>)
        | null;
    } = {}
  ): Promise<Array<{ id: string; score: number; [key: string]: unknown }>> {
    if (!this.#embedProvider) {
      return [];
    }
    if (!this.#hybridRetriever) {
      // 无 hybridRetriever 时降级为纯向量搜索
      const results = await this.search(query, { topK: opts.topK });
      return results.map((r) => ({
        id: ((r.item as Record<string, unknown>).id as string) || '',
        score: r.score,
        item: r.item,
      }));
    }

    const { topK = 10, alpha = 0.5, sparseSearchFn = null } = opts;

    // Embed query — circuit breaker skips embed after repeated failures
    let queryVector: number[] | null = null;
    const circuitOpen = Date.now() < this.#embedCircuitOpenUntil;
    const tEmbedStart = performance.now();
    if (circuitOpen) {
      this.#logger.debug('[VectorService] embed circuit open, skipping embed');
    } else {
      try {
        const embedResult = await this.#embedProvider.embed(query);
        queryVector = Array.isArray(embedResult[0])
          ? (embedResult[0] as number[])
          : (embedResult as number[]);
        this.#embedConsecutiveFailures = 0;
      } catch (err: unknown) {
        this.#embedConsecutiveFailures++;
        if (this.#embedConsecutiveFailures >= VectorService.#EMBED_CIRCUIT_THRESHOLD) {
          this.#embedCircuitOpenUntil = Date.now() + VectorService.#EMBED_CIRCUIT_COOLDOWN_MS;
          this.#logger.warn('[VectorService] embed circuit OPEN — skipping embed for 60s', {
            consecutiveFailures: this.#embedConsecutiveFailures,
          });
        } else {
          this.#logger.warn('[VectorService] embed failed, degrading to sparse-only', {
            error: err instanceof Error ? err.message : String(err),
            failCount: this.#embedConsecutiveFailures,
          });
        }
      }
    }
    const tEmbedEnd = performance.now();

    try {
      const fused = await this.#hybridRetriever.search(query, queryVector, {
        topK,
        alpha,
        sparseSearchFn: sparseSearchFn ?? undefined,
      });
      const tFuseEnd = performance.now();

      this.#logger.info(
        `[VectorService] hybridSearch: embed=${Math.round(tEmbedEnd - tEmbedStart)}ms fuse=${Math.round(tFuseEnd - tEmbedEnd)}ms total=${Math.round(tFuseEnd - tEmbedStart)}ms hasVector=${!!queryVector} results=${fused.length} alpha=${alpha}`
      );

      return fused.map((r: Record<string, unknown>) => ({
        id: (r.id as string) || '',
        score: (r.score as number) || 0,
        ...r,
      }));
    } catch (err: unknown) {
      this.#logger.warn('[VectorService] hybridSearch failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** 通过 ID 查找相似向量 */
  async similarById(
    id: string,
    topK = 10
  ): Promise<Array<{ item: Record<string, unknown>; score: number }>> {
    try {
      const existing = await this.#vectorStore.getById(id);
      if (!existing) {
        return [];
      }

      const vector = (existing as { vector?: number[] }).vector;
      if (!vector || vector.length === 0) {
        return [];
      }

      const results = await this.#vectorStore.searchVector(vector, { topK: topK + 1 });
      // 排除自身
      return results.filter((r) => (r.item as { id?: string }).id !== id).slice(0, topK);
    } catch (err: unknown) {
      this.#logger.warn('[VectorService] similarById failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  // ═══ 同步 ═══

  /**
   * 手动同步单个知识条目到向量索引
   * 用于 KnowledgeService CRUD 后的即时同步
   */
  async syncEntry(entry: {
    id: string;
    title: string;
    content: unknown;
    kind?: string;
  }): Promise<void> {
    if (!this.#embedProvider) {
      return;
    }

    try {
      const text = this.#extractText(entry);
      if (!text) {
        return;
      }

      const embedResult = await this.#embedProvider.embed(text);
      const vector = Array.isArray(embedResult[0]) ? embedResult[0] : embedResult;

      await this.#vectorStore.upsert({
        id: `entry_${entry.id}`,
        content: text,
        vector: vector as number[],
        metadata: {
          entryId: entry.id,
          title: entry.title,
          kind: entry.kind || 'unknown',
          source: 'crud_sync',
          updatedAt: Date.now(),
        },
      });
    } catch (err: unknown) {
      this.#logger.warn('[VectorService] syncEntry failed', {
        entryId: entry.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 从向量索引移除一个条目 */
  async removeEntry(entryId: string): Promise<void> {
    try {
      await this.#vectorStore.remove(`entry_${entryId}`);
    } catch (err: unknown) {
      this.#logger.warn('[VectorService] removeEntry failed', {
        entryId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 批量同步知识条目 */
  async batchSync(
    entries: Array<{ id: string; title: string; content: unknown; kind?: string }>
  ): Promise<SyncResult> {
    const result: SyncResult = { added: 0, updated: 0, removed: 0, errors: [] };

    if (!this.#embedProvider || entries.length === 0) {
      return result;
    }

    // 提取文本
    const textsWithIds: Array<{ id: string; text: string; entry: (typeof entries)[0] }> = [];
    for (const entry of entries) {
      const text = this.#extractText(entry);
      if (text) {
        textsWithIds.push({ id: entry.id, text, entry });
      }
    }

    if (textsWithIds.length === 0) {
      return result;
    }

    try {
      // 批量 embed
      const embedResult = await this.#embedProvider.embed(textsWithIds.map((t) => t.text));
      const vectors = Array.isArray(embedResult[0])
        ? (embedResult as number[][])
        : [embedResult as number[]];

      // 批量 upsert
      const batch = textsWithIds.map((t, i) => ({
        id: `entry_${t.id}`,
        content: t.text,
        vector: vectors[i] || [],
        metadata: {
          entryId: t.id,
          title: t.entry.title,
          kind: t.entry.kind || 'unknown',
          source: 'batch_sync',
          updatedAt: Date.now(),
        },
      }));

      await this.#vectorStore.batchUpsert(batch);
      result.added = batch.length;
    } catch (err: unknown) {
      result.errors.push(err instanceof Error ? err.message : String(err));
    }

    return result;
  }

  // ═══ 维护 ═══

  /** 获取向量索引统计信息 */
  async getStats(): Promise<VectorStats> {
    const raw = await this.#vectorStore.getStats();
    const stats = raw as Record<string, unknown>;
    return {
      count: (stats.count as number) || 0,
      dimension: (stats.dimension as number) || 0,
      indexSize: (stats.indexSize as number) || 0,
      quantized: (stats.quantized as boolean) || false,
      embedProviderAvailable: !!this.#embedProvider,
      autoSyncEnabled: this.#autoSyncOnCrud && !!this.#syncCoordinator,
    };
  }

  /**
   * 迁移维度: 清空索引并使用新的 EmbedProvider 重建
   * 用于 embedding 模型切换场景
   */
  async migrateDimension(
    newProvider: EmbedProvider,
    opts: { onProgress?: ProgressFn } = {}
  ): Promise<BuildResult> {
    this.#logger.info('[VectorService] Starting dimension migration');

    // 1. 清空现有索引
    await this.clear();
    opts.onProgress?.({ phase: 'migrate', detail: 'Old index cleared' });

    // 2. 切换 provider
    this.#embedProvider = newProvider;
    this.#indexingPipeline.setAiProvider(newProvider);
    opts.onProgress?.({ phase: 'migrate', detail: 'Provider switched' });

    // 3. 全量重建
    const result = await this.fullBuild({
      force: true,
      clear: false, // 已经清过了
      onProgress: opts.onProgress,
    });

    this.#logger.info('[VectorService] Dimension migration complete', {
      upserted: result.upserted,
      duration: result.duration,
    });

    return result;
  }

  // ═══ 生命周期 ═══

  /** 销毁: 清理 SyncCoordinator 的定时器和事件监听 */
  destroy(): void {
    if (this.#syncCoordinator) {
      this.#syncCoordinator.destroy();
      this.#syncCoordinator = null;
    }
    this.#initialized = false;
  }

  // ═══ Private ═══

  /** 从知识条目中提取可嵌入的文本 */
  #extractText(entry: { title: string; content: unknown; kind?: string }): string {
    const parts: string[] = [];

    if (entry.title) {
      parts.push(entry.title);
    }

    if (typeof entry.content === 'string') {
      parts.push(entry.content);
    } else if (entry.content && typeof entry.content === 'object') {
      // KnowledgeEntry content 可能是 { body, code, ... } 结构
      const c = entry.content as Record<string, unknown>;
      if (typeof c.body === 'string') {
        parts.push(c.body);
      }
      if (typeof c.code === 'string') {
        parts.push(c.code);
      }
      if (typeof c.description === 'string') {
        parts.push(c.description);
      }
    }

    return parts.join('\n\n');
  }
}

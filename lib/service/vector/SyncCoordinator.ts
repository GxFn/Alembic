/**
 * SyncCoordinator — 知识 CRUD → 向量索引事件驱动同步
 *
 * 监听 EventBus 的 `knowledge:changed` 事件，
 * debounce 合并后批量执行 chunk → embed → upsert/remove。
 *
 * 设计:
 *   - 2s debounce 窗口内合并多个 CRUD 事件
 *   - maxBatchSize(20) 达到时立即触发
 *   - 启动时可执行一次 DB↔Vector 对账
 *
 * @module service/vector/SyncCoordinator
 */

import type { EventBus } from '../../infrastructure/event/EventBus.js';
import Logger from '../../infrastructure/logging/Logger.js';
import type { VectorStore } from '../../infrastructure/vector/VectorStore.js';
import type { ContextualEnricher } from './ContextualEnricher.js';
import type { EmbedProvider } from './VectorService.js';

// ── Types ──

export interface SyncCoordinatorConfig {
  vectorStore: VectorStore;
  embedProvider: EmbedProvider;
  contextualEnricher: ContextualEnricher | null;
  debounceMs: number;
  maxBatchSize?: number;
}

interface PendingChange {
  type: 'upsert' | 'remove';
  entryId: string;
  title?: string;
  content?: unknown;
  kind?: string;
  timestamp: number;
}

// ── Coordinator ──

export class SyncCoordinator {
  #vectorStore: VectorStore;
  #embedProvider: EmbedProvider;
  #contextualEnricher: ContextualEnricher | null;
  #debounceMs: number;
  #maxBatchSize: number;
  #pendingChanges: Map<string, PendingChange> = new Map();
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  #processing = false;
  #logger = Logger.getInstance();
  #eventBus: EventBus | null = null;
  #boundHandler: ((data: unknown) => void) | null = null;

  constructor(config: SyncCoordinatorConfig) {
    this.#vectorStore = config.vectorStore;
    this.#embedProvider = config.embedProvider;
    this.#contextualEnricher = config.contextualEnricher;
    this.#debounceMs = config.debounceMs;
    this.#maxBatchSize = config.maxBatchSize ?? 20;
  }

  /** 绑定 EventBus，开始监听知识变更事件 */
  bindEventBus(eventBus: EventBus): void {
    this.#eventBus = eventBus;

    this.#boundHandler = (data: unknown) => {
      this.#onKnowledgeChanged(data);
    };

    eventBus.on('knowledge:changed', this.#boundHandler);
    eventBus.on('knowledge:deleted', (data: unknown) => {
      const d = data as { id?: string; entryId?: string };
      const entryId = d.entryId || d.id;
      if (entryId) {
        this.#enqueue({
          type: 'remove',
          entryId,
          timestamp: Date.now(),
        });
      }
    });

    this.#logger.info('[SyncCoordinator] Bound to EventBus');
  }

  /** 手动触发立即刷入（用于测试或 shutdown 前确保数据落盘） */
  async flush(): Promise<void> {
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
    await this.#processBatch();
  }

  /**
   * 启动对账: 比较 DB knowledge_entries 与向量索引，修复不一致
   * - 孤儿向量 (在索引中但 DB 无对应) → 删除
   * - 缺失向量 (在 DB 中但索引无对应) → 加入待同步队列
   *
   * @param db - 数据库连接 (better-sqlite3 style)
   * @returns 对账结果
   */
  async reconcile(db: {
    prepare(sql: string): {
      all(
        ...args: unknown[]
      ): Array<{ id: string; title?: string; content?: string; kind?: string }>;
    };
  }): Promise<{ orphansRemoved: number; missingSynced: number; errors: string[] }> {
    const result = { orphansRemoved: 0, missingSynced: 0, errors: [] as string[] };

    try {
      // 1. 获取向量索引中所有 ID
      const vectorIds = new Set(await this.#vectorStore.listIds());

      // 2. 获取 DB 中所有 active 知识条目 ID
      let dbEntries: Array<{ id: string; title?: string; content?: string; kind?: string }> = [];
      try {
        dbEntries = db
          .prepare(
            `SELECT id, title, content, kind FROM knowledge_entries WHERE lifecycle != 'deprecated'`
          )
          .all();
      } catch {
        // 表可能不存在
        return result;
      }

      const dbIdSet = new Set(dbEntries.map((e) => `entry_${e.id}`));

      // 3. 找孤儿向量 (在索引中但 DB 无对应的 entry_ 前缀记录)
      for (const vectorId of vectorIds) {
        if ((vectorId as string).startsWith('entry_') && !dbIdSet.has(vectorId as string)) {
          try {
            await this.#vectorStore.remove(vectorId as string);
            result.orphansRemoved++;
          } catch {
            // 删除失败不阻塞
          }
        }
      }

      // 4. 找缺失向量 (在 DB 中但索引无对应)
      for (const entry of dbEntries) {
        const expectedId = `entry_${entry.id}`;
        if (!vectorIds.has(expectedId)) {
          this.#enqueue({
            type: 'upsert',
            entryId: entry.id,
            title: entry.title,
            content: entry.content,
            kind: entry.kind,
            timestamp: Date.now(),
          });
          result.missingSynced++;
        }
      }

      // 立即处理缺失的
      if (result.missingSynced > 0) {
        await this.flush();
      }

      this.#logger.info('[SyncCoordinator] Reconciliation complete', {
        orphansRemoved: result.orphansRemoved,
        missingSynced: result.missingSynced,
      });
    } catch (err: unknown) {
      result.errors.push(err instanceof Error ? err.message : String(err));
    }

    return result;
  }

  /** 销毁: 清理定时器和事件监听 */
  destroy(): void {
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }

    if (this.#eventBus && this.#boundHandler) {
      this.#eventBus.off('knowledge:changed', this.#boundHandler);
      this.#boundHandler = null;
    }

    this.#pendingChanges.clear();
    this.#logger.info('[SyncCoordinator] Destroyed');
  }

  // ═══ Private ═══

  #onKnowledgeChanged(data: unknown): void {
    const d = data as {
      id?: string;
      entryId?: string;
      action?: string;
      entry?: { id: string; title: string; content: unknown; kind?: string };
    };

    const entryId = d.entryId || d.id || d.entry?.id;
    if (!entryId) {
      return;
    }

    if (d.action === 'delete') {
      this.#enqueue({ type: 'remove', entryId, timestamp: Date.now() });
    } else {
      this.#enqueue({
        type: 'upsert',
        entryId,
        title: d.entry?.title,
        content: d.entry?.content,
        kind: d.entry?.kind,
        timestamp: Date.now(),
      });
    }
  }

  #enqueue(change: PendingChange): void {
    // 同一 entryId 的后续操作覆盖前一个（最终一致性）
    this.#pendingChanges.set(change.entryId, change);

    // 达到批量上限时立即触发
    if (this.#pendingChanges.size >= this.#maxBatchSize) {
      if (this.#debounceTimer) {
        clearTimeout(this.#debounceTimer);
        this.#debounceTimer = null;
      }
      this.#processBatch().catch((err: unknown) => {
        this.#logger.warn('[SyncCoordinator] processBatch error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return;
    }

    // debounce
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
    }
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      this.#processBatch().catch((err: unknown) => {
        this.#logger.warn('[SyncCoordinator] processBatch error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.#debounceMs);
  }

  async #processBatch(): Promise<void> {
    if (this.#processing || this.#pendingChanges.size === 0) {
      return;
    }

    this.#processing = true;
    const batch = new Map(this.#pendingChanges);
    this.#pendingChanges.clear();

    try {
      const upserts: PendingChange[] = [];
      const removes: string[] = [];

      for (const change of batch.values()) {
        if (change.type === 'remove') {
          removes.push(change.entryId);
        } else {
          upserts.push(change);
        }
      }

      // 处理删除
      for (const entryId of removes) {
        try {
          await this.#vectorStore.remove(`entry_${entryId}`);
        } catch {
          // 删除失败不阻塞
        }
      }

      // 处理 upsert: 提取文本 → embed → upsert
      if (upserts.length > 0) {
        const validUpserts = upserts.filter((u) => u.title || u.content);

        if (validUpserts.length > 0) {
          const texts = validUpserts.map((u) => this.#extractText(u));
          try {
            const embedResult = await this.#embedProvider.embed(texts);
            const vectors = Array.isArray(embedResult[0])
              ? (embedResult as number[][])
              : [embedResult as number[]];

            const items = validUpserts.map((u, i) => ({
              id: `entry_${u.entryId}`,
              content: texts[i],
              vector: vectors[i] || [],
              metadata: {
                entryId: u.entryId,
                title: u.title || '',
                kind: u.kind || 'unknown',
                source: 'event_sync',
                updatedAt: Date.now(),
              },
            }));

            await this.#vectorStore.batchUpsert(items);
          } catch (err: unknown) {
            this.#logger.warn('[SyncCoordinator] batch embed/upsert failed', {
              count: validUpserts.length,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      this.#logger.info('[SyncCoordinator] Batch processed', {
        upserted: upserts.length,
        removed: removes.length,
      });
    } finally {
      this.#processing = false;

      // 处理期间可能有新的变更入队
      if (this.#pendingChanges.size > 0) {
        this.#enqueue(this.#pendingChanges.values().next().value!);
      }
    }
  }

  #extractText(change: PendingChange): string {
    const parts: string[] = [];
    if (change.title) {
      parts.push(change.title);
    }
    if (typeof change.content === 'string') {
      parts.push(change.content);
    } else if (change.content && typeof change.content === 'object') {
      const c = change.content as Record<string, unknown>;
      if (typeof c.body === 'string') {
        parts.push(c.body);
      }
      if (typeof c.code === 'string') {
        parts.push(c.code);
      }
    }
    return parts.join('\n\n') || change.entryId;
  }
}

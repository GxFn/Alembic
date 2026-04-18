/**
 * MemoryEmbeddingStore — 向量嵌入的 JSON sidecar 存储
 *
 * 将 Agent Memory 的向量嵌入从 SQLite BLOB 迁移到独立 JSON 文件，
 * 与 Knowledge 侧 HNSW `.asvec` 的设计理念对齐：
 * **结构化数据存 SQLite，向量存独立文件。**
 *
 * 设计:
 *   - 内存 Map<id, number[]> 缓存，启动时一次性加载
 *   - 写入时更新内存 + debounced flush 到 JSON
 *   - 崩溃丢失可通过 embedAllMemories() backfill 恢复
 *
 * 文件位置: .asd/context/memory_embeddings.json
 *
 * @module MemoryEmbeddingStore
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WriteZone } from '#infra/io/WriteZone.js';

/** debounce flush 延迟 (ms) */
const FLUSH_DELAY_MS = 2000;

export class MemoryEmbeddingStore {
  /** 内存缓存: id → embedding vector */
  #cache = new Map<string, number[]>();

  /** JSON 文件路径 */
  #filePath: string;

  /** debounce timer */
  #flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** dirty flag */
  #dirty = false;

  readonly #wz: WriteZone | null;

  /**
   * @param projectRoot 项目根目录
   * @param opts.filePath 覆盖默认文件路径 (测试用)
   * @param opts.wz WriteZone 实例 (DI 注入)
   */
  constructor(projectRoot: string, opts?: { filePath?: string; wz?: WriteZone }) {
    this.#filePath =
      opts?.filePath ?? join(projectRoot, '.asd', 'context', 'memory_embeddings.json');
    this.#wz = opts?.wz ?? null;
    this.#load();
  }

  /** 获取单条 embedding */
  get(id: string): number[] | null {
    return this.#cache.get(id) ?? null;
  }

  /** 设置单条 embedding */
  set(id: string, embedding: number[]): void {
    this.#cache.set(id, embedding);
    this.#scheduleDirtyFlush();
  }

  /** 批量设置 embeddings */
  batchSet(entries: Array<{ id: string; embedding: number[] }>): number {
    let count = 0;
    for (const { id, embedding } of entries) {
      this.#cache.set(id, embedding);
      count++;
    }
    if (count > 0) {
      this.#scheduleDirtyFlush();
    }
    return count;
  }

  /** 删除单条 embedding */
  delete(id: string): boolean {
    const existed = this.#cache.delete(id);
    if (existed) {
      this.#scheduleDirtyFlush();
    }
    return existed;
  }

  /** 检查是否有 embedding */
  has(id: string): boolean {
    return this.#cache.has(id);
  }

  /** 返回所有缺少 embedding 的 ID (给定候选 ID 列表) */
  getMissingIds(candidateIds: string[]): string[] {
    return candidateIds.filter((id) => !this.#cache.has(id));
  }

  /** 缓存大小 */
  get size(): number {
    return this.#cache.size;
  }

  /** 清除所有 embeddings (用于重建) */
  clear(): void {
    this.#cache.clear();
    this.#scheduleDirtyFlush();
  }

  /** 立即刷写到磁盘 (shutdown / 测试用) */
  flushSync(): void {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (!this.#dirty) {
      return;
    }
    this.#writeFile();
    this.#dirty = false;
  }

  /** GC: 移除不在给定 ID 集合中的 embeddings */
  gc(activeIds: Set<string>): number {
    let removed = 0;
    for (const id of this.#cache.keys()) {
      if (!activeIds.has(id)) {
        this.#cache.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      this.#scheduleDirtyFlush();
    }
    return removed;
  }

  // ═══════════════════════════════════════════════════════════
  // Private
  // ═══════════════════════════════════════════════════════════

  #load(): void {
    try {
      if (existsSync(this.#filePath)) {
        const raw = readFileSync(this.#filePath, 'utf-8');
        const data = JSON.parse(raw) as Record<string, number[]>;
        for (const [id, vec] of Object.entries(data)) {
          if (Array.isArray(vec)) {
            this.#cache.set(id, vec);
          }
        }
      }
    } catch {
      // 文件不存在或解析失败 → 空缓存，后续 backfill 会重建
    }
  }

  #writeFile(): void {
    try {
      const obj: Record<string, number[]> = {};
      for (const [id, vec] of this.#cache) {
        obj[id] = vec;
      }
      if (this.#wz) {
        this.#wz.writeFile(this.#wz.runtime('context/memory_embeddings.json'), JSON.stringify(obj));
      } else {
        const dir = dirname(this.#filePath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(this.#filePath, JSON.stringify(obj), 'utf-8');
      }
    } catch {
      // 写入失败不阻塞运行时；下次 flush 或 backfill 会重试
    }
  }

  #scheduleDirtyFlush(): void {
    this.#dirty = true;
    if (this.#flushTimer) {
      return; // 已有 pending timer
    }
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      if (this.#dirty) {
        this.#writeFile();
        this.#dirty = false;
      }
    }, FLUSH_DELAY_MS);
  }
}

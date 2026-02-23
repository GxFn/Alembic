/**
 * ToolResultCache — 跨维度工具结果缓存
 *
 * 缓存 search_project_code 和 read_project_file 的调用结果，
 * 避免后续维度重复执行已知搜索/读取操作。
 *
 * 设计:
 *   - 缓存粒度: 完整工具调用 (key = toolName + normalized args)
 *   - 失效策略: TTL 过期 + 手动清理 (默认 30 分钟)
 *   - 内存管理: 文件内容缓存上限 200 个，搜索结果上限 500 个
 *
 * 使用方式:
 *   ToolRegistry handler 内检查 ctx.toolResultCache.get(key)
 *   命中则直接返回缓存 + "[cached]" 标记
 *
 * @module ToolResultCache
 */

import Logger from '../../../../../infrastructure/logging/Logger.js';
import { CACHE } from '../../../../../shared/constants.js';

/** 最大缓存条目 */
const MAX_FILE_CACHE = CACHE.MAX_FILE_ENTRIES;
const MAX_SEARCH_CACHE = CACHE.MAX_SEARCH_ENTRIES;
/** 缓存 TTL（毫秒），超过此时间的条目视为过期 */
const DEFAULT_TTL_MS = CACHE.DEFAULT_TTL_MS;

export class ToolResultCache {
  /** @type {Map<string, {result: any, cachedAt: number, hitCount: number}>} */
  #searchCache = new Map();

  /** @type {Map<string, {content: string, cachedAt: number, hitCount: number}>} */
  #fileCache = new Map();

  /** @type {import('../../../../../infrastructure/logging/Logger.js').default} */
  #logger;

  /** @type {{hits: number, misses: number, evictions: number}} */
  #stats = { hits: 0, misses: 0, evictions: 0 };

  /** @type {number} TTL in ms */
  #ttlMs;

  /** @type {ReturnType<typeof setInterval>|null} cleanup timer */
  #cleanupTimer = null;

  /**
   * @param {object} [options]
   * @param {number} [options.ttlMs] — 缓存 TTL（毫秒），默认取 CACHE.DEFAULT_TTL_MS
   * @param {number} [options.cleanupIntervalMs] — 清理周期（毫秒），默认 5 分钟
   */
  constructor(options = {}) {
    this.#logger = Logger.getInstance();
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

    // 定期清理过期条目，避免内存膨胀
    const cleanupInterval = options.cleanupIntervalMs ?? 5 * 60 * 1000;
    if (this.#ttlMs > 0 && cleanupInterval > 0) {
      this.#cleanupTimer = setInterval(() => this.#evictExpired(), cleanupInterval);
      // 允许进程退出时不被 timer 阻塞
      if (this.#cleanupTimer.unref) {
        this.#cleanupTimer.unref();
      }
    }
  }

  // ─── 搜索结果缓存 ────────────────────────────────────

  /**
   * 缓存搜索结果
   * @param {string} pattern — 搜索模式
   * @param {*} results — 搜索结果
   */
  cacheSearch(pattern, results) {
    if (this.#searchCache.size >= MAX_SEARCH_CACHE) {
      // LRU: 移除最旧的条目
      const oldestKey = this.#searchCache.keys().next().value;
      this.#searchCache.delete(oldestKey);
    }
    this.#searchCache.set(pattern, {
      result: results,
      cachedAt: Date.now(),
      hitCount: 0,
    });
  }

  /**
   * 获取缓存的搜索结果
   * @param {string} pattern
   * @returns {*|null} — 缓存结果或 null
   */
  getCachedSearch(pattern) {
    const entry = this.#searchCache.get(pattern);
    if (entry) {
      // TTL 检查
      if (this.#ttlMs > 0 && Date.now() - entry.cachedAt > this.#ttlMs) {
        this.#searchCache.delete(pattern);
        this.#stats.evictions++;
        this.#stats.misses++;
        return null;
      }
      entry.hitCount++;
      this.#stats.hits++;
      return entry.result;
    }
    this.#stats.misses++;
    return null;
  }

  // ─── 文件内容缓存 ────────────────────────────────────

  /**
   * 缓存文件内容
   * @param {string} filePath
   * @param {string} content
   */
  cacheFile(filePath, content) {
    if (this.#fileCache.size >= MAX_FILE_CACHE) {
      const oldestKey = this.#fileCache.keys().next().value;
      this.#fileCache.delete(oldestKey);
    }
    this.#fileCache.set(filePath, {
      content,
      cachedAt: Date.now(),
      hitCount: 0,
    });
  }

  /**
   * 获取缓存的文件内容
   * @param {string} filePath
   * @returns {string|null}
   */
  getCachedFile(filePath) {
    const entry = this.#fileCache.get(filePath);
    if (entry) {
      // TTL 检查
      if (this.#ttlMs > 0 && Date.now() - entry.cachedAt > this.#ttlMs) {
        this.#fileCache.delete(filePath);
        this.#stats.evictions++;
        this.#stats.misses++;
        return null;
      }
      entry.hitCount++;
      this.#stats.hits++;
      return entry.content;
    }
    this.#stats.misses++;
    return null;
  }

  // ─── 通用缓存接口 ────────────────────────────────────

  /**
   * 检查是否有缓存 (搜索或文件)
   * @param {string} toolName
   * @param {object} args
   * @returns {*|null}
   */
  get(toolName, args) {
    if (toolName === 'search_project_code') {
      const pattern = args?.pattern || '';
      if (pattern) {
        return this.getCachedSearch(pattern);
      }
    }
    if (toolName === 'read_project_file') {
      const filePath = args?.filePath || '';
      if (filePath) {
        const cached = this.getCachedFile(filePath);
        if (cached !== null) {
          return { content: cached, path: filePath, cached: true };
        }
      }
    }
    return null;
  }

  /**
   * 写入缓存
   * @param {string} toolName
   * @param {object} args
   * @param {*} result
   */
  set(toolName, args, result) {
    if (toolName === 'search_project_code') {
      const pattern = args?.pattern || '';
      if (pattern) {
        this.cacheSearch(pattern, result);
      }
    }
    if (toolName === 'read_project_file') {
      const filePath = args?.filePath || '';
      const content = typeof result === 'object' ? result.content : String(result);
      if (filePath && content) {
        this.cacheFile(filePath, content);
      }
    }
  }

  // ─── 统计 ─────────────────────────────────────────────

  /**
   * 获取缓存统计
   * @returns {object}
   */
  getStats() {
    return {
      ...this.#stats,
      hitRate:
        this.#stats.hits + this.#stats.misses > 0
          ? `${((this.#stats.hits / (this.#stats.hits + this.#stats.misses)) * 100).toFixed(1)}%`
          : '0%',
      searchCacheSize: this.#searchCache.size,
      fileCacheSize: this.#fileCache.size,
    };
  }

  /**
   * 清空所有缓存
   */
  clear() {
    this.#searchCache.clear();
    this.#fileCache.clear();
    this.#stats = { hits: 0, misses: 0, evictions: 0 };
  }

  /**
   * 销毁缓存实例，释放定时器
   * 应在 Bootstrap 会话结束时调用
   */
  dispose() {
    this.clear();
    if (this.#cleanupTimer) {
      clearInterval(this.#cleanupTimer);
      this.#cleanupTimer = null;
    }
  }

  // ─── 内部 ─────────────────────────────────────────────

  /**
   * 清理两个 Map 中的过期条目
   * @private
   */
  #evictExpired() {
    if (this.#ttlMs <= 0) {
      return;
    }
    const now = Date.now();
    let evicted = 0;

    for (const [key, entry] of this.#searchCache) {
      if (now - entry.cachedAt > this.#ttlMs) {
        this.#searchCache.delete(key);
        evicted++;
      }
    }
    for (const [key, entry] of this.#fileCache) {
      if (now - entry.cachedAt > this.#ttlMs) {
        this.#fileCache.delete(key);
        evicted++;
      }
    }

    if (evicted > 0) {
      this.#stats.evictions += evicted;
      this.#logger.debug(`[ToolResultCache] evicted ${evicted} expired entries`);
    }
  }
}

export default ToolResultCache;

/**
 * 本地内存缓存服务
 * 提供分布式缓存支持，提升 API 响应速度
 * 生产环境建议通过 UnifiedCacheAdapter 接入 Redis
 */

import Logger from '../logging/Logger.js';

/**
 * 本地缓存实现（无 Redis 依赖）
 */
export class CacheService {
  cache: Map<string, { value: unknown; expiresAt: number }>;
  cleanupInterval: ReturnType<typeof setInterval> | null;
  constructor() {
    /** @type {Map<string, { value: unknown, expiresAt: number }>} */
    this.cache = new Map();
    this.cleanupInterval = null;

    // 每 60 秒清理一次过期缓存（unref 避免阻止进程退出）
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, 60000);
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * 获取缓存
   * @param {string} key
   * @returns {any|null}
   */
  get(key: string) {
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // 检查是否过期
    if (entry.expiresAt < Date.now()) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  /**
   * 设置缓存
   * @param {string} key
   * @param {any} value
   * @param {number} ttlSeconds 默认 300 秒
   */
  set(key: string, value: unknown, ttlSeconds = 300) {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.cache.set(key, { value, expiresAt });
  }

  /**
   * 删除缓存
   * @param {string} key
   * @returns {boolean}
   */
  delete(key: string) {
    return this.cache.delete(key);
  }

  /**
   * 清空所有缓存
   */
  clear() {
    this.cache.clear();
  }

  /**
   * 清理过期缓存
   */
  cleanupExpired() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt < now) {
        this.cache.delete(key);
      }
    }
    Logger.debug(`[Cache] Cleanup completed. Remaining entries: ${this.cache.size}`);
  }

  /**
   * 获取缓存统计信息
   */
  getStats() {
    return {
      size: this.cache.size,
      entries: Array.from(this.cache.keys()),
    };
  }

  /**
   * 关闭缓存服务
   */
  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.clear();
    Logger.info('[Cache] Service shutdown');
  }
}

/**
 * 缓存键生成器
 */
export class CacheKeyBuilder {
  static candidate(id: string) {
    return `candidate:${id}`;
  }

  static candidatesList(page: number, limit: number, status?: string) {
    const baseKey = `candidates:list:${page}:${limit}`;
    return status ? `${baseKey}:${status}` : baseKey;
  }

  static recipe(id: string) {
    return `recipe:${id}`;
  }

  static recipesList(page: number, limit: number, category?: string) {
    const baseKey = `recipes:list:${page}:${limit}`;
    return category ? `${baseKey}:${category}` : baseKey;
  }

  static rule(id: string) {
    return `rule:${id}`;
  }

  static rulesList(page: number, limit: number, status?: string) {
    const baseKey = `rules:list:${page}:${limit}`;
    return status ? `${baseKey}:${status}` : baseKey;
  }

  static health() {
    return 'health:status';
  }

  static stats() {
    return 'system:stats';
  }
}

// 导出单例实例
export const cacheService = new CacheService();

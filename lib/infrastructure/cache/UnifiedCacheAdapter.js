/**
 * 统一缓存适配器
 * 内存缓存模式
 */

import Logger from '../logging/Logger.js';
import { cacheService as memoryCacheService } from './CacheService.js';

export class UnifiedCacheAdapter {
  constructor() {
    this.mode = 'memory';
    this.memoryService = memoryCacheService;
  }

  /**
   * 初始化缓存服务
   */
  async initialize() {
    Logger.info('✅ 内存缓存已启用');
  }

  /**
   * 获取缓存值
   */
  async get(key) {
    try {
      return this.memoryService.get(key);
    } catch (error) {
      Logger.error(`缓存获取失败 (${key}):`, { error: error.message });
      return null;
    }
  }

  /**
   * 设置缓存值
   */
  async set(key, value, ttlSeconds = 300) {
    try {
      this.memoryService.set(key, value, ttlSeconds);
      return true;
    } catch (error) {
      Logger.error(`缓存设置失败 (${key}):`, { error: error.message });
      return false;
    }
  }

  /**
   * 删除缓存
   */
  async delete(key) {
    try {
      return this.memoryService.delete(key);
    } catch (error) {
      Logger.error(`缓存删除失败 (${key}):`, { error: error.message });
      return false;
    }
  }

  /**
   * 清空所有缓存
   */
  async clear() {
    try {
      this.memoryService.clear();
      return true;
    } catch (error) {
      Logger.error('缓存清空失败:', { error: error.message });
      return false;
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const stats = this.memoryService.getStats();
    return { mode: 'memory', available: true, ...stats };
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    return { healthy: true, mode: 'memory', message: '内存缓存运行正常' };
  }
}

// 单例实例
let cacheAdapterInstance = null;

/**
 * 初始化统一缓存适配器
 */
export async function initCacheAdapter() {
  if (cacheAdapterInstance) {
    Logger.warn('缓存适配器已初始化');
    return cacheAdapterInstance;
  }

  cacheAdapterInstance = new UnifiedCacheAdapter();
  await cacheAdapterInstance.initialize();
  return cacheAdapterInstance;
}

/**
 * 获取缓存适配器实例
 */
export function getCacheAdapter() {
  if (!cacheAdapterInstance) {
    throw new Error('缓存适配器未初始化，请先调用 initCacheAdapter()');
  }
  return cacheAdapterInstance;
}

export default UnifiedCacheAdapter;

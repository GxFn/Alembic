/**
 * VectorMigration — JSON → HNSW 二进制索引自动迁移
 *
 * 场景:
 * 1. 首次启动, 无任何索引 → 返回 'new'
 * 2. 存在 vector_index.json → 读取 JSON, 批量插入 HNSW, 重命名旧文件
 * 3. 存在 .asvec 二进制索引 → 返回 'binary' (已迁移)
 *
 * @module infrastructure/vector/VectorMigration
 */

import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export class VectorMigration {
  /**
   * 检测并执行自动迁移
   *
   * @param {string} indexDir - 索引目录路径
   * @param {import('./HnswVectorAdapter.js').HnswVectorAdapter} adapter - HNSW 适配器实例
   * @returns {Promise<'new'|'migrated'|'binary'>}
   */
  static async migrate(indexDir, adapter) {
    const jsonPath = join(indexDir, 'vector_index.json');
    const hnswPath = join(indexDir, 'vector_index.asvec');

    // 场景 3: 已有二进制索引 (需验证有效性)
    if (existsSync(hnswPath)) {
      // 如果 .asvec 损坏且同时存在 .json, 从 JSON 迁移
      const { BinaryPersistence } = await import('./BinaryPersistence.js');
      if (BinaryPersistence.isValid(hnswPath)) {
        return 'binary';
      }
      // .asvec 损坏, 检查是否有 JSON 可迁移
      if (!existsSync(jsonPath)) {
        return 'binary'; // 无 JSON 可回退, 保持现状
      }
      // 有 JSON, 将从 JSON 迁移 (跳过这个 if, 进入下方迁移逻辑)
    }

    // 场景 2: 存在旧 JSON 索引
    if (existsSync(jsonPath)) {
      try {
        const raw = readFileSync(jsonPath, 'utf-8');
        const items = JSON.parse(raw);
        const itemList = Array.isArray(items)
          ? items
          : Object.entries(items).map(([id, item]) => ({ ...item, id }));

        if (itemList.length > 0) {
          // 过滤有效条目并批量插入
          const validItems = itemList.filter((item) => item?.id);
          if (validItems.length > 0) {
            await adapter.batchUpsert(
              validItems.map((item) => ({
                id: item.id,
                content: item.content || '',
                vector: item.vector || [],
                metadata: item.metadata || {},
              }))
            );
          }

          // 重命名旧文件
          try {
            renameSync(jsonPath, `${jsonPath}.bak`);
          } catch {
            /* 重命名失败不影响迁移 */
          }

          return 'migrated';
        }
      } catch {
        // JSON 解析失败, 视为新安装
      }
    }

    // 场景 1: 全新安装
    return 'new';
  }

  /**
   * 检查是否需要迁移
   * @param {string} indexDir
   * @returns {boolean}
   */
  static needsMigration(indexDir) {
    const jsonPath = join(indexDir, 'vector_index.json');
    const hnswPath = join(indexDir, 'vector_index.asvec');
    return existsSync(jsonPath) && !existsSync(hnswPath);
  }
}

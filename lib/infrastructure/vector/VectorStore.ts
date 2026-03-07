/**
 * VectorStore — 向量存储抽象层
 * 定义向量存储的标准接口，支持 JSON/Milvus 等后端
 */

import { ioLimit } from '#shared/concurrency.js';

export class VectorStore {
  /**
   * 初始化存储
   * @returns {Promise<void>}
   */
  async init(): Promise<void> {
    throw new Error('Not implemented: init()');
  }

  /**
   * 插入或更新文档
   * @param {{ id: string, content: string, vector: number[], metadata: object }} item
   */
  async upsert(item: {
    id: string;
    content: string;
    vector: number[];
    metadata: Record<string, unknown>;
  }): Promise<void> {
    throw new Error('Not implemented: upsert()');
  }

  /**
   * 批量 upsert
   * @param {Array} items
   */
  async batchUpsert(
    items: Array<{
      id: string;
      content: string;
      vector: number[];
      metadata: Record<string, unknown>;
    }>
  ): Promise<void> {
    // p-limit 控制并发，避免批量 upsert 时 OOM 或 DB 锁竞争
    await Promise.all(items.map((item) => ioLimit(() => this.upsert(item))));
  }

  /**
   * 删除文档
   * @param {string} id
   */
  async remove(id: string): Promise<void> {
    throw new Error('Not implemented: remove()');
  }

  /**
   * 按 ID 获取
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async getById(id: string): Promise<Record<string, unknown> | null> {
    throw new Error('Not implemented: getById()');
  }

  /**
   * 向量相似度搜索
   * @param {number[]} queryVector
   * @param {object} options - { topK, filter, minScore }
   * @returns {Promise<Array<{ item: object, score: number }>>}
   */
  async searchVector(
    queryVector: number[],
    options: Record<string, unknown> = {}
  ): Promise<Array<{ item: Record<string, unknown>; score: number }>> {
    throw new Error('Not implemented: searchVector()');
  }

  /**
   * 按过滤条件搜索
   * @param {object} filter - { type, category, language, tags, ... }
   * @returns {Promise<Array>}
   */
  async searchByFilter(filter: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    throw new Error('Not implemented: searchByFilter()');
  }

  /**
   * 列出所有 ID
   * @returns {Promise<string[]>}
   */
  async listIds(): Promise<string[]> {
    throw new Error('Not implemented: listIds()');
  }

  /**
   * 清空存储
   */
  async clear(): Promise<void> {
    throw new Error('Not implemented: clear()');
  }

  /**
   * 获取统计信息
   * @returns {Promise<{ count: number, indexSize: number }>}
   */
  async getStats(): Promise<{ count: number; indexSize: number }> {
    throw new Error('Not implemented: getStats()');
  }

  /**
   * 销毁: 释放资源, 清理定时器等
   * 子类可选实现; 默认无操作
   */
  destroy(): void {
    // no-op by default
  }
}

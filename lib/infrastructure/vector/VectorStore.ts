/**
 * VectorStore — 向量存储抽象层
 * 定义向量存储的标准接口，支持 JSON/Milvus 等后端
 */

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
  async upsert(item: any): Promise<void> {
    throw new Error('Not implemented: upsert()');
  }

  /**
   * 批量 upsert
   * @param {Array} items
   */
  async batchUpsert(items: any[]): Promise<void> {
    // 分批并行处理，避免 O(N) 串行延迟
    const BATCH_SIZE = 50;
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map((item) => this.upsert(item)));
    }
  }

  /**
   * 删除文档
   * @param {string} id
   */
  async remove(id: any): Promise<void> {
    throw new Error('Not implemented: remove()');
  }

  /**
   * 按 ID 获取
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async getById(id: any): Promise<any | null> {
    throw new Error('Not implemented: getById()');
  }

  /**
   * 向量相似度搜索
   * @param {number[]} queryVector
   * @param {object} options - { topK, filter, minScore }
   * @returns {Promise<Array<{ item: object, score: number }>>}
   */
  async searchVector(queryVector: any, options: any = {}): Promise<Array<{ item: any; score: number }>> {
    throw new Error('Not implemented: searchVector()');
  }

  /**
   * 按过滤条件搜索
   * @param {object} filter - { type, category, language, tags, ... }
   * @returns {Promise<Array>}
   */
  async searchByFilter(filter: any): Promise<any[]> {
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

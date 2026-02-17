/**
 * KnowledgeRepository — 统一知识实体仓储接口
 *
 * 替代 CandidateRepository + RecipeRepository。
 * 实现类见 lib/repository/knowledge/KnowledgeRepository.impl.js
 */
export class KnowledgeRepository {

  /**
   * 创建 KnowledgeEntry
   * @param {import('./KnowledgeEntry.js').KnowledgeEntry} entry
   * @returns {Promise<import('./KnowledgeEntry.js').KnowledgeEntry>}
   */
  async create(entry) {
    throw new Error('Not implemented');
  }

  /**
   * 根据 ID 获取
   * @param {string} id
   * @returns {Promise<import('./KnowledgeEntry.js').KnowledgeEntry|null>}
   */
  async findById(id) {
    throw new Error('Not implemented');
  }

  /**
   * 分页查询
   * @param {Object} filters - { lifecycle, kind, language, category, knowledgeType, source }
   * @param {Object} options - { page, pageSize, orderBy, order }
   * @returns {Promise<{ data: KnowledgeEntry[], pagination: Object }>}
   */
  async findWithPagination(filters = {}, options = {}) {
    throw new Error('Not implemented');
  }

  /**
   * 根据生命周期状态查询
   * @param {string} lifecycle
   * @param {Object} pagination
   * @returns {Promise<{ data: KnowledgeEntry[], pagination: Object }>}
   */
  async findByLifecycle(lifecycle, pagination = {}) {
    throw new Error('Not implemented');
  }

  /**
   * 根据 kind 查询
   * @param {string} kind - 'rule' | 'pattern' | 'fact'
   * @param {Object} options - { page, pageSize, lifecycle }
   * @returns {Promise<{ data: KnowledgeEntry[], pagination: Object }>}
   */
  async findByKind(kind, options = {}) {
    throw new Error('Not implemented');
  }

  /**
   * 查询所有 active 的 rule 类型（Guard 消费热路径）
   * @returns {Promise<KnowledgeEntry[]>}
   */
  async findActiveRules() {
    throw new Error('Not implemented');
  }

  /**
   * 根据语言查询
   * @param {string} language
   * @param {Object} pagination
   * @returns {Promise<{ data: KnowledgeEntry[], pagination: Object }>}
   */
  async findByLanguage(language, pagination = {}) {
    throw new Error('Not implemented');
  }

  /**
   * 根据分类查询
   * @param {string} category
   * @param {Object} pagination
   * @returns {Promise<{ data: KnowledgeEntry[], pagination: Object }>}
   */
  async findByCategory(category, pagination = {}) {
    throw new Error('Not implemented');
  }

  /**
   * 搜索 (标题/内容/触发词/标签)
   * @param {string} keyword
   * @param {Object} pagination
   * @returns {Promise<{ data: KnowledgeEntry[], pagination: Object }>}
   */
  async search(keyword, pagination = {}) {
    throw new Error('Not implemented');
  }

  /**
   * 更新
   * @param {string} id
   * @param {Object} updates - wire format 的部分字段
   * @returns {Promise<import('./KnowledgeEntry.js').KnowledgeEntry>}
   */
  async update(id, updates) {
    throw new Error('Not implemented');
  }

  /**
   * 删除
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async delete(id) {
    throw new Error('Not implemented');
  }

  /**
   * 获取统计信息
   * @returns {Promise<Object>}
   */
  async getStats() {
    throw new Error('Not implemented');
  }
}

export default KnowledgeRepository;

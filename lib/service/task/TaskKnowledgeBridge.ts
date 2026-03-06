import Logger from '../../infrastructure/logging/Logger.js';

/**
 * TaskKnowledgeBridge — 任务 ↔ 知识桥接服务
 *
 * AutoSnippet 独有能力：返回「带知识上下文的任务」，而非裸任务。
 *
 * 桥接策略：
 *   1. 任务标题/描述 → 搜索知识库 → 关联 pattern/rule/fact
 *   2. 关联的 Guard 规则 → 嵌入任务上下文
 */
export class TaskKnowledgeBridge {
  _search: any;
  logger: any;
  /**
   * @param {import('../../service/search/SearchEngine.js').SearchEngine} searchEngine
   */
  constructor(searchEngine) {
    this._search = searchEngine;
    this.logger = Logger.getInstance();
  }

  /**
   * 为就绪任务附加知识上下文
   * 并行搜索，不阻塞主流程
   *
   * @param {import('../../domain/task/Task.js').Task[]} tasks
   * @returns {Promise<import('../../domain/task/Task.js').Task[]>}
   */
  async enrichWithKnowledge(tasks) {
    if (!tasks || tasks.length === 0) {
      return tasks;
    }
    if (!this._search) {
      return tasks;
    }

    const results = await Promise.allSettled(tasks.map((task) => this._buildContext(task)));

    return tasks.map((task, i) => {
      if (results[i].status === 'fulfilled' && results[i].value) {
        task.knowledgeContext = results[i].value;
      }
      return task;
    });
  }

  /**
   * 为单个任务构建知识上下文
   * @private
   */
  async _buildContext(task) {
    const query = `${task.title} ${task.description}`.trim();
    if (!query) {
      return null;
    }

    try {
      const searchResult = await this._search.search(query, {
        mode: 'auto',
        limit: 5,
      });

      const allResults = searchResult?.items || searchResult?.results || [];
      const knowledge = allResults.filter((r) => r.kind !== 'rule').slice(0, 3);
      const guardRules = allResults.filter((r) => r.kind === 'rule').slice(0, 5);

      return {
        relatedKnowledge: knowledge.map((k) => ({
          id: k.id,
          title: k.title,
          kind: k.kind,
          trigger: k.trigger,
          actionHint: k.actionHint || k.doClause || '',
        })),
        guardRules: guardRules.map((r) => ({
          id: r.id,
          title: r.title,
          trigger: r.trigger,
          actionHint: r.actionHint || r.doClause || '',
        })),
        searchQuery: query,
      };
    } catch (err: any) {
      this.logger.debug('TaskKnowledgeBridge._buildContext error', {
        taskId: task.id,
        error: err.message,
      });
      return null;
    }
  }
}

export default TaskKnowledgeBridge;

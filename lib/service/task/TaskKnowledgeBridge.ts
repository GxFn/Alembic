import { ioLimit } from '#shared/concurrency.js';
import type { Task } from '../../domain/task/Task.js';
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
  _search: {
    search: (query: string, options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  } | null;
  logger: ReturnType<typeof Logger.getInstance>;
  /**
   * @param {import('../../service/search/SearchEngine.js').SearchEngine} searchEngine
   */
  constructor(searchEngine: {
    search: (query: string, options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  }) {
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
  async enrichWithKnowledge(tasks: Task[]) {
    if (!tasks || tasks.length === 0) {
      return tasks;
    }
    if (!this._search) {
      return tasks;
    }

    const results = await Promise.allSettled(
      tasks.map((task: Task) => ioLimit(() => this._buildContext(task)))
    );

    return tasks.map((task: Task, i: number) => {
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
  async _buildContext(task: Task) {
    const query = `${task.title} ${task.description}`.trim();
    if (!query) {
      return null;
    }

    try {
      const searchResult = await this._search!.search(query, {
        mode: 'auto',
        limit: 5,
      });

      const allResults = (searchResult?.items || searchResult?.results || []) as Array<
        Record<string, unknown>
      >;
      const knowledge = allResults
        .filter((r: Record<string, unknown>) => r.kind !== 'rule')
        .slice(0, 3);
      const guardRules = allResults
        .filter((r: Record<string, unknown>) => r.kind === 'rule')
        .slice(0, 5);

      return {
        relatedKnowledge: knowledge.map((k: Record<string, unknown>) => ({
          id: k.id,
          title: k.title,
          kind: k.kind,
          trigger: k.trigger,
          actionHint: k.actionHint || k.doClause || '',
        })),
        guardRules: guardRules.map((r: Record<string, unknown>) => ({
          id: r.id,
          title: r.title,
          trigger: r.trigger,
          actionHint: r.actionHint || r.doClause || '',
        })),
        searchQuery: query,
      };
    } catch (err: unknown) {
      this.logger.debug('TaskKnowledgeBridge._buildContext error', {
        taskId: task.id,
        error: (err as Error).message,
      });
      return null;
    }
  }
}

export default TaskKnowledgeBridge;

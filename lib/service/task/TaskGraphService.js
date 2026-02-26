import { Task } from '../../domain/task/Task.js';
import { DepType, affectsReadyWork, isValidDepType } from '../../domain/task/TaskDependency.js';
import Logger from '../../infrastructure/logging/Logger.js';

/**
 * TaskGraphService — 任务图核心服务
 *
 * 编排 TaskRepository / TaskReadyEngine / TaskKnowledgeBridge / AuditLog / IdGenerator。
 * 对外提供完整的任务生命周期管理。
 *
 * 设计原则：
 *   - 所有写操作记录审计事件 (task_events 表)
 *   - claim 是原子操作 (status + assignee 一起更新)
 *   - close 时验证不变量 (closedAt 必须存在)
 *   - 子任务 ID 自动递增 (parent.1, parent.2, ...)
 *
 * AutoSnippet 增强：
 *   - ready 返回带知识上下文的任务
 *   - close 返回 newlyReady 列表（减少 Agent MCP 调用次数）
 *   - prime 支持会话恢复（幂等）
 */
export class TaskGraphService {
  /**
   * @param {import('../../repository/task/TaskRepository.impl.js').TaskRepositoryImpl} repository
   * @param {import('./TaskReadyEngine.js').TaskReadyEngine} readyEngine
   * @param {import('./TaskKnowledgeBridge.js').TaskKnowledgeBridge} [knowledgeBridge]
   * @param {object} [auditLogger]
   * @param {import('../../domain/task/TaskIdGenerator.js').TaskIdGenerator} idGenerator
   */
  constructor(repository, readyEngine, knowledgeBridge, auditLogger, idGenerator) {
    this.repo = repository;
    this.readyEngine = readyEngine;
    this.bridge = knowledgeBridge || null;
    this.auditLogger = auditLogger || null;
    this.idGen = idGenerator;
    this.logger = Logger.getInstance();
  }

  // ═══ 创建 ═══════════════════════════════════════════

  /**
   * 创建任务
   * @param {object} data — { title, description, design, acceptance, priority, taskType, parentId }
   * @returns {{ task: Task, isDuplicate: boolean }}
   */
  async create(data) {
    const task = new Task(data);
    task.computeContentHash();
    task.validate();

    // 去重检测（findByContentHash 已排除 closed 状态）
    const duplicate = this.repo.findByContentHash(task.contentHash);
    if (duplicate) {
      return { task: duplicate, isDuplicate: true };
    }

    // 生成 ID
    if (data.parentId) {
      task.id = this.idGen.generateChild(data.parentId);
      task.parentId = data.parentId;
    } else {
      task.id = this.idGen.generate();
    }

    // 事务：创建任务 + 子任务自动依赖
    const saved = this.repo.inTransaction(() => {
      const created = this.repo.create(task);

      if (data.parentId) {
        this.repo.addDependency(created.id, data.parentId, DepType.PARENT_CHILD);
      }

      return created;
    });

    this._logEvent(saved.id, 'created', null, saved.title);
    return { task: saved, isDuplicate: false };
  }

  /**
   * 批量拆解 Epic
   * 一次性创建多个子任务 + 依赖关系，减少 Agent 的 MCP 调用次数
   *
   * @param {string} epicId
   * @param {Array<object>} subtasks — [{ title, description, priority, taskType, blockedByIndex }]
   * @returns {Task[]}
   */
  async decompose(epicId, subtasks) {
    const epic = this.repo.findById(epicId);
    if (!epic) throw new Error(`Epic not found: ${epicId}`);

    const results = this.repo.inTransaction(() => {
      const created = [];

      for (let i = 0; i < subtasks.length; i++) {
        const sub = subtasks[i];
        const task = new Task({
          ...sub,
          parentId: epicId,
        });
        task.computeContentHash();
        task.validate();
        task.id = this.idGen.generateChild(epicId);
        task.parentId = epicId;

        const saved = this.repo.create(task);
        this.repo.addDependency(saved.id, epicId, DepType.PARENT_CHILD);
        created.push(saved);
      }

      // 子任务间的依赖（通过 index 引用，支持单个数字或数组）
      for (let i = 0; i < subtasks.length; i++) {
        const sub = subtasks[i];
        if (sub.blockedByIndex == null) continue;

        // 统一为数组处理
        const indices = Array.isArray(sub.blockedByIndex)
          ? sub.blockedByIndex
          : [sub.blockedByIndex];

        for (const idx of indices) {
          if (typeof idx === 'number' && idx >= 0 && idx < created.length && idx !== i) {
            this.repo.addDependency(created[i].id, created[idx].id, DepType.BLOCKS);
          }
        }
      }

      // Epic 等待所有子任务完成
      for (const c of created) {
        this.repo.addDependency(epicId, c.id, DepType.WAITS_FOR);
      }

      return created;
    });

    this._logEvent(epicId, 'decomposed', null, `${results.length} subtasks`);
    return results;
  }

  // ═══ 工作流操作 ═══════════════════════════════════════

  /**
   * 认领任务
   * @param {string} id
   * @param {string} [assignee='agent']
   * @returns {Task}
   */
  async claim(id, assignee = 'agent') {
    const task = this.repo.findById(id);
    if (!task) throw new Error(`Task not found: ${id}`);

    const oldStatus = task.status;
    task.claim(assignee);
    const saved = this.repo.update(id, {
      status: 'in_progress',
      assignee,
      updatedAt: Math.floor(Date.now() / 1000),
    });

    this._logEvent(id, 'status_changed', oldStatus, 'in_progress');
    return saved;
  }

  /**
   * 关闭任务
   * 返回因此解除阻塞的新就绪任务列表
   *
   * @param {string} id
   * @param {string} [reason='Completed']
   * @returns {{ task: Task, newlyReady: string[] }}
   */
  async close(id, reason = 'Completed') {
    const task = this.repo.findById(id);
    if (!task) throw new Error(`Task not found: ${id}`);

    const oldStatus = task.status;
    task.close(reason);
    const saved = this.repo.update(id, {
      status: 'closed',
      closeReason: reason,
      closedAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
    });

    this._logEvent(id, 'closed', oldStatus, `closed: ${reason}`);

    // 查找因此解除阻塞的任务
    const newlyReady = this._checkNewlyUnblocked(id);
    return { task: saved, newlyReady };
  }

  /**
   * 标记任务失败
   * 释放认领、递增失败计数、回退到 open
   *
   * @param {string} id
   * @param {string} reason
   * @returns {Task}
   */
  async fail(id, reason) {
    const task = this.repo.findById(id);
    if (!task) throw new Error(`Task not found: ${id}`);

    task.fail(reason);
    const saved = this.repo.update(id, {
      status: 'open',
      assignee: '',
      failCount: task.failCount,
      lastFailReason: task.lastFailReason,
      updatedAt: Math.floor(Date.now() / 1000),
    });

    this._logEvent(id, 'failed', 'in_progress', reason);
    return saved;
  }

  /**
   * 推迟任务
   * @param {string} id
   * @param {string} [reason='']
   * @returns {Task}
   */
  async defer(id, reason = '') {
    const task = this.repo.findById(id);
    if (!task) throw new Error(`Task not found: ${id}`);

    const oldStatus = task.status;
    task.defer(reason);
    const saved = this.repo.update(id, {
      status: 'deferred',
      notes: task.notes,
      updatedAt: Math.floor(Date.now() / 1000),
    });

    this._logEvent(id, 'deferred', oldStatus, reason);
    return saved;
  }

  /**
   * 上报进度（长任务的中间状态更新）
   * @param {string} id
   * @param {string} note
   * @returns {Task}
   */
  async progress(id, note) {
    const task = this.repo.findById(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (task.status !== 'in_progress') {
      throw new Error(`Cannot update progress: task ${id} is ${task.status}, expected in_progress`);
    }

    const saved = this.repo.update(id, {
      notes: note,
      updatedAt: Math.floor(Date.now() / 1000),
    });

    this._logEvent(id, 'progress', null, note);
    return saved;
  }

  // ═══ 依赖管理 ═══════════════════════════════════════

  /**
   * 添加依赖
   * @param {string} taskId
   * @param {string} dependsOnId
   * @param {string} [depType='blocks']
   */
  async addDependency(taskId, dependsOnId, depType = 'blocks') {
    if (taskId === dependsOnId) {
      throw new Error('Self-dependency is not allowed');
    }
    if (!isValidDepType(depType)) {
      throw new Error(`Invalid dependency type: ${depType}`);
    }

    // 阻塞型依赖需要环检测
    if (affectsReadyWork(depType)) {
      const hasCycle = this.repo.hasReachablePath(dependsOnId, taskId);
      if (hasCycle) {
        throw new Error(`Cycle detected: ${taskId} → ${dependsOnId}`);
      }
    }

    this.repo.addDependency(taskId, dependsOnId, depType);
    this._logEvent(taskId, 'dependency_added', null, `${depType}: ${dependsOnId}`);
  }

  // ═══ 查询操作 ═══════════════════════════════════════

  /**
   * 获取就绪任务 + 知识上下文
   * @param {object} [options] — { limit, withKnowledge }
   * @returns {Promise<Task[]>}
   */
  async ready(options = {}) {
    const tasks = this.readyEngine.getReadyWork(options);

    if (this.bridge && options.withKnowledge !== false) {
      return this.bridge.enrichWithKnowledge(tasks);
    }

    return tasks;
  }

  /**
   * 获取被阻塞的任务
   */
  async blocked() {
    return this.readyEngine.getBlockedWork();
  }

  /**
   * 获取单个任务详情
   * @param {string} id
   * @returns {Task|null}
   */
  async show(id) {
    return this.repo.findById(id);
  }

  /**
   * 列表查询
   * @param {object} filters — { status, taskType, assignee, parentId }
   * @param {object} options — { limit }
   * @returns {Task[]}
   */
  async list(filters = {}, options = {}) {
    return this.repo.findAll(filters, options);
  }

  /**
   * 依赖树
   */
  async depTree(taskId) {
    return this.readyEngine.getDependencyTree(taskId);
  }

  /**
   * 统计信息
   */
  async stats() {
    return this.repo.getStatistics();
  }

  /**
   * Prime — 会话恢复（幂等）
   *
   * 返回当前进行中的任务 + 就绪任务 + 统计信息。
   * Agent 在新会话开始或上下文压缩后调用。
   *
   * @param {object} [options] — { withKnowledge }
   * @returns {{ inProgress: Task[], ready: Task[], stats: object }}
   */
  async prime(options = {}) {
    const inProgress = this.repo.findAll({ status: 'in_progress' }, { limit: 10 });
    const readyTasks = await this.ready({
      limit: options.limit || 5,
      withKnowledge: options.withKnowledge !== false,
    });
    const statistics = await this.stats();

    return {
      inProgress: inProgress.map((t) => t.toJSON()),
      ready: readyTasks.map((t) => (t.toJSON ? t.toJSON() : t)),
      stats: statistics,
    };
  }

  // ═══ 私有方法 ═══════════════════════════════════════

  /**
   * 查找因 closedTaskId 完成而新解除阻塞的任务
   * @private
   */
  _checkNewlyUnblocked(closedTaskId) {
    const dependents = this.repo.getDependents(closedTaskId);
    const newlyReady = [];

    for (const dep of dependents) {
      // 只关注阻塞型依赖
      if (dep.dep_type !== 'blocks' && dep.dep_type !== 'waits-for') continue;

      // getBlockers 返回"尚未关闭的阻塞者"，空 = 全部完成
      const pendingBlockers = this.repo.getBlockers(dep.task_id);
      if (pendingBlockers.length === 0) {
        // 还要检查任务本身状态是 open
        const task = this.repo.findById(dep.task_id);
        if (task && task.status === 'open') {
          newlyReady.push(dep.task_id);
        }
      }
    }

    return newlyReady;
  }

  /**
   * @private
   */
  _logEvent(taskId, eventType, oldValue, newValue) {
    try {
      this.repo.logEvent(taskId, eventType, oldValue, newValue);
    } catch (err) {
      this.logger.debug('TaskGraphService._logEvent error', { error: err.message });
    }
  }
}

export default TaskGraphService;

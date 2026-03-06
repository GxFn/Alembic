/**
 * BootstrapTaskManager — 冷启动异步任务管理器
 *
 * 核心职责：
 *   1. 管理 bootstrap 异步任务的生命周期（skeleton → filling → completed）
 *   2. 通过 EventBus 发射进度事件
 *   3. 通过 RealtimeService 推送进度到前端 (Socket.io)
 *   4. 支持查询当前 bootstrap 会话状态
 *
 * 任务状态流:
 *   skeleton → filling → completed / failed
 *
 * 事件类型:
 *   bootstrap:started      — 冷启动开始，携带任务清单
 *   bootstrap:task-started  — 单个维度/Skill 开始填充
 *   bootstrap:task-completed — 单个维度/Skill 填充完成
 *   bootstrap:task-failed   — 单个任务失败
 *   bootstrap:all-completed — 全部任务完成
 */

import Logger from '../../infrastructure/logging/Logger.js';

/** 任务状态枚举 */
export const TaskStatus = Object.freeze({
  SKELETON: 'skeleton', // 骨架已创建，等待填充
  FILLING: 'filling', // 内容正在填充中
  COMPLETED: 'completed', // 填充完成
  FAILED: 'failed', // 填充失败
});

/**
 * 单个 Bootstrap 会话（一次冷启动的全部上下文）
 */
class BootstrapSession {
  constructor(sessionId) {
    this.id = sessionId;
    this.startedAt = Date.now();
    this.completedAt = null;
    this.status = 'running'; // running | completed | failed
    this.tasks = new Map(); // taskId → TaskInfo
    this.summary = null; // 完成后的摘要
  }

  addTask(taskId, meta) {
    this.tasks.set(taskId, {
      id: taskId,
      status: TaskStatus.SKELETON,
      meta, // { type: 'dimension'|'skill', dimId, label, skillWorthy }
      startedAt: null,
      completedAt: null,
      result: null, // 填充结果摘要
      error: null,
    });
  }

  getTask(taskId) {
    return this.tasks.get(taskId);
  }

  get totalTasks() {
    return this.tasks.size;
  }
  get completedTasks() {
    return [...this.tasks.values()].filter((t) => t.status === TaskStatus.COMPLETED).length;
  }
  get failedTasks() {
    return [...this.tasks.values()].filter((t) => t.status === TaskStatus.FAILED).length;
  }
  get fillingTasks() {
    return [...this.tasks.values()].filter((t) => t.status === TaskStatus.FILLING).length;
  }
  get skeletonTasks() {
    return [...this.tasks.values()].filter((t) => t.status === TaskStatus.SKELETON).length;
  }

  get isAllDone() {
    return this.skeletonTasks === 0 && this.fillingTasks === 0;
  }

  get totalToolCalls() {
    let count = 0;
    for (const t of this.tasks.values()) {
      if (t.result?.toolCallCount) {
        count += t.result.toolCallCount;
      }
    }
    return count;
  }

  get progress() {
    const total = this.totalTasks;
    if (total === 0) {
      return 100;
    }
    return Math.round(((this.completedTasks + this.failedTasks) / total) * 100);
  }

  toJSON() {
    return {
      id: this.id,
      status: this.status,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      progress: this.progress,
      total: this.totalTasks,
      completed: this.completedTasks,
      failed: this.failedTasks,
      filling: this.fillingTasks,
      skeleton: this.skeletonTasks,
      totalToolCalls: this.totalToolCalls,
      tasks: [...this.tasks.values()].map((t) => ({
        id: t.id,
        status: t.status,
        meta: t.meta,
        startedAt: t.startedAt,
        completedAt: t.completedAt,
        result: t.result,
        error: t.error,
      })),
      summary: this.summary,
    };
  }
}

export class BootstrapTaskManager {
  /** @type {BootstrapSession|null} */
  #currentSession = null;

  /** @type {import('../../infrastructure/event/EventBus.js').EventBus|null} */
  #eventBus = null;

  /** @type {Function|null} 获取 RealtimeService 的 getter（延迟获取，避免循环依赖） */
  #getRealtimeService = null;

  constructor({ eventBus, getRealtimeService } = {}) {
    this.#eventBus = eventBus || null;
    this.#getRealtimeService = getRealtimeService || null;
  }

  // ═══════════════════════════════════════════════════════════
  //  Session 管理
  // ═══════════════════════════════════════════════════════════

  /**
   * 启动新的 bootstrap 会话
   *
   * 如果上一个会话仍在运行，自动 abort 后再创建新会话（防止重复触发产出重复 Candidate）。
   *
   * @param {Array<{id: string, meta: object}>} taskDefs 任务定义列表
   * @returns {BootstrapSession}
   */
  startSession(taskDefs) {
    // ── 并发锁：如果上一个 session 还在运行，先中止 ──
    if (this.isRunning) {
      Logger.warn(
        `[Bootstrap] Previous session ${this.#currentSession.id} still running — aborting before starting new session`
      );
      this.abortSession('Superseded by new bootstrap request');
    }

    const sessionId = `bs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.#currentSession = new BootstrapSession(sessionId);

    for (const { id, meta } of taskDefs) {
      this.#currentSession.addTask(id, meta);
    }

    Logger.info(`[Bootstrap] Session ${sessionId} started with ${taskDefs.length} tasks`);
    this.#emit('bootstrap:started', {
      sessionId,
      tasks: taskDefs.map((t) => ({ id: t.id, ...t.meta })),
      total: taskDefs.length,
      startedAt: this.#currentSession.startedAt,
    });

    return this.#currentSession;
  }

  /**
   * 中止当前 bootstrap 会话
   *
   * 将所有未完成的任务标记为 failed，并将 session 标记为 aborted。
   * 异步填充函数通过 `isSessionValid(sessionId)` 检测到 session 已变更后自动退出。
   *
   * @param {string} [reason='Aborted by user']
   */
  abortSession(reason = 'Aborted by user') {
    const session = this.#currentSession;
    if (!session || session.status !== 'running') {
      return;
    }

    // 将未完成的任务全部标记 FAILED
    for (const task of session.tasks.values()) {
      if (task.status === TaskStatus.SKELETON || task.status === TaskStatus.FILLING) {
        task.status = TaskStatus.FAILED;
        task.completedAt = Date.now();
        task.error = reason;
      }
    }

    session.status = 'aborted';
    session.completedAt = Date.now();
    session.summary = {
      duration: session.completedAt - session.startedAt,
      totalTasks: session.totalTasks,
      completed: session.completedTasks,
      failed: session.failedTasks,
      aborted: true,
      reason,
    };

    Logger.info(`[Bootstrap] Session ${session.id} aborted: ${reason}`);
    this.#emit('bootstrap:all-completed', {
      sessionId: session.id,
      summary: session.summary,
      tasks: [...session.tasks.values()].map((t) => ({
        id: t.id,
        status: t.status,
        meta: t.meta,
        result: t.result,
        error: t.error,
      })),
    });
  }

  /**
   * 验证 sessionId 是否仍然是活跃 session
   *
   * 用于异步填充函数在每次循环迭代前检测：如果 session 已被新请求覆盖，
   * 则当前异步填充应立即停止，避免产出重复内容。
   *
   * @param {string} sessionId
   * @returns {boolean}
   */
  isSessionValid(sessionId) {
    // Session 在 running 或 completed 状态都有效 — completed 表示维度填充完成，
    // 但 Phase 5.5 Skills 生成仍需运行。只有被新 session 替代时才无效。
    return (
      this.#currentSession?.id === sessionId &&
      (this.#currentSession?.status === 'running' ||
        this.#currentSession?.status === 'completed' ||
        this.#currentSession?.status === 'completed_with_errors')
    );
  }

  /**
   * 标记单个任务开始填充
   */
  markTaskFilling(taskId) {
    const session = this.#currentSession;
    if (!session) {
      return;
    }
    const task = session.getTask(taskId);
    if (!task) {
      return;
    }

    task.status = TaskStatus.FILLING;
    task.startedAt = Date.now();

    Logger.info(`[Bootstrap] Task "${taskId}" filling started`);
    this.#emit('bootstrap:task-started', {
      sessionId: session.id,
      taskId,
      meta: task.meta,
      progress: session.progress,
    });
  }

  /**
   * 标记单个任务完成
   * @param {string} taskId
   * @param {object} result 填充结果摘要 { created, items, ... }
   */
  markTaskCompleted(taskId, result = {}) {
    const session = this.#currentSession;
    if (!session) {
      return;
    }
    const task = session.getTask(taskId);
    if (!task) {
      return;
    }

    task.status = TaskStatus.COMPLETED;
    task.completedAt = Date.now();
    task.result = result;

    Logger.info(
      `[Bootstrap] Task "${taskId}" completed (${session.completedTasks}/${session.totalTasks})`
    );
    this.#emit('bootstrap:task-completed', {
      sessionId: session.id,
      taskId,
      meta: task.meta,
      result,
      progress: session.progress,
      completed: session.completedTasks,
      total: session.totalTasks,
      totalToolCalls: session.totalToolCalls,
      elapsedMs: Date.now() - session.startedAt,
    });

    // 检查是否所有任务都已完成
    if (session.isAllDone) {
      this.#finishSession();
    }
  }

  /**
   * 标记单个任务失败
   */
  markTaskFailed(taskId, error) {
    const session = this.#currentSession;
    if (!session) {
      return;
    }
    const task = session.getTask(taskId);
    if (!task) {
      return;
    }

    task.status = TaskStatus.FAILED;
    task.completedAt = Date.now();
    task.error = typeof error === 'string' ? error : error?.message || 'Unknown error';

    Logger.warn(`[Bootstrap] Task "${taskId}" failed: ${task.error}`);
    this.#emit('bootstrap:task-failed', {
      sessionId: session.id,
      taskId,
      meta: task.meta,
      error: task.error,
      progress: session.progress,
    });

    // 检查是否所有任务都已完成（包括失败）
    if (session.isAllDone) {
      this.#finishSession();
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  查询接口
  // ═══════════════════════════════════════════════════════════

  /**
   * 获取当前 session 状态（供 HTTP 轮询）
   */
  getSessionStatus() {
    if (!this.#currentSession) {
      return { status: 'idle', message: 'No active bootstrap session' };
    }
    return this.#currentSession.toJSON();
  }

  /**
   * 是否有正在进行的 bootstrap
   */
  get isRunning() {
    return this.#currentSession?.status === 'running';
  }

  // ═══════════════════════════════════════════════════════════
  //  通用进度推送（供 refine 等非 bootstrap 流程复用双通道）
  // ═══════════════════════════════════════════════════════════

  /**
   * 向 EventBus + Socket.io 发射任意进度事件
   *
   * 用途：不走 bootstrap session 模型的长操作（如 AI 润色）也能复用
   * 同一套 EventBus + RealtimeService 双通道推送。
   *
   * @param {string} eventName 事件名（如 'refine:started'）
   * @param {object} data      事件负载
   */
  emitProgress(eventName, data) {
    this.#emit(eventName, data);
  }

  // ═══════════════════════════════════════════════════════════
  //  内部方法
  // ═══════════════════════════════════════════════════════════

  #finishSession() {
    const session = this.#currentSession;
    if (!session) {
      return;
    }

    session.status = session.failedTasks > 0 ? 'completed_with_errors' : 'completed';
    session.completedAt = Date.now();
    session.summary = {
      duration: session.completedAt - session.startedAt,
      totalTasks: session.totalTasks,
      completed: session.completedTasks,
      failed: session.failedTasks,
    };

    const durationSec = ((session.completedAt - session.startedAt) / 1000).toFixed(1);
    Logger.info(
      `[Bootstrap] Session ${session.id} finished: ${session.completedTasks} completed, ${session.failedTasks} failed (${durationSec}s)`
    );

    this.#emit('bootstrap:all-completed', {
      sessionId: session.id,
      summary: session.summary,
      tasks: [...session.tasks.values()].map((t) => ({
        id: t.id,
        status: t.status,
        meta: t.meta,
        result: t.result,
        error: t.error,
      })),
    });
  }

  /**
   * 发射事件到 EventBus + 推送到前端 Socket.io
   */
  #emit(eventName, data) {
    // EventBus（供后端监听者使用）
    if (this.#eventBus) {
      try {
        this.#eventBus.emit(eventName, data);
      } catch (e) {
        Logger.warn(`[Bootstrap] EventBus emit failed: ${e.message}`);
      }
    }

    // RealtimeService（推送到前端 Socket.io）
    if (this.#getRealtimeService) {
      try {
        const realtime = this.#getRealtimeService();
        realtime.broadcastEvent(eventName, data);
      } catch {
        // RealtimeService 可能未初始化（CLI 模式），静默忽略
      }
    }
  }
}

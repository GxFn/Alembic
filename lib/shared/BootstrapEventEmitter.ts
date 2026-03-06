/**
 * BootstrapEventEmitter.js — 统一的 Bootstrap 进度事件推送
 *
 * 两端（内部 Agent / 外部 Agent）使用相同的事件名和数据格式，
 * 同时兼容 EventBus 和 BootstrapTaskManager。
 *
 * @module shared/BootstrapEventEmitter
 */

export class BootstrapEventEmitter {
  /** @type {object|null} EventBus 实例 */
  #eventBus;

  /** @type {object|null} BootstrapTaskManager 实例 */
  #taskManager;

  /**
   * @param {object} container - DI Container
   */
  constructor(container) {
    this.#eventBus = null;
    this.#taskManager = null;

    try {
      this.#eventBus = container.get?.('eventBus') ?? null;
    } catch { /* eventBus not registered */ }

    try {
      this.#taskManager = container.get?.('bootstrapTaskManager') ?? null;
    } catch { /* taskManager not registered */ }
  }

  /**
   * 推送维度完成事件
   *
   * @param {string} dimId 维度 ID
   * @param {object} data 事件数据
   * @param {string} [data.type] - 'skill' | 'candidate' | 'dual'
   * @param {number} [data.extracted] 提取的候选数量
   * @param {string} [data.source] - 'internal-agent' | 'external-agent'
   * @param {boolean} [data.skillCreated] 是否生成了 Skill
   * @param {number} [data.recipesBound] 关联的 recipe 数量
   */
  emitDimensionComplete(dimId, data: any = {}) {
    // TaskManager 标记
    try {
      this.#taskManager?.markTaskCompleted?.(dimId, data);
    } catch { /* non-blocking */ }

    // EventBus 推送
    try {
      this.#eventBus?.emit?.('bootstrap:task-completed', {
        dimensionId: dimId,
        ...data,
      });
    } catch { /* non-blocking */ }
  }

  /**
   * 推送全部维度完成事件
   *
   * @param {string} sessionId 会话 ID
   * @param {number} totalDimensions 总维度数
   * @param {string} [source] 来源标识
   */
  emitAllComplete(sessionId, totalDimensions, source = 'unknown') {
    try {
      this.#eventBus?.emit?.('bootstrap:all-completed', {
        sessionId,
        totalDimensions,
        source,
      });
    } catch { /* non-blocking */ }
  }

  /**
   * 推送维度开始填充事件
   *
   * @param {string} dimId 维度 ID
   */
  emitDimensionStart(dimId) {
    try {
      this.#taskManager?.markTaskFilling?.(dimId);
    } catch { /* non-blocking */ }
  }

  /**
   * 推送维度失败事件
   *
   * @param {string} dimId 维度 ID
   * @param {Error} error 错误对象
   */
  emitDimensionFailed(dimId, error) {
    try {
      this.#taskManager?.markTaskFailed?.(dimId, error);
    } catch { /* non-blocking */ }

    try {
      this.#eventBus?.emit?.('bootstrap:task-failed', {
        dimensionId: dimId,
        error: error?.message || String(error),
      });
    } catch { /* non-blocking */ }
  }

  /**
   * 推送进度事件
   *
   * @param {string} event 事件名
   * @param {object} data 事件数据
   */
  emitProgress(event, data: any = {}) {
    try {
      this.#eventBus?.emit?.(event, data);
    } catch { /* non-blocking */ }

    try {
      this.#taskManager?.emitProgress?.(event, data);
    } catch { /* non-blocking */ }
  }
}

export default BootstrapEventEmitter;

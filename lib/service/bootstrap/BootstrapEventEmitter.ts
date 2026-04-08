/**
 * BootstrapEventEmitter.js — 统一的 Bootstrap 进度事件推送
 *
 * 两端（内部 Agent / 外部 Agent）使用相同的事件名和数据格式，
 * 同时兼容 EventBus 和 BootstrapTaskManager。
 *
 * @module shared/BootstrapEventEmitter
 */

import type { DimensionCompletePayload, ProgressPayload } from './bootstrap-event-types.js';

export class BootstrapEventEmitter {
  /** EventBus 实例 */
  #eventBus: Record<string, (...args: unknown[]) => void> | null;

  /** BootstrapTaskManager 实例 */
  #taskManager: Record<string, (...args: unknown[]) => void> | null;

  /** @param container DI Container */
  constructor(container: { get?: (name: string) => unknown }) {
    this.#eventBus = null;
    this.#taskManager = null;

    try {
      this.#eventBus = (container.get?.('eventBus') ?? null) as Record<
        string,
        (...args: unknown[]) => void
      > | null;
    } catch {
      /* eventBus not registered */
    }

    try {
      this.#taskManager = (container.get?.('bootstrapTaskManager') ?? null) as Record<
        string,
        (...args: unknown[]) => void
      > | null;
    } catch {
      /* taskManager not registered */
    }
  }

  /**
   * 推送维度完成事件
   *
   * @param dimId 维度 ID
   * @param data 事件数据
   * @param [data.type] 'skill' | 'candidate' | 'dual'
   * @param [data.extracted] 提取的候选数量
   * @param [data.source] 'internal-agent' | 'external-agent'
   * @param [data.skillCreated] 是否生成了 Skill
   * @param [data.recipesBound] 关联的 recipe 数量
   */
  emitDimensionComplete(dimId: string, data: DimensionCompletePayload) {
    // TaskManager 标记
    try {
      this.#taskManager?.markTaskCompleted?.(dimId, data);
    } catch {
      /* non-blocking */
    }

    // EventBus 推送
    try {
      this.#eventBus?.emit?.('bootstrap:task-completed', {
        dimensionId: dimId,
        ...data,
      });
    } catch {
      /* non-blocking */
    }
  }

  /**
   * 推送全部维度完成事件
   *
   * @param sessionId 会话 ID
   * @param totalDimensions 总维度数
   * @param [source] 来源标识
   */
  emitAllComplete(sessionId: string, totalDimensions: number, source = 'unknown') {
    try {
      this.#eventBus?.emit?.('bootstrap:all-completed', {
        sessionId,
        totalDimensions,
        source,
      });
    } catch {
      /* non-blocking */
    }
  }

  /**
   * 推送维度开始填充事件
   *
   * @param dimId 维度 ID
   */
  emitDimensionStart(dimId: string) {
    try {
      this.#taskManager?.markTaskFilling?.(dimId);
    } catch {
      /* non-blocking */
    }
  }

  /**
   * 推送维度失败事件
   *
   * @param dimId 维度 ID
   * @param error 错误对象
   */
  emitDimensionFailed(dimId: string, error: Error | string) {
    try {
      this.#taskManager?.markTaskFailed?.(dimId, error);
    } catch {
      /* non-blocking */
    }

    try {
      this.#eventBus?.emit?.('bootstrap:task-failed', {
        dimensionId: dimId,
        error: typeof error === 'string' ? error : error?.message,
      });
    } catch {
      /* non-blocking */
    }
  }

  /**
   * 推送进度事件
   *
   * @param event 事件名
   * @param data 事件数据
   */
  emitProgress(event: string, data: ProgressPayload = {}) {
    try {
      this.#eventBus?.emit?.(event, data);
    } catch {
      /* non-blocking */
    }

    try {
      this.#taskManager?.emitProgress?.(event, data);
    } catch {
      /* non-blocking */
    }
  }
}

export default BootstrapEventEmitter;

/**
 * EventBus — 应用事件总线
 * 支持 emit/emitAsync、事件历史日志、统计
 */

import { EventEmitter } from 'node:events';

export class EventBus extends EventEmitter {
  #history: any[];
  #historyLimit;

  constructor(options: any = {}) {
    super();
    this.setMaxListeners(options.maxListeners || 20);
    this.#history = [];
    this.#historyLimit = options.historyLimit || 100;
  }

  /**
   * 同步 emit + 记录历史
   */
  emit(eventName: any, ...args: any[]) {
    this.#recordEvent(eventName, args);
    return super.emit(eventName, ...args);
  }

  /**
   * 异步 emit — 串行等待所有 listener 完成
   * @param {string} eventName
   * @param  {...any} args
   */
  async emitAsync(eventName: any, ...args: any[]) {
    this.#recordEvent(eventName, args);
    const listeners = this.listeners(eventName);
    for (const listener of listeners) {
      await listener(...args);
    }
  }

  /**
   * 获取事件历史
   * @param {number} limit
   */
  getHistory(limit = 10) {
    return this.#history.slice(-limit);
  }

  /**
   * 清空历史
   */
  clearHistory() {
    this.#history = [];
  }

  /**
   * 获取统计
   */
  getStats() {
    const events: Record<string, any> = {};
    for (const entry of this.#history) {
      events[entry.event] = (events[entry.event] || 0) + 1;
    }
    return {
      totalEvents: this.#history.length,
      uniqueEvents: Object.keys(events).length,
      byEvent: events,
      activeListeners: this.eventNames().reduce((sum, name) => sum + this.listenerCount(name), 0),
    };
  }

  // ─── 私有 ─────────────────────────────────────────────

  #recordEvent(eventName: any, args: any) {
    this.#history.push({
      event: eventName,
      timestamp: new Date().toISOString(),
      argCount: args.length,
    });
    if (this.#history.length > this.#historyLimit) {
      this.#history = this.#history.slice(-this.#historyLimit);
    }
  }
}

/**
 * FileChangeDispatcher — 文件变更事件分发器（Pub-Sub）
 *
 * 接收 HTTP 路由推送的文件变更事件，分发给所有注册的订阅者。
 * 订阅者之间相互隔离，使用 Promise.allSettled 确保单个失败不影响其他。
 */

import Logger from '../infrastructure/logging/Logger.js';
import type { FileChangeEvent } from '../types/reactive-evolution.js';

const logger = Logger.getInstance();

/** 文件变更订阅者接口 */
export interface FileChangeSubscriber {
  /** 订阅者名称（用于日志） */
  readonly name: string;
  /** 处理文件变更事件 */
  onFileChanges(events: FileChangeEvent[]): Promise<void>;
}

export class FileChangeDispatcher {
  private readonly subscribers: FileChangeSubscriber[] = [];

  /** 注册订阅者 */
  register(subscriber: FileChangeSubscriber): void {
    this.subscribers.push(subscriber);
    logger.info(`Subscriber registered: ${subscriber.name}`);
  }

  /** 分发事件给所有订阅者 */
  async dispatch(events: FileChangeEvent[]): Promise<void> {
    if (events.length === 0 || this.subscribers.length === 0) {
      return;
    }

    logger.info(
      `Dispatching ${events.length} file change(s) to ${this.subscribers.length} subscriber(s)`
    );

    const results = await Promise.allSettled(this.subscribers.map((s) => s.onFileChanges(events)));

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        logger.warn(`Subscriber "${this.subscribers[i].name}" failed: ${String(result.reason)}`);
      }
    }
  }
}

/**
 * FileChangeDispatcher — 文件变更事件分发器（Pub-Sub）
 *
 * 接收 HTTP 路由推送的文件变更事件，分发给所有注册的订阅者。
 * 订阅者之间相互隔离，使用 Promise.allSettled 确保单个失败不影响其他。
 *
 * 订阅者可选返回 {@link ReactiveEvolutionReport}，Dispatcher 将所有 report 合并后
 * 返回给路由层，路由层再透传到 HTTP 响应体（供 VSCode 扩展弹窗使用）。
 */

import Logger from '../infrastructure/logging/Logger.js';
import type {
  FileChangeEvent,
  FileChangeEventSource,
  ReactiveEvolutionReport,
} from '../types/reactive-evolution.js';

const logger = Logger.getInstance();

/** 文件变更订阅者接口。可选返回聚合 report；旧订阅者返回 void 仍兼容。 */
export interface FileChangeSubscriber {
  /** 订阅者名称（用于日志） */
  readonly name: string;
  /** 处理文件变更事件 */
  onFileChanges(events: FileChangeEvent[]): Promise<ReactiveEvolutionReport | void>;
}

/** 空 report 常量（无订阅者 / 无事件时返回） */
function emptyReport(eventSource?: FileChangeEventSource): ReactiveEvolutionReport {
  return {
    fixed: 0,
    deprecated: 0,
    skipped: 0,
    needsReview: 0,
    suggestReview: false,
    details: [],
    eventSource,
  };
}

/** 合并两个 report（用于多订阅者场景）。details 去重按 recipeId + action + modifiedPath。 */
function mergeReports(
  a: ReactiveEvolutionReport,
  b: ReactiveEvolutionReport
): ReactiveEvolutionReport {
  const seen = new Set<string>();
  const details = [...a.details, ...b.details].filter((d) => {
    const key = `${d.recipeId}:${d.action}:${d.modifiedPath ?? ''}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return {
    fixed: a.fixed + b.fixed,
    deprecated: a.deprecated + b.deprecated,
    skipped: a.skipped + b.skipped,
    needsReview: a.needsReview + b.needsReview,
    suggestReview: a.suggestReview || b.suggestReview,
    details,
    eventSource: a.eventSource ?? b.eventSource,
  };
}

/** 根据批次事件统计主要来源（出现最多者；均缺省时返回 undefined）。 */
function inferBatchSource(events: FileChangeEvent[]): FileChangeEventSource | undefined {
  const counts = new Map<FileChangeEventSource, number>();
  for (const e of events) {
    if (e.eventSource) {
      counts.set(e.eventSource, (counts.get(e.eventSource) ?? 0) + 1);
    }
  }
  if (counts.size === 0) {
    return undefined;
  }
  let winner: FileChangeEventSource | undefined;
  let max = -1;
  for (const [src, n] of counts) {
    if (n > max) {
      max = n;
      winner = src;
    }
  }
  return winner;
}

export class FileChangeDispatcher {
  private readonly subscribers: FileChangeSubscriber[] = [];

  /** 注册订阅者 */
  register(subscriber: FileChangeSubscriber): void {
    this.subscribers.push(subscriber);
    logger.info(`Subscriber registered: ${subscriber.name}`);
  }

  /**
   * 分发事件给所有订阅者并合并其 report。
   *
   * 即便无订阅者 / 无事件，也返回一份带 eventSource 的空 report，
   * HTTP 路由层可直接透传。
   */
  async dispatch(events: FileChangeEvent[]): Promise<ReactiveEvolutionReport> {
    const eventSource = inferBatchSource(events);

    if (events.length === 0 || this.subscribers.length === 0) {
      return emptyReport(eventSource);
    }

    logger.info(
      `Dispatching ${events.length} file change(s) to ${this.subscribers.length} subscriber(s)`
    );

    const results = await Promise.allSettled(this.subscribers.map((s) => s.onFileChanges(events)));

    let merged = emptyReport(eventSource);
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        logger.warn(`Subscriber "${this.subscribers[i].name}" failed: ${String(result.reason)}`);
        continue;
      }
      const value = result.value;
      if (value && typeof value === 'object' && 'details' in value) {
        merged = mergeReports(merged, value);
      }
    }

    // eventSource 以批次推断为准（合并过程中可能被订阅者覆盖为 undefined）
    merged.eventSource = eventSource;
    return merged;
  }
}

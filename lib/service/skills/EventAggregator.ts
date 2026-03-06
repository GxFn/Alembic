/**
 * EventAggregator — 信号聚类引擎（受 Continue EditAggregator 启发）
 *
 * 在短时间窗口内将多个同类事件聚合为一个 batch 事件，避免：
 *   1. SignalCollector 对相同类型的信号重复触发 AI 分析
 *   2. 高频操作（如连续文件保存）产生大量冗余事件
 *   3. 多个 Guard 违规在同一编辑中重复推送
 *
 * 聚合策略:
 *   时间窗口 — 同 key 事件在 windowMs 内合并为一个 batch
 *   空间聚类 — 支持自定义 key 提取函数（如按文件路径/违规规则分组）
 *   去重 —— 已处理的事件在 dedupeWindowMs 内不重复触发
 *
 * 用法:
 *   const agg = new EventAggregator({ windowMs: 5000 });
 *   agg.on('batch', (key, events) => { ... });
 *   agg.push('file_change', { filePath: 'a.js' });
 *   // 5 秒内的多次 push 会合并为一次 batch 回调
 */

import Logger from '../../infrastructure/logging/Logger.js';

const DEFAULT_WINDOW_MS = 5000; // 5 秒聚合窗口
const DEFAULT_MAX_BATCH = 50; // 单次 batch 最大事件数
const DEFAULT_DEDUPE_MS = 60_000; // 60 秒去重窗口

export class EventAggregator {
  /** @type {Map<string, { events: any[], timer: ReturnType<typeof setTimeout> }>} */
  #buckets = new Map();
  /** @type {Map<string, number>} 已处理事件的 hash → 最后处理时间 */
  #dedupeMap = new Map();
  #listeners = new Map();
  #windowMs;
  #maxBatch;
  #dedupeMs;
  #logger;

  /**
   * @param {object} [opts]
   * @param {number} [opts.windowMs=5000]    聚合时间窗口（毫秒）
   * @param {number} [opts.maxBatch=50]      单次 batch 最大事件数
   * @param {number} [opts.dedupeMs=60000]   相同事件去重窗口（毫秒）
   */
  constructor({
    windowMs = DEFAULT_WINDOW_MS,
    maxBatch = DEFAULT_MAX_BATCH,
    dedupeMs = DEFAULT_DEDUPE_MS,
  } = {}) {
    this.#windowMs = windowMs;
    this.#maxBatch = maxBatch;
    this.#dedupeMs = dedupeMs;
    this.#logger = Logger.getInstance();
  }

  /**
   * 推送一个事件到聚合器
   * @param {string} key 聚合键（如 'file_change', 'guard_violation'）
   * @param {object} event 事件数据
   * @param {object} [opts]
   * @param {string} [opts.dedupeId] 去重标识（默认为 JSON hash）
   */
  push(key, event, { dedupeId }: any = {}) {
    // 去重检查
    const dedupe = dedupeId || this.#hashEvent(key, event);
    const lastSeen = this.#dedupeMap.get(dedupe);
    if (lastSeen && Date.now() - lastSeen < this.#dedupeMs) {
      this.#logger.debug(`[EventAggregator] dedup skip: ${key}/${dedupe}`);
      return;
    }

    let bucket = this.#buckets.get(key);
    if (!bucket) {
      bucket = { events: [], timer: null };
      this.#buckets.set(key, bucket);
    }

    bucket.events.push({ ...event, _ts: Date.now() });

    // 达到最大 batch 立即触发
    if (bucket.events.length >= this.#maxBatch) {
      this.#flush(key);
      return;
    }

    // 重置窗口计时器
    if (bucket.timer) {
      clearTimeout(bucket.timer);
    }
    bucket.timer = setTimeout(() => this.#flush(key), this.#windowMs);
  }

  /**
   * 注册 batch 事件监听器
   * @param {'batch'} eventName
   * @param {(key: string, events: any[]) => void} fn
   */
  on(eventName, fn) {
    if (!this.#listeners.has(eventName)) {
      this.#listeners.set(eventName, []);
    }
    this.#listeners.get(eventName).push(fn);
  }

  /**
   * 立即刷新所有待处理 bucket
   */
  flushAll() {
    for (const key of this.#buckets.keys()) {
      this.#flush(key);
    }
  }

  /**
   * 停止所有计时器
   */
  destroy() {
    for (const [, bucket] of this.#buckets) {
      if (bucket.timer) {
        clearTimeout(bucket.timer);
      }
    }
    this.#buckets.clear();
    this.#dedupeMap.clear();
    this.#listeners.clear();
  }

  /**
   * 获取待处理事件数
   */
  get pendingCount() {
    let count = 0;
    for (const [, bucket] of this.#buckets) {
      count += bucket.events.length;
    }
    return count;
  }

  // ── 内部方法 ──

  #flush(key) {
    const bucket = this.#buckets.get(key);
    if (!bucket || bucket.events.length === 0) {
      return;
    }

    if (bucket.timer) {
      clearTimeout(bucket.timer);
      bucket.timer = null;
    }

    const events = bucket.events.splice(0);
    this.#buckets.delete(key);

    // 标记去重
    for (const evt of events) {
      const dedupe = this.#hashEvent(key, evt);
      this.#dedupeMap.set(dedupe, Date.now());
    }

    // 清理过期去重记录
    this.#cleanupDedupe();

    // 通知监听器
    const listeners = this.#listeners.get('batch') || [];
    for (const fn of listeners) {
      try {
        fn(key, events);
      } catch (err: any) {
        this.#logger.warn(`[EventAggregator] listener error: ${err.message}`);
      }
    }

    this.#logger.debug(`[EventAggregator] flushed ${events.length} events for key "${key}"`);
  }

  #hashEvent(key, event) {
    // 简单 hash: key + 事件关键字段
    const significant: any = { key };
    if (event.filePath) {
      significant.f = event.filePath;
    }
    if (event.ruleName) {
      significant.r = event.ruleName;
    }
    if (event.action) {
      significant.a = event.action;
    }
    if (event.id) {
      significant.i = event.id;
    }
    return JSON.stringify(significant);
  }

  #cleanupDedupe() {
    const now = Date.now();
    for (const [hash, ts] of this.#dedupeMap) {
      if (now - ts > this.#dedupeMs) {
        this.#dedupeMap.delete(hash);
      }
    }
  }
}

export default EventAggregator;

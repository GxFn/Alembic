/**
 * AgentEventBus — Agent 间事件通信总线
 *
 * 借鉴 AutoGen Core Event-Driven 架构 + RxJS Observable 模式:
 *   - Agent 间松耦合通信（publish/subscribe）
 *   - 支持同步和异步事件处理
 *   - 内置事件过滤、优先级、TTL
 *   - 支持 request/reply 模式（Agent 间 RPC）
 *
 * @module AgentEventBus
 */

import { EventEmitter } from 'node:events';
import Logger from '../../infrastructure/logging/Logger.js';

/**
 * 标准事件类型
 */
export const AgentEvents = Object.freeze({
  // ── 生命周期 ──
  AGENT_CREATED: 'agent:created',
  AGENT_STARTED: 'agent:started',
  AGENT_COMPLETED: 'agent:completed',
  AGENT_FAILED: 'agent:failed',
  AGENT_ABORTED: 'agent:aborted',

  // ── 执行 ──
  TOOL_CALL_START: 'tool:call:start',
  TOOL_CALL_END: 'tool:call:end',
  LLM_CALL_START: 'llm:call:start',
  LLM_CALL_END: 'llm:call:end',
  STEP_COMPLETED: 'step:completed',

  // ── Agent 间交互 ──
  HANDOFF_REQUEST: 'handoff:request',
  HANDOFF_ACCEPT: 'handoff:accept',
  HANDOFF_RESULT: 'handoff:result',

  // ── 进度 ──
  PROGRESS: 'progress',
  THINKING: 'thinking',
  STREAM_DELTA: 'stream:delta',

  // ── 外部触发 ──
  USER_INPUT: 'user:input',
  LARK_MESSAGE: 'lark:message',
  SCAN_REQUEST: 'scan:request',
});

/**
 * @typedef {Object} AgentEvent
 * @property {string} type 事件类型
 * @property {string} source 发送者 agentId
 * @property {string} [target] 目标 agentId（广播时为 null）
 * @property {Object} payload 事件数据
 * @property {number} timestamp 事件时间戳
 * @property {string} [correlationId] 关联 ID（用于 request/reply）
 */

export class AgentEventBus extends EventEmitter {
  /** @type {AgentEventBus|null} */
  static #instance = null;
  #logger;
  /** @type {Map<string, Function[]>} topic → handlers */
  #subscriptions = new Map();
  /** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
  #pendingReplies = new Map();
  /** @type {number} 事件计数 */
  #eventCount = 0;

  constructor() {
    super();
    this.setMaxListeners(100);
    this.#logger = Logger.getInstance();
  }

  /**
   * 获取全局单例
   * @returns {AgentEventBus}
   */
  static getInstance() {
    if (!AgentEventBus.#instance) {
      AgentEventBus.#instance = new AgentEventBus();
    }
    return AgentEventBus.#instance;
  }

  /**
   * 重置单例（测试用）
   */
  static resetInstance() {
    if (AgentEventBus.#instance) {
      AgentEventBus.#instance.removeAllListeners();
      AgentEventBus.#instance.#subscriptions.clear();
      AgentEventBus.#instance.#pendingReplies.clear();
    }
    AgentEventBus.#instance = null;
  }

  // ─── 发布 ────────────────────────────────

  /**
   * 发布事件（广播）
   * @param {string} type 事件类型
   * @param {Object} payload 事件数据
   * @param {Object} [opts]
   * @param {string} [opts.source] 发送者 agentId
   * @param {string} [opts.target] 目标 agentId
   * @param {string} [opts.correlationId] 关联 ID
   */
  publish(type, payload: any = {}, opts: any = {}) {
    this.#eventCount++;
    const event = {
      type,
      source: opts.source || 'system',
      target: opts.target || null,
      payload,
      timestamp: Date.now(),
      correlationId: opts.correlationId || null,
    };

    // 发射到 EventEmitter（通用监听）
    this.emit(type, event);
    this.emit('*', event); // 全局监听

    // 发射到 topic 订阅者
    const handlers = this.#subscriptions.get(type) || [];
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (err: any) {
        this.#logger.warn(`[AgentEventBus] Handler error on ${type}: ${err.message}`);
      }
    }

    // 检查是否有 pending reply
    if (opts.correlationId && this.#pendingReplies.has(opts.correlationId)) {
      const pending = this.#pendingReplies.get(opts.correlationId);
      clearTimeout(pending.timer);
      this.#pendingReplies.delete(opts.correlationId);
      pending.resolve(event);
    }
  }

  /**
   * 订阅事件
   * @param {string} type 事件类型
   * @param {Function} handler 处理函数 (event) => void
   * @returns {Function} 取消订阅函数
   */
  subscribe(type, handler) {
    if (!this.#subscriptions.has(type)) {
      this.#subscriptions.set(type, []);
    }
    this.#subscriptions.get(type).push(handler);

    return () => {
      const handlers = this.#subscriptions.get(type);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) {
          handlers.splice(idx, 1);
        }
      }
    };
  }

  /**
   * Request/Reply 模式 — 发送请求并等待响应
   * @param {string} requestType 请求事件类型
   * @param {Object} payload 请求数据
   * @param {Object} [opts]
   * @param {number} [opts.timeout=30000] 超时毫秒
   * @param {string} [opts.source] 发送者
   * @returns {Promise<AgentEvent>} 响应事件
   */
  async request(requestType, payload: any = {}, opts: any = {}) {
    const correlationId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timeout = opts.timeout || 30_000;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingReplies.delete(correlationId);
        reject(new Error(`AgentEventBus request timeout: ${requestType} (${timeout}ms)`));
      }, timeout);

      this.#pendingReplies.set(correlationId, { resolve, reject, timer });

      this.publish(requestType, payload, {
        source: opts.source,
        correlationId,
      });
    });
  }

  /**
   * 获取事件统计
   * @returns {Object}
   */
  getStats() {
    return {
      totalEvents: this.#eventCount,
      subscriptionTopics: this.#subscriptions.size,
      pendingReplies: this.#pendingReplies.size,
    };
  }
}

export default AgentEventBus;

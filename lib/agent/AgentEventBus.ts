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
import Logger from '#infra/logging/Logger.js';

/** 标准事件类型 */
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

export class AgentEventBus extends EventEmitter {
  static #instance: AgentEventBus | null = null;
  #logger;
  /** topic → handlers */
  #subscriptions = new Map();
  /** >} */
  #pendingReplies = new Map();
  /** 事件计数 */
  #eventCount = 0;

  constructor() {
    super();
    this.setMaxListeners(100);
    this.#logger = Logger.getInstance();
  }

  /** 获取全局单例 */
  static getInstance() {
    if (!AgentEventBus.#instance) {
      AgentEventBus.#instance = new AgentEventBus();
    }
    return AgentEventBus.#instance;
  }

  /** 重置单例（测试用） */
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
   * @param type 事件类型
   * @param payload 事件数据
   * @param [opts.source] 发送者 agentId
   * @param [opts.target] 目标 agentId
   * @param [opts.correlationId] 关联 ID
   */
  publish(
    type: string,
    payload: Record<string, unknown> = {},
    opts: { source?: string; target?: string; correlationId?: string } = {}
  ) {
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
      } catch (err: unknown) {
        this.#logger.warn(
          `[AgentEventBus] Handler error on ${type}: ${err instanceof Error ? err.message : String(err)}`
        );
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
   * @param type 事件类型
   * @param handler 处理函数 (event) => void
   * @returns 取消订阅函数
   */
  subscribe(type: string, handler: (event: Record<string, unknown>) => void) {
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
   * @param requestType 请求事件类型
   * @param payload 请求数据
   * @param [opts.timeout=30000] 超时毫秒
   * @param [opts.source] 发送者
   * @returns 响应事件
   */
  async request(
    requestType: string,
    payload: Record<string, unknown> = {},
    opts: { timeout?: number; source?: string } = {}
  ) {
    const correlationId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timeout = opts.timeout || 30_000;

    const { promise, resolve, reject } = Promise.withResolvers();
    const timer = setTimeout(() => {
      this.#pendingReplies.delete(correlationId);
      reject(new Error(`AgentEventBus request timeout: ${requestType} (${timeout}ms)`));
    }, timeout);

    this.#pendingReplies.set(correlationId, { resolve, reject, timer });

    this.publish(requestType, payload, {
      source: opts.source,
      correlationId,
    });

    return promise;
  }

  /** 获取事件统计 */
  getStats() {
    return {
      totalEvents: this.#eventCount,
      subscriptionTopics: this.#subscriptions.size,
      pendingReplies: this.#pendingReplies.size,
    };
  }
}

export default AgentEventBus;

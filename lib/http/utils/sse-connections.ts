/**
 * SSE Session Manager — 基于 EventSource 的流式会话管理
 *
 * 架构:
 *   POST /chat/stream → 创建 session + 后台执行 AgentRuntime → 返回 { sessionId }
 *   GET  /chat/events/:sessionId → EventSource 端点, 回放缓冲事件 + 实时推送
 *
 * 为什么不用 fetch + ReadableStream:
 *   Chrome/Safari 的 fetch() streaming 会缓冲初始响应体（~1-4KB），导致小体积
 *   SSE 事件滞留在缓冲区中不被交付给 ReadableStream reader。
 *   原生 EventSource API 是浏览器专门为 SSE 优化的消费者，不受此限制。
 *
 * @module lib/http/utils/sse-sessions
 */

import { EventEmitter } from 'node:events';

/** Session 自动清理 TTL (5 分钟) */
const SESSION_TTL = 5 * 60 * 1000;

/** 完成后保留时间 (60 秒, 供客户端重连回放) */
const COMPLETED_KEEP = 60 * 1000;

/**
 * AD4 managed lifecycle: the session map and its timers live inside this
 * registry instead of bare module scope. Routes keep consuming the original
 * createStreamSession/getStreamSession functions, which delegate to a
 * lazily-created, disposable process-default registry. Per-connection
 * listener disposal stays at the route level (unsubscribe on stream:done /
 * stream:error and on res 'close' — verified in ai/candidates/modules).
 */
export class SseConnectionRegistry {
  #sessions = new Map<string, ReturnType<SseConnectionRegistry['create']>>();
  #timers = new Set<NodeJS.Timeout>();

  get size() {
    return this.#sessions.size;
  }

  get(sessionId: string) {
    return this.#sessions.get(sessionId);
  }

  /** 生命周期处置：清空 session 与所有挂起定时器 */
  clear() {
    for (const timer of this.#timers) {
      clearTimeout(timer);
    }
    this.#timers.clear();
    this.#sessions.clear();
  }

  #scheduleDelete(sessionId: string, delayMs: number) {
    const timer = setTimeout(() => {
      this.#sessions.delete(sessionId);
      this.#timers.delete(timer);
    }, delayMs);
    if (timer.unref) {
      timer.unref();
    }
    this.#timers.add(timer);
    return timer;
  }

  create(scene: string) {
    const sessions = this.#sessions;
    const scheduleDelete = (sessionId: string, delayMs: number) =>
      this.#scheduleDelete(sessionId, delayMs);

    const sessionId = `ss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const emitter = new EventEmitter();
    emitter.setMaxListeners(20);

    const session = {
      sessionId,
      scene,
      /** 事件缓冲区（供 EventSource 连接后回放） */
      buffer: [] as Record<string, unknown>[],
      /** 会话是否已结束 */
      completed: false,
      createdAt: Date.now(),

      /**
       * 缓冲 + 广播一个事件
       * @param event 必须包含 type 字段
       */
      send(event: Record<string, unknown>) {
        const payload = { ...event, ts: event.ts || Date.now() };
        session.buffer.push(payload);
        emitter.emit('event', payload);
      },

      /** 标记会话完成，发送 stream:done */
      end(donePayload: Record<string, unknown> = {}) {
        if (session.completed) {
          return;
        }
        const payload = { type: 'stream:done', ts: Date.now(), ...donePayload };
        session.buffer.push(payload);
        emitter.emit('event', payload);
        session.completed = true;
        // 完成后保留一段时间供客户端重连
        scheduleDelete(sessionId, COMPLETED_KEEP);
      },

      /** 标记会话错误，发送 stream:error */
      error(message: string, code: string) {
        if (session.completed) {
          return;
        }
        const payload = { type: 'stream:error', ts: Date.now(), message, code };
        session.buffer.push(payload);
        emitter.emit('event', payload);
        session.completed = true;
        scheduleDelete(sessionId, COMPLETED_KEEP);
      },

      /**
       * 订阅实时事件
       * @returns unsubscribe 函数
       */
      on(handler: (event: Record<string, unknown>) => void) {
        emitter.on('event', handler);
        return () => emitter.removeListener('event', handler);
      },
    };

    sessions.set(sessionId, session);

    // 硬性 TTL: 无论是否完成，5 分钟后强制清理
    this.#scheduleDelete(sessionId, SESSION_TTL);

    return session;
  }
}

let _defaultRegistry: SseConnectionRegistry | null = null;

/** Lazily-created process default — managed lifecycle, disposable. */
export function getDefaultSseConnectionRegistry(): SseConnectionRegistry {
  _defaultRegistry ??= new SseConnectionRegistry();
  return _defaultRegistry;
}

/** 重置默认注册表（测试/关停用） */
export function resetDefaultSseConnectionRegistry() {
  _defaultRegistry?.clear();
}

/**
 * 创建一个 stream session
 *
 * @param scene 场景标识
 */
export function createStreamSession(scene: string) {
  return getDefaultSseConnectionRegistry().create(scene);
}

/** 获取已有的 session */
export function getStreamSession(sessionId: string) {
  return getDefaultSseConnectionRegistry().get(sessionId);
}

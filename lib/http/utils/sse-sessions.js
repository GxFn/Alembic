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

/** @type {Map<string, StreamSession>} */
const _sessions = new Map();

/** Session 自动清理 TTL (5 分钟) */
const SESSION_TTL = 5 * 60 * 1000;

/** 完成后保留时间 (60 秒, 供客户端重连回放) */
const COMPLETED_KEEP = 60 * 1000;

/**
 * 创建一个 stream session
 *
 * @param {'chat'|'refine'} scene 场景标识
 * @returns {StreamSession}
 */
export function createStreamSession(scene) {
  const sessionId = `ss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const emitter = new EventEmitter();
  emitter.setMaxListeners(20);

  const session = {
    sessionId,
    scene,
    /** @type {Array<object>} 事件缓冲区（供 EventSource 连接后回放） */
    buffer: [],
    /** 会话是否已结束 */
    completed: false,
    createdAt: Date.now(),

    /**
     * 缓冲 + 广播一个事件
     * @param {object} event 必须包含 type 字段
     */
    send(event) {
      const payload = { ...event, ts: event.ts || Date.now() };
      session.buffer.push(payload);
      emitter.emit('event', payload);
    },

    /**
     * 标记会话完成，发送 stream:done
     * @param {object} [donePayload={}]
     */
    end(donePayload = {}) {
      if (session.completed) {
        return;
      }
      const payload = { type: 'stream:done', ts: Date.now(), ...donePayload };
      session.buffer.push(payload);
      emitter.emit('event', payload);
      session.completed = true;
      // 完成后保留一段时间供客户端重连
      const keepTimer = setTimeout(() => _sessions.delete(sessionId), COMPLETED_KEEP);
      if (keepTimer.unref) {
        keepTimer.unref();
      }
    },

    /**
     * 标记会话错误，发送 stream:error
     * @param {string} message
     * @param {string} [code]
     */
    error(message, code) {
      if (session.completed) {
        return;
      }
      const payload = { type: 'stream:error', ts: Date.now(), message, code };
      session.buffer.push(payload);
      emitter.emit('event', payload);
      session.completed = true;
      const keepTimer = setTimeout(() => _sessions.delete(sessionId), COMPLETED_KEEP);
      if (keepTimer.unref) {
        keepTimer.unref();
      }
    },

    /**
     * 订阅实时事件
     * @param {(event: object) => void} handler
     * @returns {() => void} unsubscribe 函数
     */
    on(handler) {
      emitter.on('event', handler);
      return () => emitter.removeListener('event', handler);
    },
  };

  _sessions.set(sessionId, session);

  // 硬性 TTL: 无论是否完成，5 分钟后强制清理
  const ttlTimer = setTimeout(() => _sessions.delete(sessionId), SESSION_TTL);
  if (ttlTimer.unref) {
    ttlTimer.unref();
  }

  return session;
}

/**
 * 获取已有的 session
 * @param {string} sessionId
 * @returns {StreamSession|undefined}
 */
export function getStreamSession(sessionId) {
  return _sessions.get(sessionId);
}

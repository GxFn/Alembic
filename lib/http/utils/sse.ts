/**
 * SSE (Server-Sent Events) 会话工具模块
 *
 * 提供统一的 SSE 连接管理：headers 设置、心跳保活、安全写入、生命周期事件。
 * 所有 SSE 端点共用此模块，确保协议一致性。
 *
 * @module lib/http/utils/sse
 */

/**
 * 创建 SSE 会话 — 统一设置 headers、心跳、安全写入
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {'chat'|'refine'} scene 场景标识
 * @returns {{ send, end, error, isDisconnected, sessionId }}
 */
export function createSSESession(req: any, res: any, scene: any) {
  // ─── SSE Headers ───
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // ─── 禁用 Nagle 算法，确保 SSE 小包即时发送 ───
  if (res.socket) {
    res.socket.setNoDelay(true);
    res.socket.setTimeout(0);
  }

  let disconnected = false;

  // 注意：必须监听 res.on('close') 而非 req.on('close')。
  // 在 Node.js 20 中，IncomingMessage (req) 的 'close' 事件在请求体被消费后即触发，
  // 而 ServerResponse (res) 的 'close' 事件仅在底层 socket 关闭时触发（即客户端真正断开连接）。
  res.on('close', () => {
    disconnected = true;
  });

  const sessionId = Math.random().toString(36).slice(2, 10);

  /** 安全写入一段 SSE 数据 */
  function _write(data: any) {
    if (disconnected || res.writableEnded) {
      return false;
    }
    try {
      return res.write(data);
    } catch {
      disconnected = true;
      return false;
    }
  }

  // ─── 心跳 (每 15 秒发送 SSE 注释保活) ───
  const heartbeat = setInterval(() => {
    _write(`: ping ${Date.now()}\n\n`);
  }, 15_000);

  // ─── 发送 stream:start ───
  const startPayload = JSON.stringify({ type: 'stream:start', ts: Date.now(), sessionId, scene });
  _write(`data: ${startPayload}\n\n`);

  // ─── 性能跟踪 ───
  const metrics = {
    startTime: Date.now(),
    eventCount: 0,
    totalBytes: 0,
    firstTextDeltaTime: 0,
  };

  return {
    /**
     * 发送一个 SSE 事件
     * @param {object} event 必须包含 type 字段
     */
    send(event: any) {
      if (disconnected || res.writableEnded) {
        return;
      }
      const payload = JSON.stringify({ ...event, ts: event.ts || Date.now() });
      _write(`data: ${payload}\n\n`);
      metrics.eventCount++;
      metrics.totalBytes += payload.length;
      if (event.type === 'text:delta' && !metrics.firstTextDeltaTime) {
        metrics.firstTextDeltaTime = Date.now();
      }
    },

    /**
     * 正常结束流 — 发送 stream:done 并关闭连接
     * @param {object} [donePayload={}] - done 事件携带的额外数据
     */
    end(donePayload: any = {}) {
      clearInterval(heartbeat);
      if (disconnected || res.writableEnded) {
        return;
      }
      const payload = JSON.stringify({ type: 'stream:done', ts: Date.now(), ...donePayload });
      _write(`data: ${payload}\n\n`);
      res.end();
    },

    /**
     * 发送错误并结束流
     * @param {string} message
     * @param {string} [code]
     */
    error(message: any, code: any) {
      clearInterval(heartbeat);
      if (disconnected || res.writableEnded) {
        return;
      }
      const payload = JSON.stringify({ type: 'stream:error', ts: Date.now(), message, code });
      _write(`data: ${payload}\n\n`);
      res.end();
    },

    /** 是否已断开 */
    get isDisconnected() {
      return disconnected;
    },

    /** 会话 ID */
    sessionId,

    /** 获取性能指标 */
    get metrics() {
      return {
        ...metrics,
        endTime: Date.now(),
        duration: Date.now() - metrics.startTime,
        ttft: metrics.firstTextDeltaTime ? metrics.firstTextDeltaTime - metrics.startTime : null,
      };
    },
  };
}

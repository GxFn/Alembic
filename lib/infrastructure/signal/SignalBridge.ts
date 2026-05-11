/**
 * SignalBridge — SignalBus → EventBus 单点桥接
 *
 * 将 SignalBus 信号转发到 EventBus，实现 SignalBus 纯内核化。
 * HttpServer 等端口层只需监听 EventBus，不再直接消费 SignalBus。
 *
 * @module infrastructure/signal/SignalBridge
 */

import type { EventBus } from '../event/EventBus.js';
import type { SignalBus } from './SignalBus.js';

export class SignalBridge {
  constructor(signalBus: SignalBus, eventBus: EventBus) {
    // 全量转发
    signalBus.subscribe('*', (signal) => {
      eventBus.emit('signal:event', signal);
    });
    // Guard 专用通道
    signalBus.subscribe('guard', (signal) => {
      eventBus.emit('guard:updated', signal);
    });
  }
}

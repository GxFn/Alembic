/**
 * SignalModule — Phase 0 信号基础设施注册
 *
 * 注册:
 *   - signalBus:   统一信号总线（基础设施层）
 *   - hitRecorder:  批量使用信号采集器（服务层）
 */

import { SignalBus } from '../../infrastructure/signal/SignalBus.js';
import { HitRecorder } from '../../service/signal/HitRecorder.js';
import { shutdown } from '../../shared/shutdown.js';
import type { ServiceContainer } from '../ServiceContainer.js';

export function register(c: ServiceContainer) {
  // ═══ Infrastructure ═══

  c.singleton('signalBus', () => new SignalBus());

  // ═══ Service ═══

  c.singleton('hitRecorder', (ct: ServiceContainer) => {
    const bus = ct.get('signalBus');
    const db = ct.get('database');
    const recorder = new HitRecorder(bus, db);
    recorder.start();

    // shutdown hook: 在 DB close 之前 flush buffer
    shutdown.register(async () => {
      await recorder.stop();
    }, 'hitRecorder');

    return recorder;
  });
}

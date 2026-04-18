/**
 * SignalModule — Phase 0 信号基础设施注册
 *
 * 注册:
 *   - signalBus:   统一信号总线（基础设施层）
 *   - hitRecorder:  批量使用信号采集器（服务层）
 *   - intent JSONL persistence subscriber
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ReportStore } from '../../infrastructure/report/ReportStore.js';
import { SignalAggregator } from '../../infrastructure/signal/SignalAggregator.js';
import { SignalBridge } from '../../infrastructure/signal/SignalBridge.js';
import type { Signal } from '../../infrastructure/signal/SignalBus.js';
import { SignalBus } from '../../infrastructure/signal/SignalBus.js';
import { SignalTraceWriter } from '../../infrastructure/signal/SignalTraceWriter.js';
import { HitRecorder } from '../../service/signal/HitRecorder.js';
import { resolveDataRoot } from '../../shared/resolveProjectRoot.js';
import { shutdown } from '../../shared/shutdown.js';
import type { ServiceContainer } from '../ServiceContainer.js';

/**
 * Register intent signal subscriber for JSONL persistence.
 * Replaces standalone SignalLogger — writes IntentChainRecord to .asd/logs/signals/YYYY-MM-DD.jsonl.
 */
function registerIntentPersistence(
  signalBus: SignalBus,
  projectRoot: string,
  writeZone?: import('../../infrastructure/io/WriteZone.js').WriteZone
): void {
  signalBus.subscribe('intent', (signal: Signal) => {
    try {
      const chain = signal.metadata?.chain;
      if (!chain) {
        return;
      }
      const line = `${JSON.stringify(chain)}\n`;
      const d = new Date(signal.timestamp);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

      if (writeZone) {
        const target = writeZone.runtime(`logs/signals/${dateStr}.jsonl`);
        writeZone.ensureDir(writeZone.runtime('logs/signals'));
        writeZone.appendFile(target, line);
      } else {
        const dir = path.join(projectRoot, '.asd', 'logs', 'signals');
        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, `${dateStr}.jsonl`);
        fs.appendFileSync(filePath, line, 'utf8');
      }
    } catch {
      // Write failure is non-blocking
    }
  });
}

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

  // ═══ Intent Signal Persistence ═══

  // Register after signalBus is created — subscribe for JSONL persistence
  const signalBus = c.get('signalBus');
  const dataRoot = resolveDataRoot(c);
  const wz = c.get('writeZone') as import('../../infrastructure/io/WriteZone.js').WriteZone;
  registerIntentPersistence(signalBus, dataRoot, wz);

  // ═══ SignalBridge — SignalBus → EventBus 桥接 ═══

  c.singleton('signalBridge', (ct: ServiceContainer) => {
    const bus = ct.get('signalBus') as SignalBus;
    const eventBus = ct.get(
      'eventBus'
    ) as import('../../infrastructure/event/EventBus.js').EventBus;
    return new SignalBridge(bus, eventBus);
  });

  // ═══ SignalTraceWriter — 全类型信号 JSONL 留痕 ═══

  c.singleton('signalTraceWriter', (ct: ServiceContainer) => {
    const bus = ct.get('signalBus') as SignalBus;
    const root = resolveDataRoot(ct);
    const wz = ct.get('writeZone') as import('../../infrastructure/io/WriteZone.js').WriteZone;
    return new SignalTraceWriter(bus, path.join(root, '.asd', 'logs', 'signals'), wz);
  });

  // ═══ SignalAggregator — 滑窗统计 + 异常检测 ═══

  c.singleton('signalAggregator', (ct: ServiceContainer) => {
    const bus = ct.get('signalBus') as SignalBus;
    const reportStore = ct.get('reportStore') as ReportStore;
    const agg = new SignalAggregator(bus, reportStore);
    agg.start();

    shutdown.register(async () => {
      agg.stop();
    }, 'signalAggregator');

    return agg;
  });
}

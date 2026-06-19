/**
 * SignalModule — Phase 0 信号基础设施注册
 *
 * 注册:
 *   - signalBus:   统一信号总线（基础设施层）
 *   - signalBridge / signalTraceWriter / signalAggregator
 */

import path from 'node:path';
import { SignalAggregator, SignalBridge, SignalBus, SignalTraceWriter } from '@alembic/core/events';
import type { ReportStore } from '@alembic/core/report';
import { resolveDataRoot } from '@alembic/core/workspace';
import { shutdown } from '../../shared/shutdown.js';
import type { ServiceContainer } from '../ServiceContainer.js';

export function register(c: ServiceContainer) {
  // ═══ Infrastructure ═══

  c.singleton('signalBus', () => new SignalBus());

  // ═══ SignalBridge — SignalBus → EventBus 桥接 ═══

  c.singleton('signalBridge', (ct: ServiceContainer) => {
    const bus = ct.get('signalBus') as unknown as ConstructorParameters<typeof SignalBridge>[0];
    const eventBus = ct.get('eventBus') as unknown as ConstructorParameters<typeof SignalBridge>[1];
    return new SignalBridge(bus, eventBus);
  });

  // ═══ SignalTraceWriter — 全类型信号 JSONL 留痕 ═══

  c.singleton('signalTraceWriter', (ct: ServiceContainer) => {
    const bus = ct.get('signalBus') as unknown as ConstructorParameters<
      typeof SignalTraceWriter
    >[0];
    const root = resolveDataRoot(ct);
    const wz = ct.get('writeZone') as import('@alembic/core/io').WriteZone | null;
    return new SignalTraceWriter(bus, path.join(root, '.asd', 'logs', 'signals'), wz ?? undefined);
  });

  // ═══ SignalAggregator — 滑窗统计 + 异常检测 ═══

  c.singleton('signalAggregator', (ct: ServiceContainer) => {
    const bus = ct.get('signalBus') as unknown as ConstructorParameters<typeof SignalAggregator>[0];
    const reportStore = ct.get('reportStore') as ReportStore;
    const agg = new SignalAggregator(bus, reportStore);
    agg.start();

    shutdown.register(async () => {
      agg.stop();
    }, 'signalAggregator');

    return agg;
  });
}

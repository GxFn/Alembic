/**
 * SignalAggregator — 滑窗统计 + 异常检测
 *
 * 订阅可聚合的事实型信号，周期性写入 Report（统计）并在异常时发射 Signal。
 *
 * @module infrastructure/signal/SignalAggregator
 */

import type { ReportStore } from '../report/ReportStore.js';
import type { Signal, SignalBus } from './SignalBus.js';

interface SlidingWindow {
  entries: Array<{ value: number; ts: number }>;
  baseline: number;
}

export class SignalAggregator {
  readonly #bus: SignalBus;
  readonly #reportStore: ReportStore;
  readonly #windows: Map<string, SlidingWindow> = new Map();
  readonly #intervalMs: number;
  readonly #windowMs: number;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    signalBus: SignalBus,
    reportStore: ReportStore,
    opts: { intervalMs?: number; windowMs?: number } = {}
  ) {
    this.#bus = signalBus;
    this.#reportStore = reportStore;
    this.#intervalMs = opts.intervalMs ?? 60_000;
    this.#windowMs = opts.windowMs ?? 300_000;

    // 订阅可聚合的事实型信号
    signalBus.subscribe('guard|search|usage|lifecycle|forge|decay|quality', (signal) => {
      this.#record(signal);
    });
  }

  start(): void {
    if (this.#timer) {
      return;
    }
    this.#timer = setInterval(() => {
      void this.#flush();
    }, this.#intervalMs);
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  #record(signal: Signal): void {
    const key = signal.type;
    if (!this.#windows.has(key)) {
      this.#windows.set(key, { entries: [], baseline: 0 });
    }
    const win = this.#windows.get(key)!;
    win.entries.push({ value: signal.value, ts: signal.timestamp });
  }

  async #flush(): Promise<void> {
    const now = Date.now();
    for (const [type, win] of this.#windows) {
      // 清理过期条目
      win.entries = win.entries.filter((e) => now - e.ts < this.#windowMs);
      if (win.entries.length === 0) {
        continue;
      }

      const count = win.entries.length;
      const avg = win.entries.reduce((s, e) => s + e.value, 0) / count;
      const max = Math.max(...win.entries.map((e) => e.value));
      const min = Math.min(...win.entries.map((e) => e.value));

      // 周期统计 → Report
      await this.#reportStore.write({
        category: 'metrics',
        type: `aggregate_${type}`,
        producer: 'SignalAggregator',
        data: {
          window: `${this.#windowMs / 1000}s`,
          count,
          avg,
          max,
          min,
          baseline: win.baseline,
        },
        timestamp: now,
      });

      // 异常检测 → Signal（信号量突增 3 倍）
      if (win.baseline > 0 && count > win.baseline * 3) {
        this.#bus.send('anomaly', `Aggregator.${type}`, 1, {
          metadata: { reason: 'spike', count, baseline: win.baseline },
        });
      }

      // 更新 baseline（指数移动平均）
      win.baseline = win.baseline === 0 ? count : win.baseline * 0.8 + count * 0.2;
    }
  }
}

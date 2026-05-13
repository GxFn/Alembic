/**
 * DaemonFileChangeCollector — compatibility entry for the Codex plugin daemon monitor.
 *
 * The old implementation was a VSCode-heartbeat-gated fallback poller. The Codex
 * plugin path now owns its daemon monitor directly through CodeChangeMonitor:
 * chokidar for live file events plus Git reconciliation for correctness.
 */

import type { FileChangeDispatcher } from '../FileChangeDispatcher.js';
import { CodeChangeMonitor } from './code-change-monitor/CodeChangeMonitor.js';
import type { CodeChangeMonitorStatus } from './code-change-monitor/CodeChangeMonitorStatus.js';

export interface DaemonFileChangeCollectorOptions {
  dispatcher: FileChangeDispatcher;
  eventReconcileDelayMs?: number;
  intervalMs?: number;
  logger?: ConstructorParameters<typeof CodeChangeMonitor>[0]['logger'];
  projectRoot: string;
  watcherReadyTimeoutMs?: number;
}

export class DaemonFileChangeCollector {
  readonly #monitor: CodeChangeMonitor;

  constructor(options: DaemonFileChangeCollectorOptions) {
    this.#monitor = new CodeChangeMonitor({
      dispatcher: options.dispatcher,
      eventReconcileDelayMs: options.eventReconcileDelayMs,
      logger: options.logger,
      projectRoot: options.projectRoot,
      reconcileIntervalMs: options.intervalMs,
      watcherReadyTimeoutMs: options.watcherReadyTimeoutMs,
    });
  }

  start(): Promise<void> {
    return this.#monitor.start();
  }

  stop(): Promise<void> {
    return this.#monitor.stop();
  }

  scanOnce(now = Date.now()): Promise<void> {
    return this.#monitor.scanOnce(now);
  }

  getStatus(): CodeChangeMonitorStatus {
    return this.#monitor.getStatus();
  }
}

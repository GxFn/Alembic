/**
 * DaemonFileChangeCollector — compatibility entry for the Codex plugin daemon monitor.
 *
 * The old implementation was a VSCode-heartbeat-gated fallback poller. The Codex
 * plugin path now owns its daemon monitor directly through CodeChangeMonitor:
 * chokidar for live file events plus Git reconciliation for correctness.
 */

import type { FileChangeDispatcher } from '../FileChangeDispatcher.js';
import { CodeChangeMonitor } from './code-change-monitor/CodeChangeMonitor.js';
import type { CodeChangeMonitorTuningOptions } from './code-change-monitor/CodeChangeMonitorConfig.js';
import type { CodeChangeMonitorStatus } from './code-change-monitor/CodeChangeMonitorStatus.js';

export interface DaemonFileChangeCollectorOptions extends CodeChangeMonitorTuningOptions {
  dispatcher: FileChangeDispatcher;
  logger?: ConstructorParameters<typeof CodeChangeMonitor>[0]['logger'];
  projectRoot: string;
}

export class DaemonFileChangeCollector {
  readonly #monitor: CodeChangeMonitor;

  constructor(options: DaemonFileChangeCollectorOptions) {
    this.#monitor = new CodeChangeMonitor({
      dispatchDebounceMs: options.dispatchDebounceMs,
      dispatchMaxBatchSize: options.dispatchMaxBatchSize,
      dispatcher: options.dispatcher,
      eventDedupeCooldownMs: options.eventDedupeCooldownMs,
      gitPollIntervalMs: options.gitPollIntervalMs,
      logger: options.logger,
      projectRoot: options.projectRoot,
      watcherReadyTimeoutMs: options.watcherReadyTimeoutMs,
      watchSettleMs: options.watchSettleMs,
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

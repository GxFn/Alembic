import { existsSync } from 'node:fs';
import Logger from '../../../infrastructure/logging/Logger.js';
import { timerRegistry } from '../../../shared/TimerRegistry.js';
import type { FileChangeEvent } from '../../../types/reactive-evolution.js';
import type { FileChangeDispatcher } from '../../FileChangeDispatcher.js';
import { ChokidarProjectWatcher } from './ChokidarProjectWatcher.js';
import {
  type CodeChangeMonitorResolvedTuning,
  type CodeChangeMonitorTuningOptions,
  resolveCodeChangeMonitorTuning,
} from './CodeChangeMonitorConfig.js';
import {
  type CodeChangeMonitorError,
  type CodeChangeMonitorErrorCode,
  type CodeChangeMonitorStatus,
  type CodeChangeReconcilerStatus,
  type CodeChangeWatcherStatus,
  createInactiveCodeChangeMonitorStatus,
} from './CodeChangeMonitorStatus.js';
import { FileChangeEventBuffer } from './FileChangeEventBuffer.js';
import {
  GitWorktreeReconciler,
  type GitWorktreeScanOptions,
  type GitWorktreeScanResult,
} from './GitWorktreeReconciler.js';
import { normalizeProjectRelativePath, shouldIgnoreProjectPath } from './ProjectWatchIgnore.js';

const MAX_ERRORS = 10;

type AppLogger = ReturnType<typeof Logger.getInstance>;
type TimerHandle = ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;
type WatcherFactoryOptions = ConstructorParameters<typeof ChokidarProjectWatcher>[0];

export interface CodeChangeMonitorWatcher {
  getStatus(): CodeChangeWatcherStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface CodeChangeMonitorReconciler {
  getStatus(): CodeChangeReconcilerStatus;
  scanOnce(now?: number, options?: GitWorktreeScanOptions): Promise<GitWorktreeScanResult>;
}

export interface CodeChangeMonitorDependencies {
  reconciler?: CodeChangeMonitorReconciler;
  watcherFactory?: (options: WatcherFactoryOptions) => CodeChangeMonitorWatcher;
}

export interface CodeChangeMonitorOptions extends CodeChangeMonitorTuningOptions {
  dependencies?: CodeChangeMonitorDependencies;
  dispatcher: FileChangeDispatcher;
  logger?: Pick<AppLogger, 'debug' | 'info' | 'warn'>;
  projectRoot: string;
}

export class CodeChangeMonitor {
  readonly #buffer: FileChangeEventBuffer;
  readonly #logger: Pick<AppLogger, 'debug' | 'info' | 'warn'>;
  readonly #projectRoot: string;
  readonly #reconciler: CodeChangeMonitorReconciler;
  readonly #tuning: CodeChangeMonitorResolvedTuning;
  readonly #watcher: CodeChangeMonitorWatcher;

  #active = false;
  #disposed = false;
  #errors: CodeChangeMonitorError[] = [];
  #pendingWatchPaths = new Set<string>();
  #periodicReconcileTimer: TimerHandle | null = null;
  #pendingReconcileTimer: TimerHandle | null = null;
  #runningReconcile = false;
  #startReason: string | null = null;

  constructor(options: CodeChangeMonitorOptions) {
    this.#logger = options.logger ?? Logger.getInstance();
    this.#projectRoot = options.projectRoot;
    this.#tuning = resolveCodeChangeMonitorTuning(options);
    this.#buffer = new FileChangeEventBuffer({
      debounceMs: this.#tuning.dispatchDebounceMs,
      dispatch: (events) => options.dispatcher.dispatch(events),
      eventDedupeCooldownMs: this.#tuning.eventDedupeCooldownMs,
      ignorePath: shouldIgnoreProjectPath,
      logger: this.#logger,
      maxBatchSize: this.#tuning.dispatchMaxBatchSize,
      onDispatchError: (error) => {
        this.#recordError('DISPATCH_FAILED', error.message);
      },
    });
    this.#reconciler =
      options.dependencies?.reconciler ??
      new GitWorktreeReconciler({
        logger: this.#logger,
        projectRoot: this.#projectRoot,
      });
    const watcherFactory =
      options.dependencies?.watcherFactory ??
      ((watcherOptions) => new ChokidarProjectWatcher(watcherOptions));
    this.#watcher = watcherFactory({
      logger: this.#logger,
      onError: (error) => {
        const code = classifyWatcherError(error);
        this.#recordError(code, error.message);
        if (code === 'WATCHER_RESOURCE_LIMIT') {
          this.#scheduleWatchHintReconciliation();
        }
      },
      onEvent: (event) => {
        if (this.#isGitSourceOfTruthReady()) {
          this.#queueWatchHint(event);
          this.#scheduleWatchHintReconciliation();
          return;
        }
        this.#buffer.push(event);
        this.#scheduleWatchHintReconciliation();
      },
      projectRoot: this.#projectRoot,
      fallbackToPolling: this.#tuning.watcherFallbackToPolling,
      pollingIntervalMs: this.#tuning.watcherPollingIntervalMs,
      readyTimeoutMs: this.#tuning.watcherReadyTimeoutMs,
      usePolling: this.#tuning.watcherUsePolling,
    });
  }

  async start(): Promise<void> {
    if (this.#disposed || this.#active) {
      return;
    }
    if (!existsSync(this.#projectRoot)) {
      this.#recordError(
        'PROJECT_ROOT_UNRESOLVED',
        `Project root does not exist: ${this.#projectRoot}`
      );
      this.#startReason = 'project root does not exist';
      return;
    }

    this.#active = true;
    this.#startReason = null;
    await this.scanOnce();
    try {
      await this.#watcher.start();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.#recordError('WATCHER_START_FAILED', message);
    }
    this.#periodicReconcileTimer = timerRegistry.setInterval(
      () => {
        void this.scanOnce();
      },
      this.#tuning.gitPollIntervalMs,
      'CodeChangeMonitor/git-reconcile'
    );
    this.#logger.info('[code-change-monitor] started', {
      projectRoot: this.#projectRoot,
      tuning: this.#tuning,
    });
  }

  async stop(): Promise<void> {
    this.#disposed = true;
    this.#active = false;
    if (this.#periodicReconcileTimer) {
      timerRegistry.clear(this.#periodicReconcileTimer);
      this.#periodicReconcileTimer = null;
    }
    if (this.#pendingReconcileTimer) {
      timerRegistry.clear(this.#pendingReconcileTimer);
      this.#pendingReconcileTimer = null;
    }
    this.#pendingWatchPaths.clear();
    await this.#buffer.dispose();
    await this.#watcher.stop();
  }

  async scanOnce(now = Date.now(), options: GitWorktreeScanOptions = {}): Promise<void> {
    if (this.#disposed || this.#runningReconcile) {
      return;
    }
    this.#runningReconcile = true;
    try {
      const result = await this.#reconciler.scanOnce(now, options);
      const bypassCooldown = Boolean(options.forcePaths?.length);
      for (const event of result.events) {
        this.#buffer.push(event, { bypassCooldown });
      }
      if (result.events.length > 0) {
        await this.#buffer.flushNow();
      }
    } finally {
      this.#runningReconcile = false;
    }
  }

  getStatus(): CodeChangeMonitorStatus {
    const watcher = this.#watcher.getStatus();
    const reconciler = this.#reconciler.getStatus();
    const gitSourceOfTruth = this.#isGitSourceOfTruthReady();
    const healthy = this.#active && watcher.healthy && reconciler.healthy;
    return {
      active: this.#active,
      enabled: true,
      errors: [...this.#errors],
      healthy,
      lastDispatch: this.#buffer.getLastDispatch(),
      mode: 'daemon-chokidar-git',
      pipeline: {
        gitSourceOfTruth,
        mode: 'watch-hints-git-truth',
        pendingWatchPathCount: this.#pendingWatchPaths.size,
      },
      projectRoot: this.#projectRoot,
      reason: this.#startReason,
      reconciler,
      surface: 'codex-plugin',
      tuning: { ...this.#tuning },
      watcher,
    };
  }

  #scheduleWatchHintReconciliation(): void {
    if (this.#pendingReconcileTimer) {
      return;
    }
    this.#pendingReconcileTimer = timerRegistry.setTimeout(
      () => {
        this.#pendingReconcileTimer = null;
        void this.#runScheduledReconciliation();
      },
      this.#tuning.watchSettleMs,
      'CodeChangeMonitor/event-reconcile'
    );
  }

  async #runScheduledReconciliation(): Promise<void> {
    if (this.#runningReconcile) {
      this.#scheduleWatchHintReconciliation();
      return;
    }
    const forcePaths = this.#consumePendingWatchPaths();
    await this.scanOnce(Date.now(), forcePaths.length > 0 ? { forcePaths } : {});
  }

  #recordError(code: CodeChangeMonitorErrorCode, message: string): void {
    const previousError = this.#errors.at(-1);
    if (previousError?.code === code && previousError.message === message) {
      return;
    }
    this.#errors.push({
      at: new Date().toISOString(),
      code,
      message,
    });
    if (this.#errors.length > MAX_ERRORS) {
      this.#errors = this.#errors.slice(-MAX_ERRORS);
    }
    this.#logger.warn('[code-change-monitor] error', { code, message });
  }

  #isGitSourceOfTruthReady(): boolean {
    const status = this.#reconciler.getStatus();
    return status.backend === 'git' && status.baselineReady && status.healthy;
  }

  #queueWatchHint(event: FileChangeEvent): void {
    this.#queueOneWatchHintPath(event.path);
    if (event.oldPath) {
      this.#queueOneWatchHintPath(event.oldPath);
    }
  }

  #queueOneWatchHintPath(filePath: string): void {
    const normalizedPath = normalizeProjectRelativePath(filePath);
    if (!normalizedPath || shouldIgnoreProjectPath(normalizedPath)) {
      return;
    }
    this.#pendingWatchPaths.add(normalizedPath);
  }

  #consumePendingWatchPaths(): string[] {
    const paths = [...this.#pendingWatchPaths];
    this.#pendingWatchPaths.clear();
    return paths;
  }
}

export function createInactiveMonitorStatus(
  projectRoot: string,
  reason: string | null,
  enabled = true
): CodeChangeMonitorStatus {
  return createInactiveCodeChangeMonitorStatus(projectRoot, reason, enabled);
}

function classifyWatcherError(error: Error): CodeChangeMonitorErrorCode {
  const code = (error as { code?: unknown }).code;
  if (code === 'EMFILE' || code === 'ENOSPC') {
    return 'WATCHER_RESOURCE_LIMIT';
  }
  return 'WATCHER_START_FAILED';
}

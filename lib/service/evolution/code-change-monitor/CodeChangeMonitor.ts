import { existsSync } from 'node:fs';
import Logger from '../../../infrastructure/logging/Logger.js';
import { timerRegistry } from '../../../shared/TimerRegistry.js';
import type { FileChangeDispatcher } from '../../FileChangeDispatcher.js';
import { ChokidarProjectWatcher } from './ChokidarProjectWatcher.js';
import {
  type CodeChangeMonitorError,
  type CodeChangeMonitorErrorCode,
  type CodeChangeMonitorStatus,
  createInactiveCodeChangeMonitorStatus,
} from './CodeChangeMonitorStatus.js';
import { FileChangeEventBuffer } from './FileChangeEventBuffer.js';
import { GitWorktreeReconciler } from './GitWorktreeReconciler.js';
import { shouldIgnoreProjectPath } from './ProjectWatchIgnore.js';

const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;
const DEFAULT_EVENT_RECONCILE_DELAY_MS = 5000;
const MAX_ERRORS = 10;

type AppLogger = ReturnType<typeof Logger.getInstance>;
type TimerHandle = ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;

export interface CodeChangeMonitorOptions {
  dispatcher: FileChangeDispatcher;
  eventReconcileDelayMs?: number;
  logger?: Pick<AppLogger, 'debug' | 'info' | 'warn'>;
  projectRoot: string;
  reconcileIntervalMs?: number;
  watcherReadyTimeoutMs?: number;
}

export class CodeChangeMonitor {
  readonly #buffer: FileChangeEventBuffer;
  readonly #eventReconcileDelayMs: number;
  readonly #logger: Pick<AppLogger, 'debug' | 'info' | 'warn'>;
  readonly #projectRoot: string;
  readonly #reconcileIntervalMs: number;
  readonly #reconciler: GitWorktreeReconciler;
  readonly #watcher: ChokidarProjectWatcher;

  #active = false;
  #disposed = false;
  #errors: CodeChangeMonitorError[] = [];
  #periodicReconcileTimer: TimerHandle | null = null;
  #pendingReconcileTimer: TimerHandle | null = null;
  #runningReconcile = false;
  #startReason: string | null = null;

  constructor(options: CodeChangeMonitorOptions) {
    this.#logger = options.logger ?? Logger.getInstance();
    this.#projectRoot = options.projectRoot;
    this.#reconcileIntervalMs = normalizePositiveInt(
      options.reconcileIntervalMs,
      DEFAULT_RECONCILE_INTERVAL_MS
    );
    this.#eventReconcileDelayMs = normalizePositiveInt(
      options.eventReconcileDelayMs,
      DEFAULT_EVENT_RECONCILE_DELAY_MS
    );
    this.#buffer = new FileChangeEventBuffer({
      dispatch: (events) => options.dispatcher.dispatch(events),
      ignorePath: shouldIgnoreProjectPath,
      logger: this.#logger,
      onDispatchError: (error) => {
        this.#recordError('DISPATCH_FAILED', error.message);
      },
    });
    this.#reconciler = new GitWorktreeReconciler({
      logger: this.#logger,
      projectRoot: this.#projectRoot,
    });
    this.#watcher = new ChokidarProjectWatcher({
      logger: this.#logger,
      onEvent: (event) => {
        this.#buffer.push(event);
        this.#scheduleEventReconciliation();
      },
      projectRoot: this.#projectRoot,
      readyTimeoutMs: options.watcherReadyTimeoutMs,
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
      this.#reconcileIntervalMs,
      'CodeChangeMonitor/git-reconcile'
    );
    this.#logger.info('[code-change-monitor] started', {
      projectRoot: this.#projectRoot,
      reconcileIntervalMs: this.#reconcileIntervalMs,
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
    await this.#buffer.dispose();
    await this.#watcher.stop();
  }

  async scanOnce(now = Date.now()): Promise<void> {
    if (this.#disposed || this.#runningReconcile) {
      return;
    }
    this.#runningReconcile = true;
    try {
      const result = await this.#reconciler.scanOnce(now);
      for (const event of result.events) {
        this.#buffer.push(event);
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
    const healthy = this.#active && watcher.healthy && reconciler.healthy;
    return {
      active: this.#active,
      enabled: true,
      errors: [...this.#errors],
      healthy,
      lastDispatch: this.#buffer.getLastDispatch(),
      mode: 'daemon-chokidar-git',
      projectRoot: this.#projectRoot,
      reason: this.#startReason,
      reconciler,
      surface: 'codex-plugin',
      watcher,
    };
  }

  #scheduleEventReconciliation(): void {
    if (this.#pendingReconcileTimer) {
      return;
    }
    this.#pendingReconcileTimer = timerRegistry.setTimeout(
      () => {
        this.#pendingReconcileTimer = null;
        void this.scanOnce();
      },
      this.#eventReconcileDelayMs,
      'CodeChangeMonitor/event-reconcile'
    );
  }

  #recordError(code: CodeChangeMonitorErrorCode, message: string): void {
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
}

export function createInactiveMonitorStatus(
  projectRoot: string,
  reason: string | null,
  enabled = true
): CodeChangeMonitorStatus {
  return createInactiveCodeChangeMonitorStatus(projectRoot, reason, enabled);
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

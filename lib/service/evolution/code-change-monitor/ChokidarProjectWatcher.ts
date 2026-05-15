import { realpathSync } from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import Logger from '../../../infrastructure/logging/Logger.js';
import type { FileChangeEvent } from '../../../types/reactive-evolution.js';
import { DEFAULT_CODE_CHANGE_MONITOR_TUNING } from './CodeChangeMonitorConfig.js';
import type { CodeChangeWatcherStatus } from './CodeChangeMonitorStatus.js';
import {
  isSafeProjectRelativePath,
  normalizeProjectRelativePath,
  shouldIgnoreProjectPath,
  toProjectRelativePath,
} from './ProjectWatchIgnore.js';

type AppLogger = ReturnType<typeof Logger.getInstance>;

export interface ChokidarProjectWatcherOptions {
  fallbackToPolling?: boolean;
  logger?: Pick<AppLogger, 'warn'>;
  onError?: (error: Error) => void;
  onEvent: (event: FileChangeEvent) => void;
  pollingIntervalMs?: number;
  projectRoot: string;
  readyTimeoutMs?: number;
  usePolling?: boolean;
}

export class ChokidarProjectWatcher {
  readonly #logger: Pick<AppLogger, 'warn'>;
  readonly #canonicalProjectRoot: string;
  readonly #fallbackToPolling: boolean;
  readonly #onError: (error: Error) => void;
  readonly #onEvent: (event: FileChangeEvent) => void;
  readonly #pollingIntervalMs: number;
  readonly #projectRoot: string;
  readonly #readyTimeoutMs: number;

  #fallbackInProgress = false;
  #lastNativeResourceError: Error | null = null;
  #mode: CodeChangeWatcherStatus['mode'];
  #status: CodeChangeWatcherStatus = {
    backend: 'chokidar',
    healthy: false,
    lastError: null,
    lastEventAt: null,
    mode: 'native',
    ready: false,
    watchedDirectoryCount: 0,
  };
  #watcher: FSWatcher | null = null;

  constructor(options: ChokidarProjectWatcherOptions) {
    this.#fallbackToPolling =
      options.fallbackToPolling ?? DEFAULT_CODE_CHANGE_MONITOR_TUNING.watcherFallbackToPolling;
    this.#logger = options.logger ?? Logger.getInstance();
    this.#onError = options.onError ?? (() => {});
    this.#onEvent = options.onEvent;
    this.#pollingIntervalMs =
      options.pollingIntervalMs ?? DEFAULT_CODE_CHANGE_MONITOR_TUNING.watcherPollingIntervalMs;
    this.#projectRoot = options.projectRoot;
    this.#canonicalProjectRoot = safeRealpath(options.projectRoot);
    this.#readyTimeoutMs =
      options.readyTimeoutMs ?? DEFAULT_CODE_CHANGE_MONITOR_TUNING.watcherReadyTimeoutMs;
    this.#mode = options.usePolling ? 'polling' : 'native';
    this.#status = {
      ...this.#status,
      mode: this.#mode,
    };
  }

  async start(): Promise<void> {
    if (this.#watcher) {
      return;
    }

    await this.#startMode(this.#mode);
    if (this.#shouldFallbackToPolling()) {
      await this.#restartWithPolling();
    }
  }

  async #startMode(mode: CodeChangeWatcherStatus['mode']): Promise<void> {
    this.#lastNativeResourceError = null;
    this.#mode = mode;
    const watcher = chokidar.watch('.', {
      atomic: true,
      awaitWriteFinish: {
        pollInterval: 100,
        stabilityThreshold: 750,
      },
      cwd: this.#projectRoot,
      ignoreInitial: true,
      ignored: (filePath) => shouldIgnoreProjectPath(this.#toRelativePath(filePath)),
      interval: this.#pollingIntervalMs,
      persistent: true,
      usePolling: mode === 'polling',
    });
    this.#watcher = watcher;
    this.#status = {
      ...this.#status,
      healthy: false,
      lastError: null,
      mode,
      ready: false,
      watchedDirectoryCount: 0,
    };

    watcher.on('all', (eventName, filePath) => {
      this.#handleEvent(eventName, filePath);
    });
    watcher.on('error', (error) => {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      const message = normalizedError.message;
      this.#logger.warn('[code-change-monitor] chokidar watcher error', { error: message });
      this.#onError(normalizedError);
      if (mode === 'native' && isWatcherResourceLimitError(normalizedError)) {
        this.#lastNativeResourceError = normalizedError;
        if (this.#status.ready) {
          void this.#restartWithPolling();
        }
      }
      this.#status = {
        ...this.#status,
        healthy: false,
        lastError: message,
      };
    });
    watcher.on('ready', () => {
      this.#status = {
        ...this.#status,
        healthy: true,
        lastError: null,
        mode,
        ready: true,
        watchedDirectoryCount: countWatchedDirectories(watcher),
      };
    });

    await this.#waitUntilReady();
  }

  async stop(): Promise<void> {
    const watcher = this.#watcher;
    this.#watcher = null;
    if (!watcher) {
      return;
    }
    await watcher.close();
    this.#status = {
      ...this.#status,
      healthy: false,
      ready: false,
      watchedDirectoryCount: 0,
    };
  }

  getStatus(): CodeChangeWatcherStatus {
    const watcher = this.#watcher;
    return {
      ...this.#status,
      watchedDirectoryCount: watcher ? countWatchedDirectories(watcher) : 0,
    };
  }

  #shouldFallbackToPolling(): boolean {
    return (
      this.#mode === 'native' && this.#fallbackToPolling && Boolean(this.#lastNativeResourceError)
    );
  }

  async #restartWithPolling(): Promise<void> {
    if (!this.#shouldFallbackToPolling() || this.#fallbackInProgress) {
      return;
    }
    this.#fallbackInProgress = true;
    const previousError = this.#lastNativeResourceError;
    this.#logger.warn('[code-change-monitor] falling back to chokidar polling watcher', {
      error: previousError?.message ?? 'native watcher unavailable',
      pollingIntervalMs: this.#pollingIntervalMs,
    });
    const watcher = this.#watcher;
    this.#watcher = null;
    try {
      if (watcher) {
        await watcher.close();
      }
      this.#lastNativeResourceError = null;
      await this.#startMode('polling');
    } finally {
      this.#fallbackInProgress = false;
    }
  }

  #handleEvent(eventName: string, rawPath: string): void {
    const type = mapChokidarEvent(eventName);
    if (!type) {
      return;
    }
    const filePath = normalizeProjectRelativePath(this.#toRelativePath(rawPath));
    if (!isSafeProjectRelativePath(filePath) || shouldIgnoreProjectPath(filePath)) {
      return;
    }
    this.#status = {
      ...this.#status,
      lastEventAt: new Date().toISOString(),
    };
    this.#onEvent({
      eventSource: 'git-worktree',
      path: filePath,
      type,
    });
  }

  #toRelativePath(filePath: string): string {
    const relativePath = toProjectRelativePath(filePath, this.#projectRoot);
    if (isSafeProjectRelativePath(relativePath)) {
      return relativePath;
    }
    return toProjectRelativePath(filePath, this.#canonicalProjectRoot);
  }

  async #waitUntilReady(): Promise<void> {
    if (this.#status.ready) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.#readyTimeoutMs);
      const watcher = this.#watcher;
      if (!watcher) {
        clearTimeout(timer);
        resolve();
        return;
      }
      watcher.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (!this.#status.ready) {
      this.#status = {
        ...this.#status,
        healthy: false,
        lastError: `watcher did not become ready within ${this.#readyTimeoutMs}ms`,
      };
    }
  }
}

function mapChokidarEvent(eventName: string): FileChangeEvent['type'] | null {
  if (eventName === 'add') {
    return 'created';
  }
  if (eventName === 'change') {
    return 'modified';
  }
  if (eventName === 'unlink') {
    return 'deleted';
  }
  return null;
}

function countWatchedDirectories(watcher: FSWatcher): number {
  return Object.keys(watcher.getWatched()).length;
}

function safeRealpath(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    return filePath;
  }
}

function isWatcherResourceLimitError(error: Error): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'EMFILE' || code === 'ENOSPC';
}

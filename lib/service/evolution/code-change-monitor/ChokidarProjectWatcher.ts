import chokidar, { type FSWatcher } from 'chokidar';
import Logger from '../../../infrastructure/logging/Logger.js';
import type { FileChangeEvent } from '../../../types/reactive-evolution.js';
import type { CodeChangeWatcherStatus } from './CodeChangeMonitorStatus.js';
import {
  isSafeProjectRelativePath,
  normalizeProjectRelativePath,
  shouldIgnoreProjectPath,
  toProjectRelativePath,
} from './ProjectWatchIgnore.js';

const WATCHER_READY_TIMEOUT_MS = 5000;

type AppLogger = ReturnType<typeof Logger.getInstance>;

export interface ChokidarProjectWatcherOptions {
  logger?: Pick<AppLogger, 'warn'>;
  onEvent: (event: FileChangeEvent) => void;
  projectRoot: string;
  readyTimeoutMs?: number;
}

export class ChokidarProjectWatcher {
  readonly #logger: Pick<AppLogger, 'warn'>;
  readonly #onEvent: (event: FileChangeEvent) => void;
  readonly #projectRoot: string;
  readonly #readyTimeoutMs: number;

  #status: CodeChangeWatcherStatus = {
    backend: 'chokidar',
    healthy: false,
    lastError: null,
    lastEventAt: null,
    ready: false,
    watchedDirectoryCount: 0,
  };
  #watcher: FSWatcher | null = null;

  constructor(options: ChokidarProjectWatcherOptions) {
    this.#logger = options.logger ?? Logger.getInstance();
    this.#onEvent = options.onEvent;
    this.#projectRoot = options.projectRoot;
    this.#readyTimeoutMs = options.readyTimeoutMs ?? WATCHER_READY_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    if (this.#watcher) {
      return;
    }

    const watcher = chokidar.watch('.', {
      atomic: true,
      awaitWriteFinish: {
        pollInterval: 100,
        stabilityThreshold: 750,
      },
      cwd: this.#projectRoot,
      ignoreInitial: true,
      ignored: (filePath) =>
        shouldIgnoreProjectPath(toProjectRelativePath(filePath, this.#projectRoot)),
      persistent: true,
    });
    this.#watcher = watcher;

    watcher.on('all', (eventName, filePath) => {
      this.#handleEvent(eventName, filePath);
    });
    watcher.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.#logger.warn('[code-change-monitor] chokidar watcher error', { error: message });
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

  #handleEvent(eventName: string, rawPath: string): void {
    const type = mapChokidarEvent(eventName);
    if (!type) {
      return;
    }
    const filePath = normalizeProjectRelativePath(
      toProjectRelativePath(rawPath, this.#projectRoot)
    );
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

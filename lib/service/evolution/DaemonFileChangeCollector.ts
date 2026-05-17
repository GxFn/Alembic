/**
 * DaemonFileChangeCollector — daemon fallback file-change collection.
 *
 * Preferred path:
 *   VSCode extension heartbeat is fresh → extension owns file-change events.
 *
 * Fallback path:
 *   No fresh heartbeat → daemon periodically samples git worktree state and
 *   dispatches newly observed changes through FileChangeDispatcher.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { timerRegistry } from '@alembic/core/events';
import Logger from '@alembic/core/logging';
import type { FileChangeEvent } from '@alembic/core/types/reactive-evolution';
import type { FileChangeDispatcher } from '../FileChangeDispatcher.js';
import {
  type FileChangeSourceTracker,
  getFileChangeSourceTracker,
} from './FileChangeSourceTracker.js';

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_EXTENSION_TTL_MS = 150_000;
const GIT_TIMEOUT_MS = 5_000;
const MAX_EVENTS_PER_SCAN = 500;

type TimerHandle = ReturnType<typeof setInterval>;
type AppLogger = ReturnType<typeof Logger.getInstance>;

export interface DaemonFileChangeCollectorOptions {
  projectRoot: string;
  dispatcher: FileChangeDispatcher;
  sourceTracker?: FileChangeSourceTracker;
  intervalMs?: number;
  extensionTtlMs?: number;
  logger?: Pick<AppLogger, 'debug' | 'info' | 'warn'>;
}

interface WorktreeSnapshot {
  keys: Set<string>;
  eventsByKey: Map<string, FileChangeEvent>;
}

export class DaemonFileChangeCollector {
  readonly #projectRoot: string;
  readonly #dispatcher: FileChangeDispatcher;
  readonly #sourceTracker: FileChangeSourceTracker;
  readonly #intervalMs: number;
  readonly #extensionTtlMs: number;
  readonly #logger: Pick<AppLogger, 'debug' | 'info' | 'warn'>;

  #timer: TimerHandle | null = null;
  #lastKeys: Set<string> | null = null;
  #running = false;
  #disposed = false;

  constructor(options: DaemonFileChangeCollectorOptions) {
    this.#projectRoot = options.projectRoot;
    this.#dispatcher = options.dispatcher;
    this.#sourceTracker = options.sourceTracker ?? getFileChangeSourceTracker();
    this.#intervalMs = normalizePositiveInt(options.intervalMs, DEFAULT_INTERVAL_MS);
    this.#extensionTtlMs = normalizePositiveInt(options.extensionTtlMs, DEFAULT_EXTENSION_TTL_MS);
    this.#logger = options.logger ?? Logger.getInstance();
  }

  start(): void {
    if (this.#disposed || this.#timer) {
      return;
    }
    if (!existsSync(join(this.#projectRoot, '.git'))) {
      this.#logger.debug('[daemon-file-change] skipped: project is not a git worktree', {
        projectRoot: this.#projectRoot,
      });
      return;
    }

    void this.scanOnce();
    this.#timer = timerRegistry.setInterval(
      () => {
        void this.scanOnce();
      },
      this.#intervalMs,
      'DaemonFileChangeCollector/scan'
    );
    this.#logger.info('[daemon-file-change] fallback collector started', {
      projectRoot: this.#projectRoot,
      intervalMs: this.#intervalMs,
      extensionTtlMs: this.#extensionTtlMs,
    });
  }

  stop(): void {
    this.#disposed = true;
    if (this.#timer) {
      timerRegistry.clear(this.#timer);
      this.#timer = null;
    }
  }

  async scanOnce(now = Date.now()): Promise<void> {
    if (this.#disposed || this.#running) {
      return;
    }
    this.#running = true;
    try {
      const snapshot = await this.#collectSnapshot();

      if (this.#sourceTracker.hasRecentVscodeExtension(this.#extensionTtlMs, now)) {
        this.#lastKeys = snapshot.keys;
        this.#logger.debug(
          '[daemon-file-change] scan skipped: vscode extension heartbeat is fresh'
        );
        return;
      }

      if (!this.#lastKeys) {
        this.#lastKeys = snapshot.keys;
        this.#logger.debug('[daemon-file-change] baseline captured', {
          changedFiles: snapshot.keys.size,
        });
        return;
      }

      const events: FileChangeEvent[] = [];
      for (const [key, event] of snapshot.eventsByKey) {
        if (!this.#lastKeys.has(key) && !isIgnoredPath(event.path)) {
          events.push(event);
        }
        if (events.length >= MAX_EVENTS_PER_SCAN) {
          break;
        }
      }
      this.#lastKeys = snapshot.keys;

      if (events.length === 0) {
        return;
      }

      const report = await this.#dispatcher.dispatch(events);
      this.#logger.info('[daemon-file-change] dispatched fallback file changes', {
        events: events.length,
        needsReview: report.needsReview,
        eventSource: report.eventSource,
      });
    } catch (error: unknown) {
      this.#logger.warn('[daemon-file-change] scan failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.#running = false;
    }
  }

  async #collectSnapshot(): Promise<WorktreeSnapshot> {
    const [unstaged, staged, untracked] = await Promise.all([
      execGit(['diff', '--name-status'], this.#projectRoot),
      execGit(['diff', '--name-status', '--cached'], this.#projectRoot),
      execGit(['ls-files', '--others', '--exclude-standard'], this.#projectRoot),
    ]);

    const eventsByKey = new Map<string, FileChangeEvent>();
    addNameStatusEvents(eventsByKey, unstaged);
    addNameStatusEvents(eventsByKey, staged);
    addUntrackedEvents(eventsByKey, untracked);

    return {
      keys: new Set(eventsByKey.keys()),
      eventsByKey,
    };
  }
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function addNameStatusEvents(target: Map<string, FileChangeEvent>, output: string): void {
  for (const rawLine of splitLines(output)) {
    const parts = rawLine.split('\t');
    const status = parts[0] ?? '';
    const code = status[0];
    if (!code) {
      continue;
    }

    if (code === 'R' && parts[1] && parts[2]) {
      const oldPath = normalizeGitPath(parts[1]);
      const newPath = normalizeGitPath(parts[2]);
      target.set(`renamed:${oldPath}:${newPath}`, {
        type: 'renamed',
        oldPath,
        path: newPath,
        eventSource: 'git-worktree',
      });
      continue;
    }

    const filePath = normalizeGitPath(parts[1] ?? '');
    if (!filePath) {
      continue;
    }
    const type: FileChangeEvent['type'] =
      code === 'A' ? 'created' : code === 'D' ? 'deleted' : 'modified';
    target.set(`${type}:${filePath}`, {
      type,
      path: filePath,
      eventSource: 'git-worktree',
    });
  }
}

function addUntrackedEvents(target: Map<string, FileChangeEvent>, output: string): void {
  for (const filePath of splitLines(output).map(normalizeGitPath)) {
    if (!filePath) {
      continue;
    }
    target.set(`created:${filePath}`, {
      type: 'created',
      path: filePath,
      eventSource: 'git-worktree',
    });
  }
}

function splitLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeGitPath(filePath: string): string {
  return normalize(filePath).replaceAll('\\', '/');
}

function isIgnoredPath(filePath: string): boolean {
  return (
    filePath.startsWith('.asd/') ||
    filePath.startsWith('.git/') ||
    filePath.startsWith('node_modules/')
  );
}

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        resolve('');
        return;
      }
      resolve(stdout.trim());
    });
  });
}

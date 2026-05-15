import { execFile } from 'node:child_process';
import Logger from '../../../infrastructure/logging/Logger.js';
import type { FileChangeEvent, FileChangeEventSource } from '../../../types/reactive-evolution.js';
import type { CodeChangeReconcilerStatus } from './CodeChangeMonitorStatus.js';
import {
  isSafeProjectRelativePath,
  normalizeProjectRelativePath,
  shouldIgnoreProjectPath,
} from './ProjectWatchIgnore.js';

const GIT_TIMEOUT_MS = 5000;

type AppLogger = ReturnType<typeof Logger.getInstance>;

export interface GitWorktreeReconcilerOptions {
  execGit?: (args: string[], cwd: string) => Promise<string>;
  logger?: Pick<AppLogger, 'warn'>;
  projectRoot: string;
}

export interface GitWorktreeScanResult {
  baseline: boolean;
  dirtyPathCount: number;
  events: FileChangeEvent[];
  headChanged: boolean;
}

export interface GitWorktreeScanOptions {
  forcePaths?: string[];
}

interface WorktreeSnapshot {
  eventsByKey: Map<string, FileChangeEvent>;
  keys: Set<string>;
}

export class GitWorktreeReconciler {
  readonly #execGit: (args: string[], cwd: string) => Promise<string>;
  readonly #logger: Pick<AppLogger, 'warn'>;
  readonly #projectRoot: string;

  #lastHead: string | null = null;
  #lastKeys: Set<string> | null = null;
  #status: CodeChangeReconcilerStatus = {
    backend: 'git',
    baselineReady: false,
    dirtyPathCount: 0,
    healthy: false,
    lastError: null,
    lastEventCount: 0,
    lastHead: null,
    lastScanAt: null,
  };

  constructor(options: GitWorktreeReconcilerOptions) {
    this.#execGit = options.execGit ?? execGit;
    this.#logger = options.logger ?? Logger.getInstance();
    this.#projectRoot = options.projectRoot;
  }

  async scanOnce(
    now = Date.now(),
    options: GitWorktreeScanOptions = {}
  ): Promise<GitWorktreeScanResult> {
    const scannedAt = new Date(now).toISOString();
    try {
      const isWorktree =
        (await this.#execGit(['rev-parse', '--is-inside-work-tree'], this.#projectRoot)) === 'true';
      if (!isWorktree) {
        this.#markUnavailable(scannedAt, 'project is not a git worktree');
        return { baseline: false, dirtyPathCount: 0, events: [], headChanged: false };
      }

      const currentHead = normalizeHead(
        await this.#execGit(['rev-parse', 'HEAD'], this.#projectRoot)
      );
      const snapshot = await this.#collectSnapshot();
      const baseline = this.#lastKeys === null;
      const events: FileChangeEvent[] = [];

      if (!baseline) {
        for (const [key, event] of snapshot.eventsByKey) {
          if (!this.#lastKeys?.has(key)) {
            events.push(event);
          }
        }
        events.push(...selectForcedPathEvents(snapshot.eventsByKey, options.forcePaths));
      }

      const headChanged =
        Boolean(this.#lastHead) && Boolean(currentHead) && this.#lastHead !== currentHead;
      if (headChanged && this.#lastHead && currentHead) {
        const headDiff = await this.#execGit(
          ['diff', '--name-status', `${this.#lastHead}..${currentHead}`],
          this.#projectRoot
        );
        addNameStatusEvents(snapshot.eventsByKey, headDiff, 'git-head');
        for (const [key, event] of snapshot.eventsByKey) {
          if (key.startsWith('head:')) {
            events.push(event);
          }
        }
      }

      this.#lastHead = currentHead;
      this.#lastKeys = snapshot.keys;
      this.#status = {
        backend: 'git',
        baselineReady: true,
        dirtyPathCount: snapshot.keys.size,
        healthy: true,
        lastError: null,
        lastEventCount: baseline ? 0 : events.length,
        lastHead: currentHead,
        lastScanAt: scannedAt,
      };

      return {
        baseline,
        dirtyPathCount: snapshot.keys.size,
        events: filterEvents(events),
        headChanged,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.#logger.warn('[code-change-monitor] git reconciliation failed', { error: message });
      this.#status = {
        ...this.#status,
        healthy: false,
        lastError: message,
        lastScanAt: scannedAt,
      };
      return {
        baseline: false,
        dirtyPathCount: this.#status.dirtyPathCount,
        events: [],
        headChanged: false,
      };
    }
  }

  getStatus(): CodeChangeReconcilerStatus {
    return { ...this.#status };
  }

  async #collectSnapshot(): Promise<WorktreeSnapshot> {
    const [unstaged, staged, untracked] = await Promise.all([
      this.#execGit(['diff', '--name-status'], this.#projectRoot),
      this.#execGit(['diff', '--name-status', '--cached'], this.#projectRoot),
      this.#execGit(['ls-files', '--others', '--exclude-standard'], this.#projectRoot),
    ]);

    const eventsByKey = new Map<string, FileChangeEvent>();
    addNameStatusEvents(eventsByKey, unstaged, 'git-worktree');
    addNameStatusEvents(eventsByKey, staged, 'git-worktree');
    addUntrackedEvents(eventsByKey, untracked);
    return {
      eventsByKey,
      keys: new Set([...eventsByKey.keys()].filter((key) => !key.startsWith('head:'))),
    };
  }

  #markUnavailable(scannedAt: string, message: string): void {
    this.#status = {
      ...this.#status,
      healthy: false,
      lastError: message,
      lastScanAt: scannedAt,
    };
  }
}

export function addNameStatusEvents(
  target: Map<string, FileChangeEvent>,
  output: string,
  eventSource: FileChangeEventSource
): void {
  for (const rawLine of splitLines(output)) {
    const parts = rawLine.split('\t');
    const status = parts[0] ?? '';
    const code = status[0];
    if (!code) {
      continue;
    }

    const keyPrefix = eventSource === 'git-head' ? 'head:' : '';
    if (code === 'R' && parts[1] && parts[2]) {
      const oldPath = normalizeProjectRelativePath(parts[1]);
      const newPath = normalizeProjectRelativePath(parts[2]);
      if (!isDispatchablePath(newPath)) {
        continue;
      }
      target.set(`${keyPrefix}renamed:${oldPath}:${newPath}`, {
        eventSource,
        oldPath,
        path: newPath,
        type: 'renamed',
      });
      continue;
    }

    const filePath = normalizeProjectRelativePath(parts[1] ?? '');
    if (!isDispatchablePath(filePath)) {
      continue;
    }
    const type: FileChangeEvent['type'] =
      code === 'A' ? 'created' : code === 'D' ? 'deleted' : 'modified';
    target.set(`${keyPrefix}${type}:${filePath}`, {
      eventSource,
      path: filePath,
      type,
    });
  }
}

function addUntrackedEvents(target: Map<string, FileChangeEvent>, output: string): void {
  for (const filePath of splitLines(output).map(normalizeProjectRelativePath)) {
    if (!isDispatchablePath(filePath)) {
      continue;
    }
    target.set(`created:${filePath}`, {
      eventSource: 'git-worktree',
      path: filePath,
      type: 'created',
    });
  }
}

function filterEvents(events: FileChangeEvent[]): FileChangeEvent[] {
  const seen = new Set<string>();
  const filtered: FileChangeEvent[] = [];
  for (const event of events) {
    if (!isDispatchablePath(event.path)) {
      continue;
    }
    const key =
      event.type === 'renamed'
        ? `${event.type}:${event.oldPath ?? ''}:${event.path}`
        : `${event.type}:${event.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    filtered.push(event);
  }
  return filtered;
}

function selectForcedPathEvents(
  eventsByKey: Map<string, FileChangeEvent>,
  forcePaths: string[] | undefined
): FileChangeEvent[] {
  const forcedPaths = new Set(
    (forcePaths ?? []).map(normalizeProjectRelativePath).filter(isDispatchablePath)
  );
  if (forcedPaths.size === 0) {
    return [];
  }

  return [...eventsByKey.values()].filter((event) => {
    return forcedPaths.has(event.path) || Boolean(event.oldPath && forcedPaths.has(event.oldPath));
  });
}

function isDispatchablePath(filePath: string): boolean {
  return isSafeProjectRelativePath(filePath) && !shouldIgnoreProjectPath(filePath);
}

function normalizeHead(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function splitLines(output: string): string[] {
  return output.split(/\r?\n/).filter((line) => line.length > 0);
}

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve('');
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * DaemonFileChangeCollector — daemon-owned file-change collection.
 *
 * Native filesystem watching is the primary Alembic daemon path. Git worktree
 * polling remains as a degraded fallback when the platform watcher cannot be
 * started. Both paths dispatch into the same FileChangeDispatcher so downstream
 * InProcessFileChangeHandler / ProposalGateway behavior stays unchanged.
 */

import { execFile } from 'node:child_process';
import {
  existsSync,
  type FSWatcher,
  readdirSync,
  statSync,
  type WatchEventType,
  watch,
} from 'node:fs';
import { join, normalize } from 'node:path';
import { timerRegistry } from '@alembic/core/events';
import Logger from '@alembic/core/logging';
import type { FileChangeEvent } from '@alembic/core/types';
import {
  cloneFileMonitorStatus,
  createDisabledFileMonitorStatus,
  createErroredFileMonitorStatus,
  createGitFallbackFileMonitorStatus,
  createNativeFileMonitorStatus,
  createStartingFileMonitorStatus,
  createUnsupportedFileMonitorStatus,
  type DaemonFileMonitorRuntimeStatus,
} from '../../../daemon/runtime/FileMonitorStatus.js';
import type { FileChangeDispatcher } from '../../../service/FileChangeDispatcher.js';

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_NATIVE_DEBOUNCE_MS = 150;
const GIT_TIMEOUT_MS = 5_000;
const MAX_EVENTS_PER_SCAN = 500;

type TimerHandle = ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;
type AppLogger = ReturnType<typeof Logger.getInstance>;

export interface NativeWatcherHandle {
  close(): void;
  on?(event: 'error', listener: (error: Error) => void): unknown;
}

export type NativeWatcherFactory = (
  projectRoot: string,
  listener: (eventType: WatchEventType, filename: string | Buffer | null) => void
) => NativeWatcherHandle;

export interface DaemonFileChangeCollectorOptions {
  projectRoot: string;
  dispatcher: FileChangeDispatcher;
  intervalMs?: number;
  logger?: Pick<AppLogger, 'debug' | 'info' | 'warn'>;
  nativeDebounceMs?: number;
  nativeWatcherFactory?: NativeWatcherFactory;
}

interface WorktreeSnapshot {
  keys: Set<string>;
  eventsByKey: Map<string, FileChangeEvent>;
}

interface NativeSnapshotEntry {
  dev: number;
  ino: number;
  mtimeMs: number;
  path: string;
  size: number;
}

type NativeSnapshot = Map<string, NativeSnapshotEntry>;

export class DaemonFileChangeCollector {
  readonly #projectRoot: string;
  readonly #dispatcher: FileChangeDispatcher;
  readonly #intervalMs: number;
  readonly #logger: Pick<AppLogger, 'debug' | 'info' | 'warn'>;
  readonly #nativeDebounceMs: number;
  readonly #nativeWatcherFactory: NativeWatcherFactory;

  #gitTimer: TimerHandle | null = null;
  #lastDispatchAt: string | null = null;
  #lastGitKeys: Set<string> | null = null;
  #lastScanAt: string | null = null;
  #gitScanQueued = false;
  #nativeScanQueued = false;
  #nativeScanRunning = false;
  #nativeScanTimer: TimerHandle | null = null;
  #nativeSnapshot: NativeSnapshot | null = null;
  #nativeWatcher: NativeWatcherHandle | null = null;
  #running = false;
  #disposed = false;
  #status: DaemonFileMonitorRuntimeStatus;

  constructor(options: DaemonFileChangeCollectorOptions) {
    this.#projectRoot = options.projectRoot;
    this.#dispatcher = options.dispatcher;
    this.#intervalMs = normalizePositiveInt(options.intervalMs, DEFAULT_INTERVAL_MS);
    this.#logger = options.logger ?? Logger.getInstance();
    this.#nativeDebounceMs = normalizePositiveInt(
      options.nativeDebounceMs,
      DEFAULT_NATIVE_DEBOUNCE_MS
    );
    this.#nativeWatcherFactory = options.nativeWatcherFactory ?? defaultNativeWatcherFactory;
    this.#status = createDisabledFileMonitorStatus('collector-not-started', {
      intervalMs: this.#intervalMs,
    });
  }

  getStatus(): DaemonFileMonitorRuntimeStatus {
    return cloneFileMonitorStatus(this.#status);
  }

  start(): void {
    if (this.#disposed || this.#nativeWatcher || this.#gitTimer) {
      return;
    }
    this.#status = createStartingFileMonitorStatus('collector-starting', {
      intervalMs: this.#intervalMs,
      lastDispatchAt: this.#lastDispatchAt,
      lastScanAt: this.#lastScanAt,
    });

    const nativeFailureReason = this.#startNativeWatcher();
    if (!nativeFailureReason) {
      return;
    }
    this.#startGitFallback(nativeFailureReason);
  }

  stop(): void {
    this.#disposed = true;
    this.#closeNativeWatcher();
    this.#clearNativeScanTimer();
    if (this.#gitTimer) {
      timerRegistry.clear(this.#gitTimer);
      this.#gitTimer = null;
    }
    this.#status = createDisabledFileMonitorStatus('collector-stopped', {
      intervalMs: this.#intervalMs,
      lastDispatchAt: this.#lastDispatchAt,
      lastScanAt: this.#lastScanAt,
    });
  }

  async scanNativeOnce(_now = Date.now()): Promise<void> {
    if (this.#disposed) {
      return;
    }
    if (this.#nativeScanRunning) {
      this.#nativeScanQueued = true;
      return;
    }
    this.#nativeScanRunning = true;
    try {
      const previous = this.#nativeSnapshot ?? collectNativeFileSnapshot(this.#projectRoot);
      const next = collectNativeFileSnapshot(this.#projectRoot);
      this.#nativeSnapshot = next;
      this.#lastScanAt = new Date(_now).toISOString();

      const events = dedupeFileChangeEvents(
        diffNativeSnapshots(previous, next)
          .filter((event) => !isIgnoredPath(event.path) && !isIgnoredPath(event.oldPath ?? ''))
          .slice(0, MAX_EVENTS_PER_SCAN)
      );

      if (events.length === 0) {
        this.#status = createNativeFileMonitorStatus({
          lastDispatchAt: this.#lastDispatchAt,
          lastScanAt: this.#lastScanAt,
        });
        return;
      }

      const idempotencyToken = createFileChangeDispatchToken('native-watch', events);
      const report = await this.#dispatcher.dispatch(
        attachFileChangeDispatchToken(events, idempotencyToken)
      );
      this.#lastDispatchAt = new Date(_now).toISOString();
      this.#status = createNativeFileMonitorStatus({
        lastDispatchAt: this.#lastDispatchAt,
        lastScanAt: this.#lastScanAt,
      });
      this.#logger.info('[daemon-file-change] dispatched native file changes', {
        events: events.length,
        eventSource: report.eventSource,
        idempotencyToken,
        needsReview: report.needsReview,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.#lastScanAt = new Date(_now).toISOString();
      this.#status = createErroredFileMonitorStatus(message, {
        activeEventSource: 'native-watch',
        fallback: {
          active: false,
          eventSource: 'git-worktree',
          reason: 'native watcher scan failed before fallback activation',
        },
        lastDispatchAt: this.#lastDispatchAt,
        lastScanAt: this.#lastScanAt,
        nativeWatcher: {
          status: 'error',
          reason: message,
        },
      });
      this.#logger.warn('[daemon-file-change] native scan failed', { error: message });
      this.#handleNativeWatcherError(message);
    } finally {
      this.#nativeScanRunning = false;
      if (this.#nativeScanQueued && !this.#disposed) {
        this.#nativeScanQueued = false;
        void this.scanNativeOnce();
      }
    }
  }

  async scanOnce(_now = Date.now()): Promise<void> {
    if (this.#disposed) {
      return;
    }
    if (this.#running) {
      this.#gitScanQueued = true;
      return;
    }
    this.#running = true;
    try {
      const snapshot = await this.#collectGitSnapshot();
      this.#lastScanAt = new Date(_now).toISOString();
      this.#status = createGitFallbackFileMonitorStatus({
        intervalMs: this.#intervalMs,
        lastDispatchAt: this.#lastDispatchAt,
        lastScanAt: this.#lastScanAt,
      });

      if (!this.#lastGitKeys) {
        this.#lastGitKeys = snapshot.keys;
        this.#logger.debug('[daemon-file-change] git fallback baseline captured', {
          changedFiles: snapshot.keys.size,
        });
        return;
      }

      const events: FileChangeEvent[] = [];
      for (const [key, event] of snapshot.eventsByKey) {
        if (!this.#lastGitKeys.has(key) && !isIgnoredPath(event.path)) {
          events.push(event);
        }
        if (events.length >= MAX_EVENTS_PER_SCAN) {
          break;
        }
      }
      this.#lastGitKeys = snapshot.keys;

      const dedupedEvents = dedupeFileChangeEvents(events);

      if (dedupedEvents.length === 0) {
        return;
      }

      const idempotencyToken = createFileChangeDispatchToken('git-worktree', dedupedEvents);
      const report = await this.#dispatcher.dispatch(
        attachFileChangeDispatchToken(dedupedEvents, idempotencyToken)
      );
      this.#lastDispatchAt = new Date(_now).toISOString();
      this.#status = createGitFallbackFileMonitorStatus({
        intervalMs: this.#intervalMs,
        lastDispatchAt: this.#lastDispatchAt,
        lastScanAt: this.#lastScanAt,
      });
      this.#logger.info('[daemon-file-change] dispatched git fallback file changes', {
        events: dedupedEvents.length,
        eventSource: report.eventSource,
        idempotencyToken,
        needsReview: report.needsReview,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.#lastScanAt = new Date(_now).toISOString();
      this.#status = createErroredFileMonitorStatus(message, {
        intervalMs: this.#intervalMs,
        lastDispatchAt: this.#lastDispatchAt,
        lastScanAt: this.#lastScanAt,
      });
      this.#logger.warn('[daemon-file-change] git fallback scan failed', {
        error: message,
      });
    } finally {
      this.#running = false;
      if (this.#gitScanQueued && !this.#disposed) {
        this.#gitScanQueued = false;
        void this.scanOnce();
      }
    }
  }

  #startNativeWatcher(): string | null {
    try {
      this.#nativeSnapshot = collectNativeFileSnapshot(this.#projectRoot);
      this.#lastScanAt = new Date().toISOString();
      const watcher = this.#nativeWatcherFactory(this.#projectRoot, (eventType, filename) => {
        this.#handleNativeNotification(eventType, filename);
      });
      watcher.on?.('error', (error) => {
        this.#handleNativeWatcherError(error);
      });
      this.#nativeWatcher = watcher;
      this.#status = createNativeFileMonitorStatus({
        lastDispatchAt: this.#lastDispatchAt,
        lastScanAt: this.#lastScanAt,
      });
      this.#logger.info('[daemon-file-change] native watcher started', {
        projectRoot: this.#projectRoot,
        debounceMs: this.#nativeDebounceMs,
      });
      return null;
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      this.#logger.warn('[daemon-file-change] native watcher unavailable; trying git fallback', {
        error: reason,
        projectRoot: this.#projectRoot,
      });
      return reason;
    }
  }

  #startGitFallback(nativeFailureReason: string): void {
    if (!existsSync(join(this.#projectRoot, '.git'))) {
      this.#status = createUnsupportedFileMonitorStatus(
        'native watcher unavailable and project is not a git worktree',
        {
          fallback: {
            active: false,
            eventSource: 'git-worktree',
            reason: 'project-is-not-git-worktree',
          },
          intervalMs: this.#intervalMs,
          lastDispatchAt: this.#lastDispatchAt,
          lastScanAt: this.#lastScanAt,
          nativeWatcher: {
            status: 'error',
            reason: nativeFailureReason,
          },
        }
      );
      this.#logger.warn('[daemon-file-change] no file monitor source available', {
        nativeFailureReason,
        projectRoot: this.#projectRoot,
      });
      return;
    }

    this.#status = createGitFallbackFileMonitorStatus({
      degradedReason: `native watcher unavailable (${nativeFailureReason}); using git worktree fallback`,
      intervalMs: this.#intervalMs,
      lastDispatchAt: this.#lastDispatchAt,
      lastScanAt: this.#lastScanAt,
      nativeWatcher: {
        status: 'error',
        reason: nativeFailureReason,
      },
    });
    void this.scanOnce();
    this.#gitTimer = timerRegistry.setInterval(
      () => {
        void this.scanOnce();
      },
      this.#intervalMs,
      'DaemonFileChangeCollector/git-fallback-scan'
    );
    this.#logger.info('[daemon-file-change] git fallback collector started', {
      intervalMs: this.#intervalMs,
      nativeFailureReason,
      projectRoot: this.#projectRoot,
    });
  }

  #handleNativeNotification(eventType: WatchEventType, filename: string | Buffer | null): void {
    if (this.#disposed || !this.#nativeWatcher) {
      return;
    }
    const filePath = normalizeWatchFilename(filename);
    if (filePath && isIgnoredPath(filePath)) {
      this.#logger.debug('[daemon-file-change] ignored native file-change event', {
        eventType,
        path: filePath,
      });
      return;
    }
    this.#scheduleNativeScan();
  }

  #scheduleNativeScan(): void {
    this.#clearNativeScanTimer();
    this.#nativeScanTimer = timerRegistry.setTimeout(
      () => {
        this.#nativeScanTimer = null;
        void this.scanNativeOnce();
      },
      this.#nativeDebounceMs,
      'DaemonFileChangeCollector/native-scan'
    );
  }

  #handleNativeWatcherError(error: Error | string): void {
    if (this.#disposed) {
      return;
    }
    const message = error instanceof Error ? error.message : error;
    this.#logger.warn('[daemon-file-change] native watcher failed; activating git fallback', {
      error: message,
      projectRoot: this.#projectRoot,
    });
    this.#closeNativeWatcher();
    this.#clearNativeScanTimer();
    if (!this.#gitTimer) {
      this.#startGitFallback(message);
    }
  }

  #closeNativeWatcher(): void {
    if (!this.#nativeWatcher) {
      return;
    }
    try {
      this.#nativeWatcher.close();
    } catch (err: unknown) {
      this.#logger.warn('[daemon-file-change] native watcher close failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.#nativeWatcher = null;
  }

  #clearNativeScanTimer(): void {
    if (!this.#nativeScanTimer) {
      return;
    }
    timerRegistry.clear(this.#nativeScanTimer);
    this.#nativeScanTimer = null;
  }

  async #collectGitSnapshot(): Promise<WorktreeSnapshot> {
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

function defaultNativeWatcherFactory(
  projectRoot: string,
  listener: (eventType: WatchEventType, filename: string | Buffer | null) => void
): FSWatcher {
  return watch(projectRoot, { persistent: false, recursive: true }, listener);
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function collectNativeFileSnapshot(projectRoot: string): NativeSnapshot {
  const snapshot: NativeSnapshot = new Map();
  collectNativeFileSnapshotFromDirectory(projectRoot, '', snapshot);
  return snapshot;
}

function collectNativeFileSnapshotFromDirectory(
  projectRoot: string,
  relativeDir: string,
  snapshot: NativeSnapshot
): void {
  const directoryPath = relativeDir ? join(projectRoot, relativeDir) : projectRoot;
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    const relativePath = normalizeGitPath(relativeDir ? join(relativeDir, entry.name) : entry.name);
    if (isIgnoredPath(relativePath)) {
      continue;
    }
    const absolutePath = join(projectRoot, relativePath);
    if (entry.isDirectory()) {
      collectNativeFileSnapshotFromDirectory(projectRoot, relativePath, snapshot);
      continue;
    }
    try {
      const stat = statSync(absolutePath);
      if (!stat.isFile()) {
        continue;
      }
      snapshot.set(relativePath, {
        dev: stat.dev,
        ino: stat.ino,
        mtimeMs: stat.mtimeMs,
        path: relativePath,
        size: stat.size,
      });
    } catch {
      // File changed during snapshot collection; the next native event will reconcile it.
    }
  }
}

function diffNativeSnapshots(previous: NativeSnapshot, next: NativeSnapshot): FileChangeEvent[] {
  const events: FileChangeEvent[] = [];
  const created = [...next.values()].filter((entry) => !previous.has(entry.path));
  const deleted = [...previous.values()].filter((entry) => !next.has(entry.path));
  const usedCreated = new Set<string>();
  const usedDeleted = new Set<string>();

  const createdBySignature = groupBySignature(created);
  const deletedBySignature = groupBySignature(deleted);
  for (const [signature, deletedEntries] of deletedBySignature) {
    const createdEntries = createdBySignature.get(signature) ?? [];
    if (deletedEntries.length !== 1 || createdEntries.length !== 1) {
      continue;
    }
    const oldEntry = deletedEntries[0];
    const newEntry = createdEntries[0];
    usedDeleted.add(oldEntry.path);
    usedCreated.add(newEntry.path);
    events.push({
      type: 'renamed',
      oldPath: oldEntry.path,
      path: newEntry.path,
      eventSource: 'host-edit',
    });
  }

  for (const entry of deleted) {
    if (!usedDeleted.has(entry.path)) {
      events.push({ type: 'deleted', path: entry.path, eventSource: 'host-edit' });
    }
  }
  for (const entry of created) {
    if (!usedCreated.has(entry.path)) {
      events.push({ type: 'created', path: entry.path, eventSource: 'host-edit' });
    }
  }
  for (const [filePath, nextEntry] of next) {
    const previousEntry = previous.get(filePath);
    if (!previousEntry || usedCreated.has(filePath)) {
      continue;
    }
    if (previousEntry.mtimeMs !== nextEntry.mtimeMs || previousEntry.size !== nextEntry.size) {
      events.push({ type: 'modified', path: filePath, eventSource: 'host-edit' });
    }
  }
  return events;
}

function groupBySignature(entries: NativeSnapshotEntry[]): Map<string, NativeSnapshotEntry[]> {
  const grouped = new Map<string, NativeSnapshotEntry[]>();
  for (const entry of entries) {
    const signature = getNativeRenameSignature(entry);
    const values = grouped.get(signature) ?? [];
    values.push(entry);
    grouped.set(signature, values);
  }
  return grouped;
}

function getNativeRenameSignature(entry: NativeSnapshotEntry): string {
  if (Number.isFinite(entry.dev) && Number.isFinite(entry.ino) && entry.ino !== 0) {
    return `inode:${entry.dev}:${entry.ino}`;
  }
  return `content:${entry.size}:${entry.mtimeMs}`;
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

export function dedupeFileChangeEvents(events: FileChangeEvent[]): FileChangeEvent[] {
  const byKey = new Map<string, FileChangeEvent>();
  for (const event of events) {
    byKey.set(fileChangeEventKey(event), event);
  }
  return [...byKey.values()];
}

export function createFileChangeDispatchToken(
  eventSource: 'git-worktree' | 'native-watch',
  events: FileChangeEvent[]
): string {
  const keys = events.map(fileChangeEventKey).sort();
  return `${eventSource}:${keys.join('|')}`;
}

function attachFileChangeDispatchToken(
  events: FileChangeEvent[],
  idempotencyToken: string
): FileChangeEvent[] {
  return events.map(
    (event) =>
      ({
        ...event,
        idempotencyToken,
      }) as FileChangeEvent
  );
}

function fileChangeEventKey(event: FileChangeEvent): string {
  return [
    event.eventSource ?? 'unknown-source',
    event.type,
    normalizeGitPath(event.oldPath ?? ''),
    normalizeGitPath(event.path),
  ].join(':');
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

function normalizeWatchFilename(filename: string | Buffer | null): string | null {
  if (!filename) {
    return null;
  }
  return normalizeGitPath(Buffer.isBuffer(filename) ? filename.toString('utf8') : filename);
}

function isIgnoredPath(filePath: string): boolean {
  if (!filePath) {
    return false;
  }
  return (
    filePath === '.asd' ||
    filePath === '.git' ||
    filePath === 'node_modules' ||
    filePath.startsWith('.asd/') ||
    filePath.startsWith('.git/') ||
    filePath.startsWith('node_modules/')
  );
}

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr?.trim() || error.message;
          reject(new Error(`git ${args.join(' ')} failed: ${detail}`));
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

import Logger from '../../../infrastructure/logging/Logger.js';
import { timerRegistry } from '../../../shared/TimerRegistry.js';
import type {
  FileChangeEvent,
  FileChangeEventSource,
  ReactiveEvolutionReport,
} from '../../../types/reactive-evolution.js';
import type { CodeChangeLastDispatchStatus } from './CodeChangeMonitorStatus.js';
import { normalizeProjectRelativePath } from './ProjectWatchIgnore.js';

type AppLogger = ReturnType<typeof Logger.getInstance>;
type TimerHandle = ReturnType<typeof setTimeout>;

export interface FileChangeEventBufferOptions {
  debounceMs?: number;
  dispatch: (events: FileChangeEvent[]) => Promise<ReactiveEvolutionReport>;
  ignorePath?: (filePath: string) => boolean;
  logger?: Pick<AppLogger, 'warn'>;
  maxBatchSize?: number;
  modifiedCooldownMs?: number;
  onDispatchError?: (error: Error) => void;
}

export class FileChangeEventBuffer {
  readonly #debounceMs: number;
  readonly #dispatch: (events: FileChangeEvent[]) => Promise<ReactiveEvolutionReport>;
  readonly #ignorePath: (filePath: string) => boolean;
  readonly #logger: Pick<AppLogger, 'warn'>;
  readonly #maxBatchSize: number;
  readonly #modifiedCooldownMs: number;
  readonly #onDispatchError: (error: Error) => void;
  readonly #pending = new Map<string, FileChangeEvent>();
  readonly #lastModifiedFlush = new Map<string, number>();

  #disposed = false;
  #flushTimer: TimerHandle | null = null;
  #flushing: Promise<void> | null = null;
  #lastDispatch: CodeChangeLastDispatchStatus = {
    at: null,
    eventCount: 0,
    source: null,
    truncated: false,
  };

  constructor(options: FileChangeEventBufferOptions) {
    this.#debounceMs = normalizePositiveInt(options.debounceMs, 3000);
    this.#dispatch = options.dispatch;
    this.#ignorePath = options.ignorePath ?? (() => false);
    this.#logger = options.logger ?? Logger.getInstance();
    this.#maxBatchSize = normalizePositiveInt(options.maxBatchSize, 500);
    this.#modifiedCooldownMs = normalizePositiveInt(options.modifiedCooldownMs, 30_000);
    this.#onDispatchError = options.onDispatchError ?? (() => {});
  }

  push(rawEvent: FileChangeEvent): void {
    if (this.#disposed) {
      return;
    }
    const event = normalizeEvent(rawEvent);
    if (!event.path || this.#ignorePath(event.path)) {
      return;
    }

    const pathKey = event.type === 'renamed' ? (event.oldPath ?? event.path) : event.path;
    if (event.type === 'modified') {
      const now = Date.now();
      const lastTime = this.#lastModifiedFlush.get(pathKey);
      if (lastTime && now - lastTime < this.#modifiedCooldownMs) {
        return;
      }
      this.#lastModifiedFlush.set(pathKey, now);
    }

    const createdKey = `created:${pathKey}`;
    const existingCreated = this.#pending.get(createdKey);
    if (existingCreated) {
      if (event.type === 'deleted') {
        this.#pending.delete(createdKey);
        return;
      }
      if (event.type === 'modified') {
        return;
      }
    }

    const key = eventKey(event);
    const existingSameType = this.#pending.get(key);
    if (existingSameType && hasHigherSourcePriority(existingSameType, event)) {
      return;
    }

    this.#pending.set(key, event);
    this.#scheduleFlush();
  }

  async flushNow(): Promise<void> {
    if (this.#flushTimer) {
      timerRegistry.clear(this.#flushTimer);
      this.#flushTimer = null;
    }
    await this.#doFlush();
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    if (this.#flushTimer) {
      timerRegistry.clear(this.#flushTimer);
      this.#flushTimer = null;
    }
    await this.flushNow();
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  getLastDispatch(): CodeChangeLastDispatchStatus {
    return { ...this.#lastDispatch };
  }

  #scheduleFlush(): void {
    if (this.#disposed || this.#flushTimer) {
      return;
    }
    this.#flushTimer = timerRegistry.setTimeout(
      () => {
        this.#flushTimer = null;
        void this.#doFlush();
      },
      this.#debounceMs,
      'CodeChangeMonitor/event-buffer-flush'
    );
  }

  async #doFlush(): Promise<void> {
    if (this.#flushing) {
      await this.#flushing;
      return;
    }
    this.#flushing = this.#flushPending();
    try {
      await this.#flushing;
    } finally {
      this.#flushing = null;
    }
  }

  async #flushPending(): Promise<void> {
    if (this.#pending.size === 0) {
      return;
    }
    const allEvents = [...this.#pending.values()].filter((event) => !this.#ignorePath(event.path));
    this.#pending.clear();
    if (allEvents.length === 0) {
      return;
    }

    const truncated = allEvents.length > this.#maxBatchSize;
    const events = truncated ? allEvents.slice(0, this.#maxBatchSize) : allEvents;
    if (truncated) {
      this.#logger.warn('[code-change-monitor] file change batch truncated', {
        maxBatchSize: this.#maxBatchSize,
        totalEvents: allEvents.length,
      });
    }

    try {
      const report = await this.#dispatch(events);
      this.#lastDispatch = {
        at: new Date().toISOString(),
        eventCount: events.length,
        source: report.eventSource ?? inferBatchSource(events) ?? null,
        truncated,
      };
    } catch (error: unknown) {
      const dispatchError = error instanceof Error ? error : new Error(String(error));
      this.#logger.warn('[code-change-monitor] dispatch failed; file changes will retry', {
        error: dispatchError.message,
        eventCount: events.length,
      });
      this.#onDispatchError(dispatchError);
      if (!this.#disposed) {
        this.#restorePending(events);
        this.#scheduleFlush();
      }
    }
  }

  #restorePending(events: FileChangeEvent[]): void {
    for (const event of events) {
      const key = eventKey(event);
      if (!this.#pending.has(key)) {
        this.#pending.set(key, event);
      }
    }
  }
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function normalizeEvent(event: FileChangeEvent): FileChangeEvent {
  return {
    ...event,
    path: normalizeProjectRelativePath(event.path),
    ...(event.oldPath ? { oldPath: normalizeProjectRelativePath(event.oldPath) } : {}),
  };
}

function eventKey(event: FileChangeEvent): string {
  const pathKey = event.type === 'renamed' ? (event.oldPath ?? event.path) : event.path;
  return event.type === 'renamed'
    ? `renamed:${event.oldPath}:${event.path}`
    : `${event.type}:${pathKey}`;
}

function hasHigherSourcePriority(existing: FileChangeEvent, incoming: FileChangeEvent): boolean {
  return sourcePriority(existing.eventSource) > sourcePriority(incoming.eventSource);
}

function sourcePriority(source: FileChangeEventSource | undefined): number {
  if (source === 'ide-edit') {
    return 3;
  }
  if (source === 'git-head') {
    return 2;
  }
  if (source === 'git-worktree') {
    return 1;
  }
  return 0;
}

function inferBatchSource(events: FileChangeEvent[]): FileChangeEventSource | undefined {
  const counts = new Map<FileChangeEventSource, number>();
  for (const event of events) {
    if (event.eventSource) {
      counts.set(event.eventSource, (counts.get(event.eventSource) ?? 0) + 1);
    }
  }
  let winner: FileChangeEventSource | undefined;
  let max = -1;
  for (const [source, count] of counts) {
    if (count > max) {
      winner = source;
      max = count;
    }
  }
  return winner;
}

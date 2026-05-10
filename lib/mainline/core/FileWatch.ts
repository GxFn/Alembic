import { normalizeMainlinePosixPath } from "./PathIdentity.js";

export type MainlineFileChangeType = "created" | "modified" | "deleted" | "renamed";
export type MainlineFileChangeSource = "git-worktree" | "ide" | "watcher" | "manual";

export interface MainlineFileChangeEvent {
  readonly type: MainlineFileChangeType;
  readonly path: string;
  readonly oldPath?: string;
  readonly source: MainlineFileChangeSource;
  readonly timestamp: number;
}

export interface MainlineFileWatcherSnapshot {
  readonly active: boolean;
  readonly mode: "unavailable" | "external";
}

export interface MainlineFileWatcherPort {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  snapshot(): MainlineFileWatcherSnapshot;
}

export const MAINLINE_DEFAULT_IGNORED_CHANGE_SEGMENTS = [".asd", ".git", "node_modules"] as const;

export class UnavailableMainlineFileWatcher implements MainlineFileWatcherPort {
  readonly #reason: string;

  constructor(reason = "Mainline file watcher adapter is not configured.") {
    this.#reason = reason;
  }

  start(): void {
    throw new Error(this.#reason);
  }

  stop(): void {}

  snapshot(): MainlineFileWatcherSnapshot {
    return { active: false, mode: "unavailable" };
  }
}

/**
 * MainlineFileChangeCoalescer 只负责合并同一批文件变化。
 * 真实 fs.watch、IDE heartbeat、git polling 都应该作为 adapter 产出这些事件。
 */
export class MainlineFileChangeCoalescer {
  readonly #eventsByKey = new Map<string, MainlineFileChangeEvent>();
  readonly #ignoreSegments: readonly string[];

  constructor(options: { ignoreSegments?: readonly string[] } = {}) {
    this.#ignoreSegments = options.ignoreSegments ?? MAINLINE_DEFAULT_IGNORED_CHANGE_SEGMENTS;
  }

  push(event: Omit<MainlineFileChangeEvent, "timestamp"> & { timestamp?: number }): void {
    const normalized: MainlineFileChangeEvent = {
      ...event,
      path: normalizeEventPath(event.path),
      ...(event.oldPath ? { oldPath: normalizeEventPath(event.oldPath) } : {}),
      timestamp: event.timestamp ?? Date.now(),
    };
    if (isMainlineIgnoredFileChange(normalized.path, this.#ignoreSegments)) {
      return;
    }

    const key = eventKey(normalized);
    const existing = this.#eventsByKey.get(key);
    const merged = existing ? mergeEvents(existing, normalized) : normalized;
    if (merged) {
      this.#eventsByKey.set(key, merged);
    } else {
      this.#eventsByKey.delete(key);
    }
  }

  drain(limit = 500): MainlineFileChangeEvent[] {
    const events = [...this.#eventsByKey.values()].slice(0, limit);
    this.#eventsByKey.clear();
    return events;
  }

  get size(): number {
    return this.#eventsByKey.size;
  }
}

export interface MainlineCollectorPresenceSnapshot {
  readonly source: MainlineFileChangeSource;
  readonly active: boolean;
  readonly lastSeenAt?: number;
  readonly expiresAt?: number;
}

/**
 * IDE 扩展存在时可暂停 git polling；这个状态机只记录心跳，不绑定任何宿主。
 */
export class MainlineCollectorPresenceTracker {
  readonly #ttlMs: number;
  #lastSeenAt: number | undefined;
  #source: MainlineFileChangeSource;

  constructor(options: { ttlMs?: number; source?: MainlineFileChangeSource } = {}) {
    this.#ttlMs = options.ttlMs ?? 15_000;
    this.#source = options.source ?? "ide";
  }

  markSeen(now = Date.now(), source = this.#source): void {
    this.#lastSeenAt = now;
    this.#source = source;
  }

  isActive(now = Date.now()): boolean {
    return this.#lastSeenAt !== undefined && now - this.#lastSeenAt <= this.#ttlMs;
  }

  snapshot(now = Date.now()): MainlineCollectorPresenceSnapshot {
    return {
      source: this.#source,
      active: this.isActive(now),
      ...(this.#lastSeenAt === undefined
        ? {}
        : {
            lastSeenAt: this.#lastSeenAt,
            expiresAt: this.#lastSeenAt + this.#ttlMs,
          }),
    };
  }
}

export function isMainlineIgnoredFileChange(
  filePath: string,
  ignoredSegments: readonly string[] = MAINLINE_DEFAULT_IGNORED_CHANGE_SEGMENTS,
): boolean {
  const segments = normalizeEventPath(filePath).split("/").filter(Boolean);
  return segments.some((segment) => ignoredSegments.includes(segment));
}

function eventKey(event: MainlineFileChangeEvent): string {
  return event.type === "renamed"
    ? `renamed:${event.oldPath ?? ""}:${event.path}`
    : `file:${event.path}`;
}

function mergeEvents(
  previous: MainlineFileChangeEvent,
  next: MainlineFileChangeEvent,
): MainlineFileChangeEvent | null {
  if (previous.type === "created" && next.type === "modified") {
    return { ...previous, timestamp: next.timestamp };
  }
  if (previous.type === "created" && next.type === "deleted") {
    return null;
  }
  if (previous.type === "deleted" && next.type === "created") {
    return { ...next, type: "modified" };
  }
  if (next.type === "deleted") {
    return next;
  }
  return next.timestamp >= previous.timestamp ? next : previous;
}

function normalizeEventPath(filePath: string): string {
  return normalizeMainlinePosixPath(filePath);
}

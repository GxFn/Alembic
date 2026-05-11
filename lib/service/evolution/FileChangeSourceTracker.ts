/**
 * FileChangeSourceTracker — tracks live IDE collectors for daemon fallback gating.
 *
 * VSCode sends a lightweight heartbeat while its Alembic extension is active.
 * The daemon file-change collector uses this signal to avoid duplicating IDE
 * events, and only falls back to git worktree scans after the heartbeat expires.
 */

export interface FileChangeSourceSnapshot {
  vscodeExtensionSeenAt: string | null;
  vscodeExtensionAgeMs: number | null;
}

export class FileChangeSourceTracker {
  #vscodeExtensionSeenAt = 0;

  markVscodeExtensionSeen(now = Date.now()): void {
    this.#vscodeExtensionSeenAt = now;
  }

  hasRecentVscodeExtension(ttlMs: number, now = Date.now()): boolean {
    return this.#vscodeExtensionSeenAt > 0 && now - this.#vscodeExtensionSeenAt <= ttlMs;
  }

  snapshot(now = Date.now()): FileChangeSourceSnapshot {
    return {
      vscodeExtensionSeenAt:
        this.#vscodeExtensionSeenAt > 0
          ? new Date(this.#vscodeExtensionSeenAt).toISOString()
          : null,
      vscodeExtensionAgeMs:
        this.#vscodeExtensionSeenAt > 0 ? now - this.#vscodeExtensionSeenAt : null,
    };
  }

  resetForTesting(): void {
    this.#vscodeExtensionSeenAt = 0;
  }
}

const globalFileChangeSourceTracker = new FileChangeSourceTracker();

export function getFileChangeSourceTracker(): FileChangeSourceTracker {
  return globalFileChangeSourceTracker;
}

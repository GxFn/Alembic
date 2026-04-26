import type { TerminalSessionPlan } from './TerminalSession.js';

export type TerminalSessionStatus = 'idle' | 'busy' | 'closed';

export interface TerminalSessionRecord {
  id: string;
  mode: TerminalSessionPlan['mode'];
  projectRoot: string;
  cwd: string;
  envKeys: string[];
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string | null;
  status: TerminalSessionStatus;
  activeCallId: string | null;
  commandCount: number;
}

export interface TerminalSessionAcquireRequest {
  callId: string;
  projectRoot: string;
  cwd: string;
  now?: Date;
}

export interface TerminalSessionLease {
  record: TerminalSessionRecord;
  env: Record<string, string>;
  release(update?: {
    cwd?: string;
    env?: Record<string, string>;
    now?: Date;
  }): TerminalSessionRecord;
}

export interface TerminalSessionManager {
  acquire(
    plan: TerminalSessionPlan,
    request: TerminalSessionAcquireRequest
  ): { ok: true; lease: TerminalSessionLease } | { ok: false; error: string };
  snapshot(id: string): TerminalSessionRecord | null;
  close(id: string, now?: Date): boolean;
  cleanup(now?: Date): number;
}

const DEFAULT_PERSISTENT_TTL_MS = 10 * 60 * 1000;

interface StoredTerminalSessionRecord extends Omit<TerminalSessionRecord, 'envKeys'> {
  env: Record<string, string>;
}

export class InMemoryTerminalSessionManager implements TerminalSessionManager {
  readonly #sessions = new Map<string, StoredTerminalSessionRecord>();
  readonly #persistentTtlMs: number;

  constructor(options: { persistentTtlMs?: number } = {}) {
    this.#persistentTtlMs = options.persistentTtlMs ?? DEFAULT_PERSISTENT_TTL_MS;
  }

  acquire(
    plan: TerminalSessionPlan,
    request: TerminalSessionAcquireRequest
  ): { ok: true; lease: TerminalSessionLease } | { ok: false; error: string } {
    const now = request.now ?? new Date();
    if (plan.mode === 'ephemeral') {
      const record = createRecord({
        id: plan.id ?? `ephemeral:${request.callId}`,
        mode: 'ephemeral',
        projectRoot: request.projectRoot,
        cwd: request.cwd,
        now,
        expiresAt: null,
        activeCallId: request.callId,
      });
      return { ok: true, lease: this.#lease(record, false) };
    }

    if (!plan.id) {
      return { ok: false, error: 'persistent terminal sessions require session.id' };
    }

    const existing = this.#sessions.get(plan.id);
    if (existing?.status === 'closed') {
      this.#sessions.delete(plan.id);
    } else if (existing) {
      if (existing.projectRoot !== request.projectRoot) {
        return { ok: false, error: `terminal session "${plan.id}" belongs to another project` };
      }
      if (existing.status === 'busy') {
        return { ok: false, error: `terminal session "${plan.id}" is already running a command` };
      }
      existing.status = 'busy';
      existing.activeCallId = request.callId;
      existing.lastUsedAt = now.toISOString();
      existing.expiresAt = expiresAt(now, this.#persistentTtlMs);
      return { ok: true, lease: this.#lease(existing, true) };
    }

    const record = createRecord({
      id: plan.id,
      mode: 'persistent',
      projectRoot: request.projectRoot,
      cwd: request.cwd,
      now,
      expiresAt: expiresAt(now, this.#persistentTtlMs),
      activeCallId: request.callId,
    });
    this.#sessions.set(record.id, record);
    return { ok: true, lease: this.#lease(record, true) };
  }

  snapshot(id: string): TerminalSessionRecord | null {
    const record = this.#sessions.get(id);
    return record ? cloneRecord(record) : null;
  }

  close(id: string, now = new Date()): boolean {
    const record = this.#sessions.get(id);
    if (!record) {
      return false;
    }
    record.status = 'closed';
    record.activeCallId = null;
    record.lastUsedAt = now.toISOString();
    return true;
  }

  cleanup(now = new Date()): number {
    let removed = 0;
    for (const [id, record] of this.#sessions) {
      if (record.status === 'closed' || isExpired(record, now)) {
        this.#sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  #lease(record: StoredTerminalSessionRecord, persistAfterRelease: boolean): TerminalSessionLease {
    return {
      record: cloneRecord(record),
      env: cloneEnv(record.env),
      release: (update = {}) => {
        const now = update.now ?? new Date();
        if (!persistAfterRelease) {
          return cloneRecord({
            ...record,
            cwd: update.cwd ?? record.cwd,
            env: update.env ?? record.env,
            status: 'closed',
            activeCallId: null,
            commandCount: record.commandCount + 1,
            lastUsedAt: now.toISOString(),
          });
        }

        const stored = this.#sessions.get(record.id);
        if (!stored) {
          return cloneRecord(record);
        }
        stored.cwd = update.cwd ?? stored.cwd;
        stored.env = update.env ? cloneEnv(update.env) : stored.env;
        stored.status = 'idle';
        stored.activeCallId = null;
        stored.commandCount += 1;
        stored.lastUsedAt = now.toISOString();
        stored.expiresAt = expiresAt(now, this.#persistentTtlMs);
        return cloneRecord(stored);
      },
    };
  }
}

function createRecord(input: {
  id: string;
  mode: TerminalSessionRecord['mode'];
  projectRoot: string;
  cwd: string;
  now: Date;
  expiresAt: string | null;
  activeCallId: string;
}): StoredTerminalSessionRecord {
  const timestamp = input.now.toISOString();
  return {
    id: input.id,
    mode: input.mode,
    projectRoot: input.projectRoot,
    cwd: input.cwd,
    env: {},
    createdAt: timestamp,
    lastUsedAt: timestamp,
    expiresAt: input.expiresAt,
    status: 'busy',
    activeCallId: input.activeCallId,
    commandCount: 0,
  };
}

function expiresAt(now: Date, ttlMs: number) {
  return new Date(now.getTime() + ttlMs).toISOString();
}

function isExpired(record: StoredTerminalSessionRecord, now: Date) {
  return (
    !!record.expiresAt && record.status !== 'busy' && Date.parse(record.expiresAt) <= now.getTime()
  );
}

function cloneRecord(record: StoredTerminalSessionRecord): TerminalSessionRecord {
  return {
    id: record.id,
    mode: record.mode,
    projectRoot: record.projectRoot,
    cwd: record.cwd,
    envKeys: Object.keys(record.env).sort(),
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    expiresAt: record.expiresAt,
    status: record.status,
    activeCallId: record.activeCallId,
    commandCount: record.commandCount,
  };
}

function cloneEnv(env: Record<string, string>): Record<string, string> {
  return { ...env };
}

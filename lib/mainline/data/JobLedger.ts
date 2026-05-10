export type MainlineJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MainlineJobSource = "compile" | "runtime" | "agent" | "system";

export interface MainlineJobRecord {
  readonly id: string;
  readonly kind: string;
  readonly status: MainlineJobStatus;
  readonly source: MainlineJobSource;
  readonly request: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: { readonly code?: string; readonly message: string };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface MainlineJobCreateInput {
  readonly id?: string;
  readonly kind: string;
  readonly source?: MainlineJobSource;
  readonly request?: Record<string, unknown>;
}

export interface MainlineJobListOptions {
  readonly kind?: string;
  readonly status?: MainlineJobStatus;
  readonly limit?: number;
}

export interface MainlineJobLedgerPort {
  create(input: MainlineJobCreateInput): Promise<MainlineJobRecord>;
  get(id: string): Promise<MainlineJobRecord | null>;
  list(options?: MainlineJobListOptions): Promise<MainlineJobRecord[]>;
  markRunning(id: string): Promise<MainlineJobRecord | null>;
  complete(id: string, result: unknown): Promise<MainlineJobRecord | null>;
  fail(id: string, error: unknown): Promise<MainlineJobRecord | null>;
  cancel(id: string, reason?: string): Promise<MainlineJobRecord | null>;
}

const SAFE_JOB_ID_RE = /^[a-zA-Z0-9_-]+$/;
const TERMINAL_STATUSES = new Set<MainlineJobStatus>(["completed", "failed", "cancelled"]);
const ALLOWED_TRANSITIONS: Record<MainlineJobStatus, ReadonlySet<MainlineJobStatus>> = {
  queued: new Set(["queued", "running", "completed", "failed", "cancelled"]),
  running: new Set(["running", "completed", "failed", "cancelled"]),
  completed: new Set(["completed"]),
  failed: new Set(["failed"]),
  cancelled: new Set(["cancelled"]),
};

/**
 * InMemoryMainlineJobLedger 是 compile/runtime 共享的最小 job 状态机。
 * 中文注释：它不认识 daemon、HTTP 或 IDE adapter；后续持久化实现必须复用同一端口，
 * 这样 MainlineCompileSession 可以在测试里用内存实现，在 daemon 里换成文件实现。
 */
export class InMemoryMainlineJobLedger implements MainlineJobLedgerPort {
  readonly #records = new Map<string, MainlineJobRecord>();
  #nextId = 0;

  async create(input: MainlineJobCreateInput): Promise<MainlineJobRecord> {
    const id = input.id ?? `${input.kind}-${++this.#nextId}`;
    assertSafeJobId(id);
    const now = new Date().toISOString();
    const record: MainlineJobRecord = {
      id,
      kind: input.kind,
      status: "queued",
      source: input.source ?? "system",
      request: input.request ? { ...input.request } : {},
      createdAt: now,
      updatedAt: now,
    };
    this.#records.set(id, record);
    return cloneJob(record);
  }

  async get(id: string): Promise<MainlineJobRecord | null> {
    if (!isSafeJobId(id)) {
      return null;
    }
    const record = this.#records.get(id);
    return record ? cloneJob(record) : null;
  }

  async list(options: MainlineJobListOptions = {}): Promise<MainlineJobRecord[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    return [...this.#records.values()]
      .filter((job) => !options.kind || job.kind === options.kind)
      .filter((job) => !options.status || job.status === options.status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
      .map(cloneJob);
  }

  async markRunning(id: string): Promise<MainlineJobRecord | null> {
    const current = this.#records.get(id);
    if (!current || current.status !== "queued") {
      return current ? cloneJob(current) : null;
    }
    return this.#update(id, {
      status: "running",
      startedAt: new Date().toISOString(),
    });
  }

  async complete(id: string, result: unknown): Promise<MainlineJobRecord | null> {
    return this.#update(id, {
      status: "completed",
      result,
      completedAt: new Date().toISOString(),
    });
  }

  async fail(id: string, error: unknown): Promise<MainlineJobRecord | null> {
    return this.#update(id, {
      status: "failed",
      error: toJobError(error),
      completedAt: new Date().toISOString(),
    });
  }

  async cancel(id: string, reason = "Cancelled"): Promise<MainlineJobRecord | null> {
    return this.#update(id, {
      status: "cancelled",
      error: { message: reason },
      completedAt: new Date().toISOString(),
    });
  }

  #update(id: string, patch: Partial<MainlineJobRecord>): MainlineJobRecord | null {
    const current = this.#records.get(id);
    if (!current) {
      return null;
    }
    if (TERMINAL_STATUSES.has(current.status)) {
      return cloneJob(current);
    }

    const nextStatus = patch.status ?? current.status;
    if (!ALLOWED_TRANSITIONS[current.status].has(nextStatus)) {
      return cloneJob(current);
    }

    const next: MainlineJobRecord = {
      ...current,
      ...patch,
      id: current.id,
      kind: current.kind,
      createdAt: current.createdAt,
      request: patch.request ? { ...patch.request } : current.request,
      updatedAt: new Date().toISOString(),
    };
    this.#records.set(id, next);
    return cloneJob(next);
  }
}

export function isSafeMainlineJobId(id: string): boolean {
  return isSafeJobId(id);
}

function assertSafeJobId(id: string): void {
  if (!isSafeJobId(id)) {
    throw new Error(`Unsafe mainline job id: ${id}`);
  }
}

function isSafeJobId(id: string): boolean {
  return SAFE_JOB_ID_RE.test(id);
}

function toJobError(error: unknown): { readonly code?: string; readonly message: string } {
  if (error instanceof Error) {
    return { message: error.message };
  }
  if (typeof error === "string") {
    return { message: error };
  }
  return { message: "Unknown mainline job error." };
}

function cloneJob(record: MainlineJobRecord): MainlineJobRecord {
  return {
    ...record,
    request: { ...record.request },
    ...(record.error ? { error: { ...record.error } } : {}),
  };
}

import { randomBytes } from 'node:crypto';
import type { ScanMode } from './ScanTypes.js';

export type ScanJobStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ScanJobExecutionContext {
  jobId: string;
  attempt: number;
  signal: AbortSignal;
}

export interface ScanJobRecord<TRequest = unknown, TResult = unknown> {
  id: string;
  mode: ScanMode;
  label: string;
  status: ScanJobStatus;
  request: TRequest;
  result: TResult | null;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  queuedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  cancelRequested: boolean;
  errorMessage: string | null;
}

export interface EnqueueScanJobInput<TRequest = unknown, TResult = unknown> {
  mode: ScanMode;
  label?: string;
  request: TRequest;
  maxAttempts?: number;
  execute: (context: ScanJobExecutionContext) => Promise<TResult>;
}

export interface ScanJobListFilter {
  mode?: ScanMode;
  status?: ScanJobStatus;
  limit?: number;
}

export interface ScanJobQueueOptions {
  concurrency?: number;
  now?: () => number;
}

interface InternalScanJob extends ScanJobRecord {
  execute: (context: ScanJobExecutionContext) => Promise<unknown>;
  controller: AbortController | null;
}

export class ScanJobQueue {
  readonly #concurrency: number;
  readonly #now: () => number;
  readonly #jobs = new Map<string, InternalScanJob>();
  readonly #queue: string[] = [];
  readonly #running = new Set<string>();
  readonly #waiters = new Map<string, Array<(job: ScanJobRecord) => void>>();
  #scheduled = false;

  constructor(options: ScanJobQueueOptions = {}) {
    this.#concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
    this.#now = options.now ?? Date.now;
  }

  enqueue<TRequest, TResult>(
    input: EnqueueScanJobInput<TRequest, TResult>
  ): ScanJobRecord<TRequest, TResult> {
    const now = this.#now();
    const job: InternalScanJob = {
      id: ScanJobQueue.#generateId(now),
      mode: input.mode,
      label: input.label ?? input.mode,
      status: 'queued',
      request: input.request,
      result: null,
      attempts: 0,
      maxAttempts: Math.max(1, Math.floor(input.maxAttempts ?? 1)),
      createdAt: now,
      queuedAt: now,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      cancelRequested: false,
      errorMessage: null,
      execute: input.execute as (context: ScanJobExecutionContext) => Promise<unknown>,
      controller: null,
    };
    this.#jobs.set(job.id, job);
    this.#queue.push(job.id);
    this.#scheduleDrain();
    return this.#toRecord(job) as ScanJobRecord<TRequest, TResult>;
  }

  get(id: string): ScanJobRecord | null {
    const job = this.#jobs.get(id);
    return job ? this.#toRecord(job) : null;
  }

  list(filter: ScanJobListFilter = {}): ScanJobRecord[] {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    return [...this.#jobs.values()]
      .filter((job) => !filter.mode || job.mode === filter.mode)
      .filter((job) => !filter.status || job.status === filter.status)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, limit)
      .map((job) => this.#toRecord(job));
  }

  stats() {
    const counts: Record<ScanJobStatus, number> = {
      queued: 0,
      running: 0,
      cancelling: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const job of this.#jobs.values()) {
      counts[job.status] += 1;
    }
    return {
      concurrency: this.#concurrency,
      running: this.#running.size,
      queued: this.#queue.length,
      total: this.#jobs.size,
      counts,
    };
  }

  cancel(id: string, reason = 'Cancelled by user'): ScanJobRecord | null {
    const job = this.#jobs.get(id);
    if (!job) {
      return null;
    }
    if (job.status === 'queued') {
      this.#removeQueued(id);
      this.#finish(job, 'cancelled', null, reason);
      return this.#toRecord(job);
    }
    if (job.status === 'running') {
      job.cancelRequested = true;
      job.status = 'cancelling';
      job.errorMessage = reason;
      job.controller?.abort(reason);
      return this.#toRecord(job);
    }
    return this.#toRecord(job);
  }

  retry(id: string, maxAttempts?: number): ScanJobRecord | null {
    const job = this.#jobs.get(id);
    if (!job) {
      return null;
    }
    if (job.status !== 'failed' && job.status !== 'cancelled') {
      return this.#toRecord(job);
    }
    const now = this.#now();
    job.status = 'queued';
    job.result = null;
    job.errorMessage = null;
    job.cancelRequested = false;
    job.controller = null;
    job.attempts = 0;
    job.maxAttempts = Math.max(1, Math.floor(maxAttempts ?? job.maxAttempts));
    job.queuedAt = now;
    job.startedAt = null;
    job.completedAt = null;
    job.durationMs = null;
    this.#queue.push(job.id);
    this.#scheduleDrain();
    return this.#toRecord(job);
  }

  waitFor(id: string): Promise<ScanJobRecord | null> {
    const job = this.#jobs.get(id);
    if (!job || isTerminal(job.status)) {
      return Promise.resolve(job ? this.#toRecord(job) : null);
    }
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(id) ?? [];
      waiters.push(resolve);
      this.#waiters.set(id, waiters);
    });
  }

  #scheduleDrain(): void {
    if (this.#scheduled) {
      return;
    }
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.#drain();
    });
  }

  #drain(): void {
    while (this.#running.size < this.#concurrency && this.#queue.length > 0) {
      const jobId = this.#queue.shift();
      if (!jobId) {
        continue;
      }
      const job = this.#jobs.get(jobId);
      if (!job || job.status !== 'queued') {
        continue;
      }
      this.#run(job);
    }
  }

  #run(job: InternalScanJob): void {
    const startedAt = this.#now();
    const controller = new AbortController();
    job.status = 'running';
    job.startedAt = startedAt;
    job.completedAt = null;
    job.durationMs = null;
    job.errorMessage = null;
    job.cancelRequested = false;
    job.controller = controller;
    job.attempts += 1;
    this.#running.add(job.id);

    void Promise.resolve()
      .then(() => job.execute({ jobId: job.id, attempt: job.attempts, signal: controller.signal }))
      .then((result) => {
        if (controller.signal.aborted || job.cancelRequested) {
          this.#finish(job, 'cancelled', null, job.errorMessage ?? 'Cancelled by user');
          return;
        }
        this.#finish(job, 'completed', result, null);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (controller.signal.aborted || job.cancelRequested) {
          this.#finish(job, 'cancelled', null, job.errorMessage ?? message);
          return;
        }
        if (job.attempts < job.maxAttempts) {
          job.status = 'queued';
          job.errorMessage = message;
          job.queuedAt = this.#now();
          job.controller = null;
          this.#running.delete(job.id);
          this.#queue.push(job.id);
          this.#scheduleDrain();
          return;
        }
        this.#finish(job, 'failed', null, message);
      });
  }

  #finish(
    job: InternalScanJob,
    status: Extract<ScanJobStatus, 'completed' | 'failed' | 'cancelled'>,
    result: unknown,
    errorMessage: string | null
  ): void {
    const completedAt = this.#now();
    job.status = status;
    job.result = result;
    job.errorMessage = errorMessage;
    job.completedAt = completedAt;
    job.durationMs = job.startedAt ? completedAt - job.startedAt : 0;
    job.controller = null;
    job.cancelRequested = status === 'cancelled' ? job.cancelRequested : false;
    this.#running.delete(job.id);
    this.#resolveWaiters(job);
    this.#scheduleDrain();
  }

  #removeQueued(id: string): void {
    const index = this.#queue.indexOf(id);
    if (index >= 0) {
      this.#queue.splice(index, 1);
    }
  }

  #resolveWaiters(job: InternalScanJob): void {
    const waiters = this.#waiters.get(job.id) ?? [];
    this.#waiters.delete(job.id);
    const record = this.#toRecord(job);
    for (const resolve of waiters) {
      resolve(record);
    }
  }

  #toRecord(job: InternalScanJob): ScanJobRecord {
    return {
      id: job.id,
      mode: job.mode,
      label: job.label,
      status: job.status,
      request: job.request,
      result: job.result,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      createdAt: job.createdAt,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      durationMs: job.durationMs,
      cancelRequested: job.cancelRequested,
      errorMessage: job.errorMessage,
    };
  }

  static #generateId(now: number): string {
    return `scanjob-${now}-${randomBytes(4).toString('hex')}`;
  }
}

function isTerminal(status: ScanJobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

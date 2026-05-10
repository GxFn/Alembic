import type {
  CreateDaemonJobInput,
  DaemonJob,
  DaemonJobKind,
  JsonDaemonJobStore,
} from "./JobStore.js";

export interface DaemonJobExecutionContext {
  isCancelled(): Promise<boolean>;
}

export type DaemonJobHandler = (
  job: DaemonJob,
  context: DaemonJobExecutionContext,
) => Promise<Record<string, unknown>>;

export interface EnqueueDaemonJobInput {
  readonly kind: DaemonJobKind;
  readonly input?: Record<string, unknown>;
}

export interface DaemonJobRunnerOptions {
  readonly handlers?: Partial<Record<DaemonJobKind, DaemonJobHandler>>;
  readonly autoStart?: boolean;
}

export class DaemonJobRunner {
  readonly #store: JsonDaemonJobStore;
  readonly #handlers: Partial<Record<DaemonJobKind, DaemonJobHandler>>;
  readonly #autoStart: boolean;

  constructor(store: JsonDaemonJobStore, options: DaemonJobRunnerOptions = {}) {
    this.#store = store;
    this.#handlers = options.handlers ?? {};
    this.#autoStart = options.autoStart === true;
  }

  async enqueue(input: EnqueueDaemonJobInput): Promise<DaemonJob> {
    const job = await this.#store.create(toCreateJobInput(input));
    if (this.#autoStart && this.#handlers[job.kind]) {
      // HTTP enqueue 不能阻塞 stdio/MCP 生命周期；真实执行由 durable job 状态机异步推进。
      queueMicrotask(() => {
        this.run(job.id).catch(() => undefined);
      });
    }
    return job;
  }

  async cancel(jobId: string): Promise<DaemonJob> {
    return this.#store.cancel(jobId);
  }

  async markInterrupted(): Promise<DaemonJob[]> {
    return this.#store.markInterrupted();
  }

  async run(jobId: string): Promise<DaemonJob> {
    const job = await this.#getRequired(jobId);
    if (isTerminal(job.status)) {
      return job;
    }

    const handler = this.#handlers[job.kind];
    if (!handler) {
      return this.#store.update(job.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: {
          code: "WORKFLOW_HANDLER_UNAVAILABLE",
          message: `No workflow handler registered for ${job.kind}.`,
        },
      });
    }

    const running = await this.#store.update(job.id, {
      status: "running",
      startedAt: new Date().toISOString(),
    });

    try {
      const result = await handler(running, {
        isCancelled: async () => (await this.#store.get(job.id))?.status === "cancelled",
      });
      const current = await this.#getRequired(job.id);
      if (current.status === "cancelled") {
        return current;
      }
      return this.#store.update(job.id, {
        status: "completed",
        result,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      const current = await this.#getRequired(job.id);
      if (current.status === "cancelled") {
        return current;
      }
      return this.#store.update(job.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: {
          code: "WORKFLOW_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  async runNext(kind?: DaemonJobKind): Promise<DaemonJob | null> {
    const jobs = await this.#store.list();
    const next = jobs.find((job) => job.status === "queued" && (!kind || job.kind === kind));
    return next ? this.run(next.id) : null;
  }

  async #getRequired(jobId: string): Promise<DaemonJob> {
    const job = await this.#store.get(jobId);
    if (!job) {
      throw new Error(`Daemon job not found: ${jobId}`);
    }
    return job;
  }
}

function toCreateJobInput(input: EnqueueDaemonJobInput): CreateDaemonJobInput {
  return {
    kind: input.kind,
    ...(input.input === undefined ? {} : { input: input.input }),
  };
}

function isTerminal(status: DaemonJob["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

import type {
  CreateDaemonJobInput,
  DaemonJob,
  DaemonJobKind,
  JsonDaemonJobStore,
} from "./JobStore.js";

export interface EnqueueDaemonJobInput {
  readonly kind: DaemonJobKind;
  readonly input?: Record<string, unknown>;
}

export class DaemonJobRunner {
  readonly #store: JsonDaemonJobStore;

  constructor(store: JsonDaemonJobStore) {
    this.#store = store;
  }

  async enqueue(input: EnqueueDaemonJobInput): Promise<DaemonJob> {
    // 中文注释：当前 L6 只创建 durable job shell，真实 bootstrap/rescan 在 L8 workflow 接入。
    return this.#store.create(toCreateJobInput(input));
  }

  async cancel(jobId: string): Promise<DaemonJob> {
    return this.#store.cancel(jobId);
  }

  async markInterrupted(): Promise<DaemonJob[]> {
    return this.#store.markInterrupted();
  }
}

function toCreateJobInput(input: EnqueueDaemonJobInput): CreateDaemonJobInput {
  return {
    kind: input.kind,
    ...(input.input === undefined ? {} : { input: input.input }),
  };
}

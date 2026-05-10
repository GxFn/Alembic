import { MainlineConcurrencyLimiter, type MainlineConcurrencySnapshot } from "./Concurrency.js";

export interface MainlineWorkerTask<Input = unknown> {
  readonly id: string;
  readonly kind: string;
  readonly input: Input;
  readonly priority?: number;
}

export interface MainlineWorkerResult<Output = unknown> {
  readonly taskId: string;
  readonly durationMs: number;
  readonly output?: Output;
  readonly error?: string;
}

export interface MainlineWorkerPoolSnapshot {
  readonly mode: "inline" | "unavailable";
  readonly handlers: string[];
  readonly concurrency?: MainlineConcurrencySnapshot;
}

export type MainlineWorkerHandler<Input = unknown, Output = unknown> = (
  task: MainlineWorkerTask<Input>,
) => Output | Promise<Output>;

export interface MainlineWorkerPool {
  run<Input = unknown, Output = unknown>(
    task: MainlineWorkerTask<Input>,
  ): Promise<MainlineWorkerResult<Output>>;
  snapshot(): MainlineWorkerPoolSnapshot;
  dispose(): void;
}

/**
 * InlineWorkerPool 是“多线程能力”的主线端口默认实现之一。
 * 它先用同进程 handler 跑通调度语义；真实 Worker Threads 后续只需实现同一个端口。
 */
export class InlineWorkerPool implements MainlineWorkerPool {
  readonly #handlers = new Map<string, MainlineWorkerHandler>();
  readonly #concurrency: MainlineConcurrencyLimiter;

  constructor(options: { concurrency?: MainlineConcurrencyLimiter; maxConcurrency?: number } = {}) {
    this.#concurrency =
      options.concurrency ?? new MainlineConcurrencyLimiter(options.maxConcurrency ?? 2);
  }

  registerHandler<Input = unknown, Output = unknown>(
    kind: string,
    handler: MainlineWorkerHandler<Input, Output>,
  ): void {
    this.#handlers.set(kind, handler as MainlineWorkerHandler);
  }

  async run<Input = unknown, Output = unknown>(
    task: MainlineWorkerTask<Input>,
  ): Promise<MainlineWorkerResult<Output>> {
    const startedAt = Date.now();
    const handler = this.#handlers.get(task.kind) as
      | MainlineWorkerHandler<Input, Output>
      | undefined;
    if (!handler) {
      return {
        taskId: task.id,
        durationMs: Date.now() - startedAt,
        error: `Mainline worker handler not registered: ${task.kind}`,
      };
    }

    return this.#concurrency.run(async () => {
      try {
        const output = await handler(task);
        return {
          taskId: task.id,
          durationMs: Date.now() - startedAt,
          output,
        };
      } catch (error) {
        return {
          taskId: task.id,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }

  snapshot(): MainlineWorkerPoolSnapshot {
    return {
      mode: "inline",
      handlers: [...this.#handlers.keys()].sort(),
      concurrency: this.#concurrency.snapshot(),
    };
  }

  dispose(): void {}
}

/**
 * UnavailableWorkerPool 明确表示尚未接入真正 Worker adapter。
 * 这比 mock 执行更安全：上层可以看到能力缺口，而不是误以为后台并行已经存在。
 */
export class UnavailableWorkerPool implements MainlineWorkerPool {
  readonly #reason: string;

  constructor(reason = "Mainline worker pool adapter is not configured.") {
    this.#reason = reason;
  }

  async run<Input = unknown, Output = unknown>(
    task: MainlineWorkerTask<Input>,
  ): Promise<MainlineWorkerResult<Output>> {
    return {
      taskId: task.id,
      durationMs: 0,
      error: this.#reason,
    };
  }

  snapshot(): MainlineWorkerPoolSnapshot {
    return {
      mode: "unavailable",
      handlers: [],
    };
  }

  dispose(): void {}
}

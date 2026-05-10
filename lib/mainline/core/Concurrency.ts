export interface MainlineConcurrencySnapshot {
  readonly maxConcurrency: number;
  readonly active: number;
  readonly queued: number;
}

/**
 * MainlineConcurrencyLimiter 是运行期/编译期共用的轻量并发闸门。
 * 它只限制任务进入数量，不负责重试、优先级或进程级调度，避免底座变成重型任务系统。
 */
export class MainlineConcurrencyLimiter {
  readonly #maxConcurrency: number;
  readonly #queue: Array<() => void> = [];
  #active = 0;

  constructor(maxConcurrency = 4) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error(`Invalid mainline concurrency: ${maxConcurrency}`);
    }
    this.#maxConcurrency = maxConcurrency;
  }

  async run<T>(task: () => T | Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  snapshot(): MainlineConcurrencySnapshot {
    return {
      maxConcurrency: this.#maxConcurrency,
      active: this.#active,
      queued: this.#queue.length,
    };
  }

  async #acquire(): Promise<void> {
    if (this.#active < this.#maxConcurrency) {
      this.#active += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.#queue.push(() => {
        this.#active += 1;
        resolve();
      });
    });
  }

  #release(): void {
    this.#active = Math.max(0, this.#active - 1);
    const next = this.#queue.shift();
    if (next) {
      next();
    }
  }
}

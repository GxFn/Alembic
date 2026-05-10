export interface MainlineDisposable {
  dispose(): Promise<void> | void;
}

export interface MainlineStartable extends MainlineDisposable {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

export interface MainlineDisposerSnapshot {
  readonly disposed: boolean;
  readonly resourceCount: number;
}

/**
 * MainlineDisposer 统一释放 timer、文件句柄、adapter 等资源。
 * 释放顺序为后进先出，便于让后注册的上层资源先退出。
 */
export class MainlineDisposer implements MainlineDisposable {
  readonly #resources: MainlineDisposable[] = [];
  #disposed = false;

  add<T extends MainlineDisposable>(resource: T): T {
    if (this.#disposed) {
      throw new Error("MainlineDisposer has already been disposed.");
    }
    this.#resources.push(resource);
    return resource;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;

    const errors: unknown[] = [];
    for (const resource of [...this.#resources].reverse()) {
      try {
        await resource.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#resources.length = 0;

    if (errors.length > 0) {
      throw new AggregateError(errors, "MainlineDisposer failed to dispose all resources.");
    }
  }

  snapshot(): MainlineDisposerSnapshot {
    return {
      disposed: this.#disposed,
      resourceCount: this.#resources.length,
    };
  }
}

import { MainlineAbortError, MainlineTimeoutError } from "./Errors.js";
import type { MainlineDisposable } from "./Lifecycle.js";

export interface MainlineOperationScopeOptions {
  readonly id?: string;
  readonly timeoutMs?: number;
  readonly deadlineAt?: number;
  readonly parentSignal?: AbortSignal | null;
  readonly now?: () => number;
}

export interface MainlineOperationSnapshot {
  readonly id: string;
  readonly startedAt: number;
  readonly deadlineAt?: number;
  readonly aborted: boolean;
  readonly reason?: string;
}

/**
 * MainlineOperationScope 统一描述一次扫描、注入、查询或 adapter 调用的取消边界。
 * 它不启动任务系统，只提供 AbortSignal、deadline 和显式 dispose。
 */
export class MainlineOperationScope implements MainlineDisposable {
  readonly id: string;
  readonly startedAt: number;
  readonly deadlineAt?: number;
  readonly #now: () => number;
  readonly #controller = new AbortController();
  readonly #parentSignal: AbortSignal | null | undefined;
  readonly #onParentAbort: () => void;
  #timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  #reason: string | undefined;
  #timedOut = false;

  constructor(options: MainlineOperationScopeOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.id = options.id ?? `mainline-op-${Math.random().toString(16).slice(2)}`;
    this.startedAt = this.#now();
    const deadlineAt =
      options.deadlineAt ??
      (options.timeoutMs === undefined ? undefined : this.startedAt + options.timeoutMs);
    if (deadlineAt !== undefined) {
      this.deadlineAt = deadlineAt;
    }
    this.#parentSignal = options.parentSignal;
    this.#onParentAbort = () => {
      this.abort("Parent operation aborted.");
    };

    if (this.#parentSignal) {
      if (this.#parentSignal.aborted) {
        this.abort("Parent operation already aborted.");
      } else {
        this.#parentSignal.addEventListener("abort", this.#onParentAbort, { once: true });
      }
    }

    if (options.timeoutMs !== undefined) {
      this.#timeoutHandle = setTimeout(() => {
        this.#timedOut = true;
        this.abort(`Operation timed out after ${options.timeoutMs}ms.`);
      }, options.timeoutMs);
      if (
        typeof this.#timeoutHandle === "object" &&
        typeof this.#timeoutHandle.unref === "function"
      ) {
        this.#timeoutHandle.unref();
      }
    }
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  abort(reason = "Operation aborted."): void {
    if (this.#controller.signal.aborted) {
      return;
    }
    this.#reason = reason;
    this.#controller.abort(reason);
  }

  throwIfAborted(): void {
    if (this.#controller.signal.aborted) {
      const ErrorClass = this.#timedOut ? MainlineTimeoutError : MainlineAbortError;
      throw new ErrorClass(this.#reason ?? "Mainline operation aborted.", {
        id: this.id,
      });
    }
    if (this.deadlineAt !== undefined && this.#now() > this.deadlineAt) {
      this.#timedOut = true;
      this.abort(`Operation exceeded deadline ${this.deadlineAt}.`);
      throw new MainlineTimeoutError(this.#reason ?? "Mainline operation exceeded deadline.", {
        id: this.id,
        deadlineAt: this.deadlineAt,
      });
    }
  }

  snapshot(): MainlineOperationSnapshot {
    return {
      id: this.id,
      startedAt: this.startedAt,
      aborted: this.#controller.signal.aborted,
      ...(this.deadlineAt === undefined ? {} : { deadlineAt: this.deadlineAt }),
      ...(this.#reason === undefined ? {} : { reason: this.#reason }),
    };
  }

  dispose(): void {
    if (this.#timeoutHandle) {
      clearTimeout(this.#timeoutHandle);
      this.#timeoutHandle = null;
    }
    this.#parentSignal?.removeEventListener("abort", this.#onParentAbort);
  }
}

export type MainlineTimerKind = "timeout" | "interval";

export interface MainlineTimerOptions {
  readonly label?: string;
}

export interface MainlineTimerHandle {
  readonly id: string;
  readonly kind: MainlineTimerKind;
  readonly label: string | undefined;
  cancel(): void;
}

export interface MainlineTimerSnapshotEntry {
  readonly id: string;
  readonly kind: MainlineTimerKind;
  readonly label?: string;
}

export interface MainlineSchedulerSnapshot {
  readonly activeTimers: MainlineTimerSnapshotEntry[];
}

export interface MainlineScheduler {
  delay(ms: number, label?: string): Promise<void>;
  setTimeout(callback: () => void, ms: number, options?: MainlineTimerOptions): MainlineTimerHandle;
  setInterval(
    callback: () => void,
    ms: number,
    options?: MainlineTimerOptions,
  ): MainlineTimerHandle;
  dispose(): void;
  snapshot(): MainlineSchedulerSnapshot;
}

/**
 * MainlineSchedulerImpl 集中管理新主线的 timeout/interval。
 * 所有 timer 默认 unref，避免后台定时器阻止 CLI、测试或短任务自然退出。
 */
export class MainlineSchedulerImpl implements MainlineScheduler {
  readonly #timers = new Map<string, InternalTimerHandle>();
  #nextId = 0;

  delay(ms: number, label = "delay"): Promise<void> {
    return new Promise((resolve) => {
      this.setTimeout(resolve, ms, { label });
    });
  }

  setTimeout(
    callback: () => void,
    ms: number,
    options: MainlineTimerOptions = {},
  ): MainlineTimerHandle {
    const handle = this.#createHandle("timeout", options.label);
    const nativeHandle = setTimeout(() => {
      try {
        callback();
      } finally {
        handle.finish();
      }
    }, ms);

    handle.attach(nativeHandle);
    unrefIfPossible(nativeHandle);
    return handle;
  }

  setInterval(
    callback: () => void,
    ms: number,
    options: MainlineTimerOptions = {},
  ): MainlineTimerHandle {
    const handle = this.#createHandle("interval", options.label);
    const nativeHandle = setInterval(callback, ms);

    handle.attach(nativeHandle);
    unrefIfPossible(nativeHandle);
    return handle;
  }

  dispose(): void {
    for (const handle of [...this.#timers.values()]) {
      handle.cancel();
    }
    this.#timers.clear();
  }

  snapshot(): MainlineSchedulerSnapshot {
    return {
      activeTimers: [...this.#timers.values()]
        .map((timer) => ({
          id: timer.id,
          kind: timer.kind,
          ...(timer.label === undefined ? {} : { label: timer.label }),
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
  }

  #createHandle(kind: MainlineTimerKind, label?: string): InternalTimerHandle {
    const id = `${kind}-${++this.#nextId}`;
    const handle = new InternalTimerHandle(id, kind, label, () => {
      this.#timers.delete(id);
    });
    this.#timers.set(id, handle);
    return handle;
  }
}

class InternalTimerHandle implements MainlineTimerHandle {
  readonly id: string;
  readonly kind: MainlineTimerKind;
  readonly label: string | undefined;
  readonly #onDone: () => void;
  #nativeHandle: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | null = null;
  #done = false;

  constructor(id: string, kind: MainlineTimerKind, label: string | undefined, onDone: () => void) {
    this.id = id;
    this.kind = kind;
    this.label = label;
    this.#onDone = onDone;
  }

  attach(nativeHandle: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
    this.#nativeHandle = nativeHandle;
  }

  cancel(): void {
    if (this.#done) {
      return;
    }

    if (this.#nativeHandle) {
      if (this.kind === "interval") {
        clearInterval(this.#nativeHandle);
      } else {
        clearTimeout(this.#nativeHandle);
      }
    }

    this.finish();
  }

  finish(): void {
    if (this.#done) {
      return;
    }
    this.#done = true;
    this.#onDone();
  }
}

function unrefIfPossible(
  handle: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>,
): void {
  if (typeof handle === "object" && typeof handle.unref === "function") {
    handle.unref();
  }
}

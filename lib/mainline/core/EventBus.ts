export type MainlineEventPayload = Record<string, unknown>;
export type MainlineEventHandler<TPayload extends MainlineEventPayload = MainlineEventPayload> = (
  event: MainlineEvent<TPayload>,
) => void | Promise<void>;

export interface MainlineEvent<TPayload extends MainlineEventPayload = MainlineEventPayload> {
  readonly type: string;
  readonly source: string;
  readonly target?: string | null;
  readonly value?: number;
  readonly payload: TPayload;
  readonly timestamp: number;
}

export interface MainlineEventBusSnapshot {
  readonly emitCount: number;
  readonly listenerCount: number;
  readonly historySize: number;
}

const WILDCARD_EVENT = "*";

/**
 * MainlineEventBus 是新主线的同步事件/信号底座。
 * 它吸收旧 SignalBus 的精确匹配、多类型匹配和通配符能力，但不绑定旧信号枚举。
 */
export class MainlineEventBus {
  readonly #listeners = new Map<string, Set<MainlineEventHandler>>();
  readonly #history: MainlineEvent[];
  readonly #historyLimit: number;
  #emitCount = 0;

  constructor(options: { historyLimit?: number } = {}) {
    this.#historyLimit = options.historyLimit ?? 100;
    this.#history = [];
  }

  emit<TPayload extends MainlineEventPayload>(event: MainlineEvent<TPayload>): void {
    this.#emitCount += 1;
    this.#record(event);

    for (const handler of this.#matchingHandlers(event.type)) {
      try {
        void handler(event);
      } catch {
        // 事件消费者不能阻断主流程；错误应由消费者自己记录。
      }
    }
  }

  async emitAsync<TPayload extends MainlineEventPayload>(
    event: MainlineEvent<TPayload>,
  ): Promise<void> {
    this.#emitCount += 1;
    this.#record(event);

    for (const handler of this.#matchingHandlers(event.type)) {
      try {
        await handler(event);
      } catch {
        // 与同步分发保持一致：消费者异常不扩散。
      }
    }
  }

  send<TPayload extends MainlineEventPayload>(
    type: string,
    source: string,
    payload: TPayload,
    options: { target?: string | null; value?: number; timestamp?: number } = {},
  ): void {
    this.emit({
      type,
      source,
      target: options.target ?? null,
      payload,
      timestamp: options.timestamp ?? Date.now(),
      ...(options.value === undefined ? {} : { value: options.value }),
    });
  }

  subscribe(pattern: string, handler: MainlineEventHandler): () => void {
    const types = pattern === WILDCARD_EVENT ? [WILDCARD_EVENT] : pattern.split("|");
    for (const type of types) {
      const normalized = type.trim();
      if (!normalized) {
        continue;
      }
      let handlers = this.#listeners.get(normalized);
      if (!handlers) {
        handlers = new Set();
        this.#listeners.set(normalized, handlers);
      }
      handlers.add(handler);
    }

    return () => {
      for (const type of types) {
        this.#listeners.get(type.trim())?.delete(handler);
      }
    };
  }

  history(limit = 20): MainlineEvent[] {
    return this.#history.slice(-limit).map((event) => ({
      ...event,
      payload: { ...event.payload },
    }));
  }

  clear(): void {
    this.#listeners.clear();
    this.#history.length = 0;
    this.#emitCount = 0;
  }

  snapshot(): MainlineEventBusSnapshot {
    let listenerCount = 0;
    for (const handlers of this.#listeners.values()) {
      listenerCount += handlers.size;
    }
    return {
      emitCount: this.#emitCount,
      listenerCount,
      historySize: this.#history.length,
    };
  }

  #matchingHandlers(type: string): MainlineEventHandler[] {
    return [...(this.#listeners.get(type) ?? []), ...(this.#listeners.get(WILDCARD_EVENT) ?? [])];
  }

  #record(event: MainlineEvent): void {
    this.#history.push({
      ...event,
      payload: { ...event.payload },
    });
    if (this.#history.length > this.#historyLimit) {
      this.#history.splice(0, this.#history.length - this.#historyLimit);
    }
  }
}

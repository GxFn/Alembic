export type HookEvent =
  | "agent:iteration:before"
  | "agent:iteration:after"
  | "agent:exit"
  | "agent:finalize"
  | "tool:execute:before"
  | "tool:execute:after"
  | "context:compact:before"
  | "context:compact:after"
  | "exploration:phase_transition"
  | "exploration:budget_warning"
  | "llm:call:before"
  | "llm:call:after";

export interface HookPayloadMap {
  "agent:iteration:before": { iteration: number; phase?: string };
  "agent:iteration:after": { iteration: number; hadToolCalls: boolean; hadText: boolean };
  "agent:exit": { reason: string; iteration: number; detail?: string };
  "agent:finalize": { reply: string; iterations: number; toolCallCount: number };
  "tool:execute:before": { toolId: string; args: Record<string, unknown>; callId: string };
  "tool:execute:after": { toolId: string; ok: boolean; durationMs: number; callId: string };
  "context:compact:before": { level: number; usage: number };
  "context:compact:after": { level: number; removed: number; usage: number };
  "exploration:phase_transition": { from: string; to: string; iteration: number };
  "exploration:budget_warning": { used: number; total: number; iteration: number };
  "llm:call:before": { iteration: number; toolChoice: string };
  "llm:call:after": {
    iteration: number;
    hasToolCalls: boolean;
    hasText: boolean;
    inputTokens?: number;
    outputTokens?: number;
  };
}

export type HookHandler<E extends HookEvent> = (
  payload: HookPayloadMap[E],
) => undefined | boolean | Promise<undefined | boolean>;

interface HookEntry<E extends HookEvent = HookEvent> {
  readonly event: E;
  readonly handler: HookHandler<E>;
  readonly priority: number;
  readonly once: boolean;
  readonly id: string;
}

export interface HookLogger {
  warn(message: string): void;
}

let hookCounter = 0;

export class HookSystem {
  readonly #hooks = new Map<HookEvent, HookEntry[]>();
  readonly #logger: HookLogger;

  constructor(logger: HookLogger = console) {
    this.#logger = logger;
  }

  on<E extends HookEvent>(
    event: E,
    handler: HookHandler<E>,
    opts: { readonly priority?: number; readonly once?: boolean } = {},
  ): () => void {
    hookCounter += 1;
    const id = `hook_${hookCounter}`;
    const entry: HookEntry<E> = {
      event,
      handler,
      priority: opts.priority ?? 100,
      once: opts.once ?? false,
      id,
    };
    const list = this.#hooks.get(event) ?? [];
    list.push(entry as unknown as HookEntry);
    list.sort((a, b) => a.priority - b.priority);
    this.#hooks.set(event, list);
    return () => {
      const index = list.findIndex((item) => item.id === id);
      if (index >= 0) {
        list.splice(index, 1);
      }
    };
  }

  once<E extends HookEvent>(event: E, handler: HookHandler<E>, priority?: number): () => void {
    return this.on(event, handler, { ...(priority !== undefined ? { priority } : {}), once: true });
  }

  async emit<E extends HookEvent>(event: E, payload: HookPayloadMap[E]): Promise<boolean> {
    const list = this.#hooks.get(event);
    if (!list || list.length === 0) {
      return true;
    }
    const toRemove: string[] = [];
    let blocked = false;
    for (const entry of list) {
      try {
        const result = await entry.handler(payload as never);
        if (event === "tool:execute:before" && result === false) {
          blocked = true;
        }
      } catch (error) {
        this.#logger.warn(
          `[HookSystem] hook error on ${event} (${entry.id}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (entry.once) {
        toRemove.push(entry.id);
      }
    }
    this.#removeIds(list, toRemove);
    return !blocked;
  }

  emitSync<E extends HookEvent>(event: E, payload: HookPayloadMap[E]): void {
    const list = this.#hooks.get(event);
    if (!list || list.length === 0) {
      return;
    }
    const toRemove: string[] = [];
    for (const entry of list) {
      try {
        entry.handler(payload as never);
      } catch (error) {
        this.#logger.warn(
          `[HookSystem] hook error on ${event} (${entry.id}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (entry.once) {
        toRemove.push(entry.id);
      }
    }
    this.#removeIds(list, toRemove);
  }

  clear(event?: HookEvent): void {
    if (event) {
      this.#hooks.delete(event);
    } else {
      this.#hooks.clear();
    }
  }

  hookCount(event?: HookEvent): number {
    if (event) {
      return this.#hooks.get(event)?.length ?? 0;
    }
    let total = 0;
    for (const list of this.#hooks.values()) {
      total += list.length;
    }
    return total;
  }

  #removeIds(list: HookEntry[], ids: readonly string[]): void {
    for (const id of ids) {
      const index = list.findIndex((entry) => entry.id === id);
      if (index >= 0) {
        list.splice(index, 1);
      }
    }
  }
}

export function registerDefaultHooks(
  hookSystem: HookSystem,
  agentId?: string,
  bus?: { publish(type: string, payload: unknown, opts?: { source?: string }): void } | null,
): void {
  if (!bus) {
    return;
  }
  const sourceOptions = agentId ? { source: agentId } : undefined;

  hookSystem.on("llm:call:before", (payload) => {
    bus.publish(
      "llm:call:start",
      { iteration: payload.iteration, toolChoice: payload.toolChoice },
      sourceOptions,
    );
    return undefined;
  });

  hookSystem.on("llm:call:after", (payload) => {
    bus.publish(
      "llm:call:end",
      {
        hasToolCalls: payload.hasToolCalls,
        hasText: payload.hasText,
        usage: { inputTokens: payload.inputTokens, outputTokens: payload.outputTokens },
      },
      sourceOptions,
    );
    return undefined;
  });

  hookSystem.on("agent:exit", (payload) => {
    bus.publish(
      "step:completed",
      { reason: payload.reason, iteration: payload.iteration, detail: payload.detail },
      sourceOptions,
    );
    return undefined;
  });
}

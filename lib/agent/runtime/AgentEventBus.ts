import { EventEmitter } from "node:events";

export const AgentEvents = Object.freeze({
  STARTED: "agent:started",
  PROGRESS: "agent:progress",
  COMPLETED: "agent:completed",
  FAILED: "agent:failed",
  TOOL_CALL_STARTED: "tool:call:start",
  TOOL_CALL_COMPLETED: "tool:call:end",
  LLM_CALL_STARTED: "llm:call:start",
  LLM_CALL_COMPLETED: "llm:call:end",
  STEP_COMPLETED: "step:completed",
  STATE_CHANGED: "state:changed",
} as const);

export interface AgentEventEnvelope<TPayload = unknown> {
  readonly id: string;
  readonly type: string;
  readonly payload: TPayload;
  readonly source?: string;
  readonly timestamp: number;
}

export type AgentEventHandler<TPayload = unknown> = (
  event: AgentEventEnvelope<TPayload>,
) => void | Promise<void>;

let eventSequence = 0;

export class AgentEventBus {
  readonly #emitter = new EventEmitter();
  readonly #history: AgentEventEnvelope[] = [];

  publish<TPayload>(
    type: string,
    payload: TPayload,
    opts: { readonly source?: string } = {},
  ): AgentEventEnvelope<TPayload> {
    eventSequence += 1;
    const envelope: AgentEventEnvelope<TPayload> = {
      id: `evt_${eventSequence}`,
      type,
      payload,
      ...(opts.source ? { source: opts.source } : {}),
      timestamp: Date.now(),
    };
    this.#history.push(envelope);
    this.#emitter.emit(type, envelope);
    this.#emitter.emit("*", envelope);
    return envelope;
  }

  subscribe<TPayload = unknown>(type: string, handler: AgentEventHandler<TPayload>): () => void {
    const wrapped = (event: AgentEventEnvelope<TPayload>) => {
      void handler(event);
    };
    this.#emitter.on(type, wrapped);
    return () => {
      this.#emitter.off(type, wrapped);
    };
  }

  once<TPayload = unknown>(type: string, handler: AgentEventHandler<TPayload>): () => void {
    const wrapped = (event: AgentEventEnvelope<TPayload>) => {
      void handler(event);
    };
    this.#emitter.once(type, wrapped);
    return () => {
      this.#emitter.off(type, wrapped);
    };
  }

  request<TPayload = unknown>(
    type: string,
    payload: TPayload,
    opts: { readonly source?: string } = {},
  ): AgentEventEnvelope<TPayload> {
    return this.publish(type, payload, opts);
  }

  clear(): void {
    this.#history.length = 0;
    this.#emitter.removeAllListeners();
  }

  getStats(): { readonly listeners: number; readonly events: number } {
    return {
      listeners: this.#emitter
        .eventNames()
        .reduce((total, name) => total + this.#emitter.listenerCount(name), 0),
      events: this.#history.length,
    };
  }

  history(): AgentEventEnvelope[] {
    return this.#history.map((event) => ({ ...event }));
  }
}

export const agentEventBus = new AgentEventBus();

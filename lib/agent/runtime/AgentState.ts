import { EventEmitter } from "node:events";

export type TransitionGuard = (data: Record<string, unknown>) => boolean;
export type TransitionAction = (
  data: Record<string, unknown>,
  payload: Record<string, unknown>,
) => void;

export interface Transition {
  readonly from: string;
  readonly to: string;
  readonly event: string;
  readonly guard?: TransitionGuard;
  readonly action?: TransitionAction;
}

export interface HistoryEntry {
  readonly phase: string;
  readonly data: Record<string, unknown>;
  readonly timestamp: number;
  readonly event?: string;
  readonly from?: string;
}

export interface AgentStateSnapshot {
  readonly phase?: string;
  readonly data?: Record<string, unknown>;
  readonly history?: readonly HistoryEntry[];
}

export const AgentPhase = Object.freeze({
  IDLE: "idle",
  PLANNING: "planning",
  EXECUTING: "executing",
  REFLECTING: "reflecting",
  WAITING_INPUT: "waiting_input",
  HANDOFF: "handoff",
  COMPLETED: "completed",
  FAILED: "failed",
  ABORTED: "aborted",
});

const DEFAULT_TRANSITIONS: readonly Transition[] = [
  { from: AgentPhase.IDLE, to: AgentPhase.PLANNING, event: "start" },
  { from: AgentPhase.PLANNING, to: AgentPhase.EXECUTING, event: "plan_ready" },
  { from: AgentPhase.EXECUTING, to: AgentPhase.REFLECTING, event: "step_done" },
  { from: AgentPhase.REFLECTING, to: AgentPhase.EXECUTING, event: "continue" },
  { from: AgentPhase.REFLECTING, to: AgentPhase.COMPLETED, event: "finish" },
  { from: AgentPhase.EXECUTING, to: AgentPhase.COMPLETED, event: "finish" },
  { from: AgentPhase.EXECUTING, to: AgentPhase.WAITING_INPUT, event: "need_input" },
  { from: AgentPhase.WAITING_INPUT, to: AgentPhase.EXECUTING, event: "input_received" },
  { from: AgentPhase.EXECUTING, to: AgentPhase.HANDOFF, event: "handoff" },
  { from: AgentPhase.HANDOFF, to: AgentPhase.EXECUTING, event: "handoff_done" },
  // 任意阶段都允许中止或失败，方便外层超时/取消逻辑收敛到终态。
  { from: "*", to: AgentPhase.ABORTED, event: "abort" },
  { from: "*", to: AgentPhase.FAILED, event: "error" },
];

export class AgentState extends EventEmitter {
  #phase: string;
  #data: Record<string, unknown>;
  #transitions: readonly Transition[];
  #history: HistoryEntry[];
  readonly #keepHistory: boolean;

  constructor({
    initialData = {},
    initialPhase = AgentPhase.IDLE,
    transitions = [],
    keepHistory = true,
  }: {
    readonly initialData?: Record<string, unknown>;
    readonly initialPhase?: string;
    readonly transitions?: readonly Transition[];
    readonly keepHistory?: boolean;
  } = {}) {
    super();
    this.#phase = initialPhase;
    this.#data = { ...initialData };
    this.#transitions = [...DEFAULT_TRANSITIONS, ...transitions];
    this.#keepHistory = keepHistory;
    this.#history = keepHistory
      ? [{ phase: initialPhase, data: { ...initialData }, timestamp: Date.now() }]
      : [];
  }

  get phase(): string {
    return this.#phase;
  }

  get data(): Record<string, unknown> {
    return { ...this.#data };
  }

  get history(): HistoryEntry[] {
    return this.#history.map((entry) => ({ ...entry, data: { ...entry.data } }));
  }

  get isTerminal(): boolean {
    return new Set<string>([AgentPhase.COMPLETED, AgentPhase.FAILED, AgentPhase.ABORTED]).has(
      this.#phase,
    );
  }

  send(event: string, payload: Record<string, unknown> = {}): boolean {
    const transition = this.#findTransition(event);
    if (!transition || (transition.guard && !transition.guard(this.#data))) {
      return false;
    }
    const previousPhase = this.#phase;
    this.#phase = transition.to;
    this.#data = { ...this.#data, ...payload };
    transition.action?.(this.#data, payload);
    if (this.#keepHistory) {
      this.#history.push({
        phase: this.#phase,
        data: { ...this.#data },
        timestamp: Date.now(),
        event,
        from: previousPhase,
      });
    }
    this.emit("transition", { from: previousPhase, to: this.#phase, event, payload });
    this.emit(`phase:${this.#phase}`, { from: previousPhase, event, payload });
    return true;
  }

  update(patch: Record<string, unknown>): void {
    this.#data = { ...this.#data, ...patch };
    this.emit("update", { phase: this.#phase, patch });
  }

  availableEvents(): string[] {
    return this.#transitions
      .filter((transition) => transition.from === this.#phase || transition.from === "*")
      .map((transition) => transition.event);
  }

  toJSON(): AgentStateSnapshot {
    return {
      phase: this.#phase,
      data: { ...this.#data },
      history: this.history,
    };
  }

  static fromJSON(
    snapshot: AgentStateSnapshot,
    opts: { readonly transitions?: readonly Transition[]; readonly keepHistory?: boolean } = {},
  ): AgentState {
    const state = new AgentState({
      initialData: snapshot.data ?? {},
      initialPhase: snapshot.phase ?? AgentPhase.IDLE,
      transitions: opts.transitions ?? [],
      keepHistory: opts.keepHistory ?? true,
    });
    if (snapshot.history) {
      state.#history = snapshot.history.map((entry) => ({ ...entry, data: { ...entry.data } }));
    }
    return state;
  }

  #findTransition(event: string): Transition | undefined {
    return (
      this.#transitions.find(
        (transition) => transition.from === this.#phase && transition.event === event,
      ) ??
      this.#transitions.find((transition) => transition.from === "*" && transition.event === event)
    );
  }
}

export default AgentState;

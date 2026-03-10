/**
 * AgentState — 类型安全的 Agent 状态机
 *
 * 借鉴 LangGraph StateGraph + Anthropic Agentic Patterns:
 *   - 每个 Agent 拥有独立的 typed state
 *   - 状态转移通过声明式 transitions 定义
 *   - 支持 guard 条件（类似 XState）
 *   - 内置事件发射（状态变更通知）
 *
 * 设计原则:
 *   1. 不可变更新 — 每次 transition 返回新 state snapshot
 *   2. 可溯源 — 保留完整状态历史（可选）
 *   3. 可序列化 — state 可 JSON 化，支持持久化/恢复
 *
 * @module AgentState
 */

import { EventEmitter } from 'node:events';

/** Guard condition: returns true if transition is allowed */
type TransitionGuard = (data: Record<string, unknown>) => boolean;
/** Side-effect action executed after transition */
type TransitionAction = (data: Record<string, unknown>, payload: Record<string, unknown>) => void;

/** State transition definition */
interface Transition {
  from: string;
  to: string;
  event: string;
  guard?: TransitionGuard;
  action?: TransitionAction;
}

/** History entry for state changes */
interface HistoryEntry {
  phase: string;
  data: Record<string, unknown>;
  timestamp: number;
  event?: string;
  from?: string;
}

/** Snapshot used by toJSON / fromJSON */
interface AgentStateSnapshot {
  phase?: string;
  data?: Record<string, unknown>;
  history?: HistoryEntry[];
}

/** Agent 执行阶段枚举 */
export const AgentPhase = Object.freeze({
  IDLE: 'idle',
  PLANNING: 'planning',
  EXECUTING: 'executing',
  REFLECTING: 'reflecting',
  WAITING_INPUT: 'waiting_input',
  HANDOFF: 'handoff',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ABORTED: 'aborted',
});

/** 状态转移定义 */

/** 默认状态转移图（适用于所有 Agent 模式，可在子类中扩展） */
const DEFAULT_TRANSITIONS = [
  { from: AgentPhase.IDLE, to: AgentPhase.PLANNING, event: 'start' },
  { from: AgentPhase.PLANNING, to: AgentPhase.EXECUTING, event: 'plan_ready' },
  { from: AgentPhase.EXECUTING, to: AgentPhase.REFLECTING, event: 'step_done' },
  { from: AgentPhase.REFLECTING, to: AgentPhase.EXECUTING, event: 'continue' },
  { from: AgentPhase.REFLECTING, to: AgentPhase.COMPLETED, event: 'finish' },
  { from: AgentPhase.EXECUTING, to: AgentPhase.COMPLETED, event: 'finish' },
  { from: AgentPhase.EXECUTING, to: AgentPhase.WAITING_INPUT, event: 'need_input' },
  { from: AgentPhase.WAITING_INPUT, to: AgentPhase.EXECUTING, event: 'input_received' },
  { from: AgentPhase.EXECUTING, to: AgentPhase.HANDOFF, event: 'handoff' },
  { from: AgentPhase.HANDOFF, to: AgentPhase.EXECUTING, event: 'handoff_done' },
  // 任意阶段可中止/失败
  { from: '*', to: AgentPhase.ABORTED, event: 'abort' },
  { from: '*', to: AgentPhase.FAILED, event: 'error' },
];

export class AgentState extends EventEmitter {
  /** 当前阶段 */
  #phase: string;
  /** 用户自定义状态数据 */
  #data: Record<string, unknown>;
  #transitions: Transition[];
  /** >} */
  #history: HistoryEntry[];
  /** 是否保留历史 */
  #keepHistory: boolean;

  /**
   * @param [opts.initialData={}] 初始状态数据
   * @param [opts.initialPhase='idle'] 初始阶段
   * @param [opts.transitions] 自定义转移定义（合并到默认转移上）
   * @param [opts.keepHistory=true] 是否保留状态历史
   */
  constructor({
    initialData = {},
    initialPhase = AgentPhase.IDLE as string,
    transitions = [] as Transition[],
    keepHistory = true,
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

  // ─── 公共 API ────────────────────────────────

  /** 当前阶段 */
  get phase() {
    return this.#phase;
  }

  /** 当前状态数据（只读 copy） */
  get data() {
    return { ...this.#data };
  }

  /** 状态历史 */
  get history() {
    return [...this.#history];
  }

  /** Agent 是否处于终态 */
  get isTerminal() {
    return ([AgentPhase.COMPLETED, AgentPhase.FAILED, AgentPhase.ABORTED] as string[]).includes(
      this.#phase
    );
  }

  /**
   * 触发事件，尝试状态转移
   * @param event 事件名
   * @param [payload={}] 附加数据（合并到 state.data）
   * @returns 是否成功转移
   */
  send(event: string, payload: Record<string, unknown> = {}) {
    const transition = this.#findTransition(event);
    if (!transition) {
      return false;
    }

    // Guard 检查
    if (transition.guard && !transition.guard(this.#data)) {
      return false;
    }

    const prevPhase = this.#phase;
    this.#phase = transition.to;
    this.#data = { ...this.#data, ...payload };

    // 执行副作用
    if (transition.action) {
      transition.action(this.#data, payload);
    }

    // 记录历史
    if (this.#keepHistory) {
      this.#history.push({
        phase: this.#phase,
        data: { ...this.#data },
        timestamp: Date.now(),
        event,
        from: prevPhase,
      });
    }

    // 发射事件
    this.emit('transition', { from: prevPhase, to: this.#phase, event, payload });
    this.emit(`phase:${this.#phase}`, { from: prevPhase, event, payload });

    return true;
  }

  /**
   * 直接更新状态数据（不触发阶段转移）
   * @param patch 要合并的数据
   */
  update(patch: Record<string, unknown>) {
    this.#data = { ...this.#data, ...patch };
    this.emit('update', { phase: this.#phase, patch });
  }

  /** 获取当前阶段可用的事件列表 */
  availableEvents() {
    return this.#transitions
      .filter((t) => t.from === this.#phase || t.from === '*')
      .map((t) => t.event);
  }

  /** 导出为可序列化对象 */
  toJSON() {
    return {
      phase: this.#phase,
      data: this.#data,
      history: this.#history,
    };
  }

  /** 从序列化数据恢复 */
  static fromJSON(
    snapshot: AgentStateSnapshot,
    opts: { transitions?: Transition[]; keepHistory?: boolean } = {}
  ) {
    const state = new AgentState({
      initialData: snapshot.data || {},
      initialPhase: snapshot.phase || AgentPhase.IDLE,
      transitions: opts.transitions || [],
      keepHistory: opts.keepHistory ?? true,
    });
    if (snapshot.history) {
      state.#history = snapshot.history;
    }
    return state;
  }

  // ─── 私有方法 ────────────────────────────────

  #findTransition(event: string) {
    // 精确匹配优先
    const exact = this.#transitions.find((t) => t.from === this.#phase && t.event === event);
    if (exact) {
      return exact;
    }
    // 通配符匹配
    return this.#transitions.find((t) => t.from === '*' && t.event === event);
  }
}

export default AgentState;

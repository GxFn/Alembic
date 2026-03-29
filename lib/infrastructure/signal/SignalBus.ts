/**
 * SignalBus — 统一信号总线
 *
 * Phase 0 核心基础设施。所有子系统（Guard、Search、Agent、Governance）
 * 通过 Signal Bus 发射和消费结构化信号，替代各自为政的事件分发。
 *
 * 设计公理：
 *   - 同步分发，<0.1ms per emit（消费者自行决定是否 buffer）
 *   - 支持精确类型订阅和通配符 '*'
 *   - 支持 pattern 订阅 'guard|search|usage'
 *
 * @module infrastructure/signal/SignalBus
 */

// ── Signal Types ────────────────────────────────────

/** 信号类型枚举 */
export type SignalType =
  | 'guard'
  | 'guard_blind_spot'
  | 'search'
  | 'usage'
  | 'lifecycle'
  | 'exploration'
  | 'quality'
  | 'panorama'
  | 'decay'
  | 'forge'
  | 'intent'
  | 'anomaly';

/** 信号结构 */
export interface Signal {
  /** 信号类别 */
  type: SignalType;
  /** 产出模块标识 */
  source: string;
  /** 关联 Recipe/Module ID（可选） */
  target: string | null;
  /** 标准化信号值 0-1 */
  value: number;
  /** 原始数据载荷 */
  metadata: Record<string, unknown>;
  /** 信号产生时间戳（ms） */
  timestamp: number;
}

/** 信号处理器 */
export type SignalHandler = (signal: Signal) => void;

/** 通配符常量 */
const WILDCARD = '*';

// ── SignalBus ───────────────────────────────────────

export class SignalBus {
  readonly #listeners = new Map<string, Set<SignalHandler>>();
  #emitCount = 0;

  /**
   * 发射信号。同步分发给所有匹配的订阅者。
   *
   * @param signal 完整的 Signal 对象
   */
  emit(signal: Signal): void {
    this.#emitCount++;

    // 精确类型匹配
    const exact = this.#listeners.get(signal.type);
    if (exact) {
      for (const handler of exact) {
        try {
          handler(signal);
        } catch {
          // 消费者异常不阻断信号分发
        }
      }
    }

    // 通配符匹配
    const wildcard = this.#listeners.get(WILDCARD);
    if (wildcard) {
      for (const handler of wildcard) {
        try {
          handler(signal);
        } catch {
          // 消费者异常不阻断信号分发
        }
      }
    }
  }

  /**
   * 订阅信号。支持三种模式：
   * - 精确类型: `subscribe('guard', handler)`
   * - 多类型:   `subscribe('guard|search|usage', handler)`
   * - 通配符:   `subscribe('*', handler)`
   *
   * @returns 取消订阅函数
   */
  subscribe(pattern: string, handler: SignalHandler): () => void {
    const types = pattern === WILDCARD ? [WILDCARD] : pattern.split('|');

    for (const type of types) {
      let set = this.#listeners.get(type);
      if (!set) {
        set = new Set();
        this.#listeners.set(type, set);
      }
      set.add(handler);
    }

    return () => {
      for (const type of types) {
        this.#listeners.get(type)?.delete(handler);
      }
    };
  }

  /**
   * 创建并发射信号的便捷方法。自动填充 timestamp。
   */
  send(
    type: SignalType,
    source: string,
    value: number,
    opts: { target?: string | null; metadata?: Record<string, unknown> } = {}
  ): void {
    this.emit({
      type,
      source,
      target: opts.target ?? null,
      value: Math.max(0, Math.min(1, value)),
      metadata: opts.metadata ?? {},
      timestamp: Date.now(),
    });
  }

  /** 已发射的信号总数（诊断用） */
  get emitCount(): number {
    return this.#emitCount;
  }

  /** 活跃订阅者数量（诊断用） */
  get listenerCount(): number {
    let count = 0;
    for (const set of this.#listeners.values()) {
      count += set.size;
    }
    return count;
  }

  /** 移除所有订阅者（测试用） */
  clear(): void {
    this.#listeners.clear();
    this.#emitCount = 0;
  }
}

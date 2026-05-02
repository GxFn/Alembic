/**
 * HookSystem — 统一事件与可扩展切点
 *
 * 替代碎片化的 4 个事件通道（AgentEventBus / EventBus / SignalBus / Pipeline Middleware），
 * 提供统一的 hook 注册和分发机制。
 *
 * 设计原则：
 *   - 类型安全：每个 HookEvent 有明确的 payload 类型
 *   - 可组合：支持 sync 和 async hook
 *   - 可拦截：tool:execute:before 支持 block（返回 false 阻止执行）
 *   - 兼容：通过 bridge 连接 AgentEventBus / SignalBus
 *
 * @module core/HookSystem
 */

import Logger from '#infra/logging/Logger.js';

// ── Hook Events ──

export type HookEvent =
  | 'agent:iteration:before'
  | 'agent:iteration:after'
  | 'agent:exit'
  | 'agent:finalize'
  | 'tool:execute:before'
  | 'tool:execute:after'
  | 'context:compact:before'
  | 'context:compact:after'
  | 'exploration:phase_transition'
  | 'exploration:budget_warning'
  | 'llm:call:before'
  | 'llm:call:after';

// ── Payload Types ──

export interface HookPayloadMap {
  'agent:iteration:before': { iteration: number; phase?: string };
  'agent:iteration:after': { iteration: number; hadToolCalls: boolean; hadText: boolean };
  'agent:exit': { reason: string; iteration: number; detail?: string };
  'agent:finalize': { reply: string; iterations: number; toolCallCount: number };
  'tool:execute:before': { toolId: string; args: Record<string, unknown>; callId: string };
  'tool:execute:after': { toolId: string; ok: boolean; durationMs: number; callId: string };
  'context:compact:before': { level: number; usage: number };
  'context:compact:after': { level: number; removed: number; usage: number };
  'exploration:phase_transition': { from: string; to: string; iteration: number };
  'exploration:budget_warning': { used: number; total: number; iteration: number };
  'llm:call:before': { iteration: number; toolChoice: string };
  'llm:call:after': {
    iteration: number;
    hasToolCalls: boolean;
    hasText: boolean;
    inputTokens?: number;
    outputTokens?: number;
  };
}

// ── Hook Handler Types ──

export type HookHandler<E extends HookEvent> = (
  payload: HookPayloadMap[E]
) => undefined | boolean | Promise<undefined | boolean>;

interface HookEntry<E extends HookEvent = HookEvent> {
  event: E;
  handler: HookHandler<E>;
  priority: number;
  once: boolean;
  id: string;
}

// ── HookSystem Class ──

let _hookCounter = 0;

export class HookSystem {
  readonly #hooks = new Map<HookEvent, HookEntry[]>();
  readonly #logger = Logger;

  /**
   * Register a hook handler.
   *
   * @param event - The event to listen for
   * @param handler - Handler function. For 'tool:execute:before', return false to block.
   * @param opts - Options: priority (lower = earlier, default 100), once (auto-remove after first call)
   * @returns Unsubscribe function
   */
  on<E extends HookEvent>(
    event: E,
    handler: HookHandler<E>,
    opts: { priority?: number; once?: boolean } = {}
  ): () => void {
    const id = `hook_${++_hookCounter}`;
    const entry: HookEntry<E> = {
      event,
      handler,
      priority: opts.priority ?? 100,
      once: opts.once ?? false,
      id,
    };

    if (!this.#hooks.has(event)) {
      this.#hooks.set(event, []);
    }
    const list = this.#hooks.get(event)!;
    list.push(entry as unknown as HookEntry);
    list.sort((a, b) => a.priority - b.priority);

    return () => {
      const idx = list.findIndex((e) => e.id === id);
      if (idx >= 0) {
        list.splice(idx, 1);
      }
    };
  }

  /** Register a one-shot hook. */
  once<E extends HookEvent>(event: E, handler: HookHandler<E>, priority?: number): () => void {
    return this.on(event, handler, { priority, once: true });
  }

  /**
   * Emit an event to all registered hooks.
   *
   * For 'tool:execute:before': if any handler returns false, the tool execution is blocked.
   * All other events are fire-and-forget.
   *
   * @returns For blocking events, returns false if any handler blocked. Otherwise true.
   */
  async emit<E extends HookEvent>(event: E, payload: HookPayloadMap[E]): Promise<boolean> {
    const list = this.#hooks.get(event);
    if (!list || list.length === 0) {
      return true;
    }

    const toRemove: string[] = [];
    let blocked = false;

    for (const entry of list) {
      try {
        const result = entry.handler(payload as never);
        const resolved = result instanceof Promise ? await result : result;

        if (event === 'tool:execute:before' && resolved === false) {
          blocked = true;
        }
      } catch (err) {
        this.#logger.warn(
          `[HookSystem] hook error on ${event} (${entry.id}): ${err instanceof Error ? err.message : String(err)}`
        );
      }

      if (entry.once) {
        toRemove.push(entry.id);
      }
    }

    // Clean up one-shot hooks
    if (toRemove.length > 0) {
      for (const id of toRemove) {
        const idx = list.findIndex((e) => e.id === id);
        if (idx >= 0) {
          list.splice(idx, 1);
        }
      }
    }

    return !blocked;
  }

  /**
   * Synchronous emit — for performance-critical hooks where async is unnecessary.
   * Does not support blocking (always returns true).
   */
  emitSync<E extends HookEvent>(event: E, payload: HookPayloadMap[E]): void {
    const list = this.#hooks.get(event);
    if (!list || list.length === 0) {
      return;
    }

    for (const entry of list) {
      try {
        entry.handler(payload as never);
      } catch (err) {
        this.#logger.warn(
          `[HookSystem] hook error on ${event} (${entry.id}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Clean up one-shot hooks
    const toRemove = list.filter((e) => e.once).map((e) => e.id);
    for (const id of toRemove) {
      const idx = list.findIndex((e) => e.id === id);
      if (idx >= 0) {
        list.splice(idx, 1);
      }
    }
  }

  /** Remove all hooks for a specific event or all events. */
  clear(event?: HookEvent): void {
    if (event) {
      this.#hooks.delete(event);
    } else {
      this.#hooks.clear();
    }
  }

  /** Get registered hook count for inspection. */
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
}

// ── Default hooks registration ──

/**
 * Register default hooks that bridge HookSystem events to existing subsystems.
 * Call this during AgentRuntime initialization.
 */
export function registerDefaultHooks(_hookSystem: HookSystem): void {
  // Placeholder: bridge hooks will be added incrementally as Pipeline middleware
  // is migrated to HookSystem. Current middleware (allowlistGate, observationRecord,
  // trackerSignal, traceRecord, submitDedup) remain in ToolExecutionPipeline.
}

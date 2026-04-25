/**
 * TemporaryToolRegistry — TTL 临时工具注册
 *
 * 在 ToolRegistry 之上增加 TTL 自动回收机制。
 * 锻造的工具默认 30 分钟有效，到期自动从 ToolRegistry 中移除。
 *
 * 设计：
 *   - 装饰器模式，不修改 ToolRegistry 核心逻辑
 *   - 定期检查（60s 间隔）清理过期工具
 *   - 支持手动续期和提前回收
 */

import Logger from '#infra/logging/Logger.js';

import type { SignalBus } from '#infra/signal/SignalBus.js';
import type { Disposable } from '../../shared/lifecycle.js';
import { timerRegistry } from '../../shared/TimerRegistry.js';

/* ────────────────────── Types ────────────────────── */

interface ToolRegistryLike {
  register(toolDef: {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
    handler: (...args: never[]) => unknown;
  }): void;
  unregister(name: string): boolean;
  has(name: string): boolean;
}

export interface TemporaryTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (params: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown>;
  /** 锻造模式 */
  forgeMode: 'reuse' | 'compose' | 'generate';
  /** 注册时间 (ms) */
  registeredAt: number;
  /** 过期时间 (ms)，0 = never */
  expiresAt: number;
}

export interface TemporaryToolInfo {
  name: string;
  forgeMode: string;
  registeredAt: number;
  expiresAt: number;
  remainingMs: number;
}

/* ────────────────────── Constants ────────────────────── */

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // 60 seconds

/* ────────────────────── Class ────────────────────── */

export class TemporaryToolRegistry implements Disposable {
  #registry: ToolRegistryLike;
  #tempTools = new Map<string, TemporaryTool>();
  #cleanupTimer: ReturnType<typeof setInterval> | null = null;
  #signalBus: SignalBus | null;
  #logger = Logger.getInstance();

  constructor(registry: ToolRegistryLike, options: { signalBus?: SignalBus } = {}) {
    this.#registry = registry;
    this.#signalBus = options.signalBus ?? null;
    this.#startCleanup();
  }

  /**
   * 注册一个临时工具
   */
  registerTemporary(
    tool: Omit<TemporaryTool, 'registeredAt' | 'expiresAt'>,
    ttlMs: number = DEFAULT_TTL_MS
  ): void {
    const now = Date.now();
    const entry: TemporaryTool = {
      ...tool,
      registeredAt: now,
      expiresAt: ttlMs > 0 ? now + ttlMs : 0,
    };

    // 如果已存在同名临时工具，先移除
    if (this.#tempTools.has(tool.name)) {
      this.revoke(tool.name);
    }

    if (this.#registry.has(tool.name)) {
      throw new Error(
        `Temporary tool "${tool.name}" conflicts with an existing static tool. Use a unique forge namespace.`
      );
    }

    // 注册到主 ToolRegistry
    this.#registry.register({
      name: tool.name,
      description: `[Forged:${tool.forgeMode}] ${tool.description}`,
      parameters: tool.parameters,
      handler: tool.handler,
    });

    this.#tempTools.set(tool.name, entry);

    if (this.#signalBus) {
      this.#signalBus.send('forge', 'TemporaryToolRegistry', 1, {
        target: tool.name,
        metadata: { action: 'registered', forgeMode: tool.forgeMode, ttlMs },
      });
    }

    this.#logger.debug(
      `TemporaryToolRegistry: registered "${tool.name}" (mode=${tool.forgeMode}, ttl=${ttlMs}ms)`
    );
  }

  /**
   * 手动回收临时工具
   */
  revoke(name: string): boolean {
    const tool = this.#tempTools.get(name);
    if (!tool) {
      return false;
    }

    this.#registry.unregister(name);
    this.#tempTools.delete(name);

    if (this.#signalBus) {
      this.#signalBus.send('forge', 'TemporaryToolRegistry', 0, {
        target: name,
        metadata: { action: 'revoked' },
      });
    }

    this.#logger.debug(`TemporaryToolRegistry: revoked "${name}"`);
    return true;
  }

  /**
   * 续期临时工具
   */
  renew(name: string, additionalMs: number = DEFAULT_TTL_MS): boolean {
    const tool = this.#tempTools.get(name);
    if (!tool) {
      return false;
    }

    tool.expiresAt = Date.now() + additionalMs;
    return true;
  }

  /**
   * 清理过期工具
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [name, tool] of this.#tempTools) {
      if (tool.expiresAt > 0 && tool.expiresAt <= now) {
        this.#registry.unregister(name);
        this.#tempTools.delete(name);
        cleaned++;

        this.#logger.debug(`TemporaryToolRegistry: expired "${name}"`);
      }
    }

    return cleaned;
  }

  /**
   * 获取所有临时工具信息
   */
  list(): TemporaryToolInfo[] {
    const now = Date.now();
    const result: TemporaryToolInfo[] = [];

    for (const [name, tool] of this.#tempTools) {
      result.push({
        name,
        forgeMode: tool.forgeMode,
        registeredAt: tool.registeredAt,
        expiresAt: tool.expiresAt,
        remainingMs: tool.expiresAt > 0 ? Math.max(0, tool.expiresAt - now) : -1,
      });
    }

    return result;
  }

  /**
   * 检查是否是临时工具
   */
  isTemporary(name: string): boolean {
    return this.#tempTools.has(name);
  }

  /** 临时工具数量 */
  get size(): number {
    return this.#tempTools.size;
  }

  /** 停止定期清理（用于 shutdown） */
  dispose(): void {
    if (this.#cleanupTimer) {
      timerRegistry.clear(this.#cleanupTimer);
      this.#cleanupTimer = null;
    }

    // 回收所有临时工具
    for (const name of [...this.#tempTools.keys()]) {
      this.revoke(name);
    }
  }

  /* ── Internal ── */

  #startCleanup(): void {
    this.#cleanupTimer = timerRegistry.setInterval(
      () => {
        this.cleanup();
      },
      CLEANUP_INTERVAL_MS,
      'TemporaryToolRegistry/cleanup'
    );
  }
}

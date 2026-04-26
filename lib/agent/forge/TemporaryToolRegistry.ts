/**
 * TemporaryToolRegistry — TTL 临时能力注册
 *
 * 为 Forge 产物增加 TTL 自动回收机制。
 * 生成工具会投影到内部工具 handler store；组合 workflow 只保留 TTL/allowlist 追踪。
 *
 * 设计：
 *   - 装饰器模式，不修改内部 handler store 核心逻辑
 *   - 定期检查（60s 间隔）清理过期工具
 *   - 支持手动续期和提前回收
 */

import Logger from '#infra/logging/Logger.js';

import type { SignalBus } from '#infra/signal/SignalBus.js';
import type { Disposable } from '../../shared/lifecycle.js';
import { timerRegistry } from '../../shared/TimerRegistry.js';
import type { ForgedInternalToolStore, InternalToolHandler } from '../core/InternalToolHandler.js';
import type { WorkflowHandler } from '../workflow/WorkflowRegistry.js';

/* ────────────────────── Types ────────────────────── */

interface TemporaryToolRegistryOptions {
  signalBus?: SignalBus;
  onRevokeTemporary?: (tool: TemporaryTool) => void;
}

interface TemporaryRegistrationOptions {
  projectIntoInternalToolStore?: boolean;
}

export interface TemporaryTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler:
    | WorkflowHandler
    | ((params: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown>);
  /** 锻造模式 */
  forgeMode: 'reuse' | 'compose' | 'generate';
  /** 注册时间 (ms) */
  registeredAt: number;
  /** 过期时间 (ms)，0 = never */
  expiresAt: number;
}

interface TemporaryToolEntry extends TemporaryTool {
  projectedIntoInternalToolStore: boolean;
}

export interface TemporaryToolInfo {
  name: string;
  forgeMode: string;
  registeredAt: number;
  expiresAt: number;
  remainingMs: number;
  projectedIntoInternalToolStore: boolean;
}

/* ────────────────────── Constants ────────────────────── */

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // 60 seconds

/* ────────────────────── Class ────────────────────── */

export class TemporaryToolRegistry implements Disposable {
  #forgedToolStore: ForgedInternalToolStore;
  #tempTools = new Map<string, TemporaryToolEntry>();
  #cleanupTimer: ReturnType<typeof setInterval> | null = null;
  #signalBus: SignalBus | null;
  #onRevokeTemporary: TemporaryToolRegistryOptions['onRevokeTemporary'];
  #logger = Logger.getInstance();

  constructor(
    forgedToolStore: ForgedInternalToolStore,
    options: TemporaryToolRegistryOptions = {}
  ) {
    this.#forgedToolStore = forgedToolStore;
    this.#signalBus = options.signalBus ?? null;
    this.#onRevokeTemporary = options.onRevokeTemporary;
    this.#startCleanup();
  }

  /**
   * 注册一个临时工具
   */
  registerTemporary(
    tool: Omit<TemporaryTool, 'registeredAt' | 'expiresAt'>,
    ttlMs: number = DEFAULT_TTL_MS,
    options: TemporaryRegistrationOptions = {}
  ): void {
    const now = Date.now();
    const projectIntoInternalToolStore = options.projectIntoInternalToolStore ?? true;
    const entry: TemporaryToolEntry = {
      ...tool,
      registeredAt: now,
      expiresAt: ttlMs > 0 ? now + ttlMs : 0,
      projectedIntoInternalToolStore: projectIntoInternalToolStore,
    };

    // 如果已存在同名临时工具，先移除
    if (this.#tempTools.has(tool.name)) {
      this.revoke(tool.name);
    }

    if (projectIntoInternalToolStore && tool.forgeMode !== 'generate') {
      throw new Error(
        `Temporary ${tool.forgeMode} tool "${tool.name}" cannot be projected as a forged internal tool.`
      );
    }

    if (projectIntoInternalToolStore && this.#forgedToolStore.hasInternalTool(tool.name)) {
      throw new Error(
        `Temporary tool "${tool.name}" conflicts with an existing static tool. Use a unique forge namespace.`
      );
    }

    if (projectIntoInternalToolStore) {
      this.#forgedToolStore.projectForgedTool({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        forgeMode: 'generate',
        handler: tool.handler as InternalToolHandler,
      });
    }

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

    if (tool.projectedIntoInternalToolStore) {
      this.#forgedToolStore.revokeForgedTool(name);
    }
    this.#tempTools.delete(name);
    this.#onRevokeTemporary?.(tool);

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
        if (tool.projectedIntoInternalToolStore) {
          this.#forgedToolStore.revokeForgedTool(name);
        }
        this.#tempTools.delete(name);
        this.#onRevokeTemporary?.(tool);
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
        projectedIntoInternalToolStore: tool.projectedIntoInternalToolStore,
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

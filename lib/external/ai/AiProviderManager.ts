/**
 * AiProviderManager — 统一 AI 提供商管理器（切面层）
 *
 * 设计目标:
 *   1. 唯一权威: 当前 AI Provider 的唯一管理入口，所有读取/切换集中在此
 *   2. AOP 切面: Token 追踪回调随 Provider 切换自动重新挂载，无需外部干预
 *   3. 热切换: switchProvider() 一次调用 → Token AOP + Embedding fallback + DI 级联清理 + 事件通知
 *   4. 模式查询: isMock / isReady 集中管理，消除散落的 name === 'mock' 判断
 *   5. 事件驱动: 注册监听器，切换时自动回调（Realtime 广播、SearchEngine 重建等）
 *
 * 集成方式:
 *   - 由 AiModule.initialize() 创建并注入 DI 容器
 *   - ServiceContainer.reloadAiProvider() 委托 manager.switchProvider()
 *   - 消费者通过 container.get('aiProviderManager') 获取
 *   - DI 数据管道: switchProvider() 通过回调同步 singletons 中的 provider 引用
 */

import Logger from '#infra/logging/Logger.js';

// ── 类型 ────────────────────────────────────────────────

/** AI Provider 最小接口（避免引入 AiProvider 具体类的循环依赖） */
export interface ManagedAiProvider {
  name: string;
  model: string;
  apiKey?: string;
  _onTokenUsage?: ((usage: TokenUsagePayload) => void) | null;
  supportsEmbedding?: () => boolean;
  _fallbackFrom?: string;
}

export interface TokenUsagePayload {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  source?: string;
}

/** Token 记录器最小接口（对应 TokenUsageStore.record） */
export interface TokenRecorder {
  record(r: {
    source: string;
    provider?: string;
    model?: string;
    inputTokens: number;
    outputTokens: number;
  }): void;
}

/** Provider 信息快照 */
export interface ProviderInfo {
  name: string;
  model: string;
  isMock: boolean;
  supportsEmbedding: boolean;
}

/** 切换结果 */
export interface SwitchResult {
  previous: ProviderInfo;
  current: ProviderInfo;
  clearedSingletons: string[];
}

/** 切换监听器 */
export type SwitchListener = (result: SwitchResult) => void;

/** Embedding Fallback 初始化器（注入，避免循环依赖） */
export type EmbedFallbackInitializer = (
  currentProvider: ManagedAiProvider
) => ManagedAiProvider | null;

// ── Manager ────────────────────────────────────────────

export class AiProviderManager {
  #provider: ManagedAiProvider;
  #embedProvider: ManagedAiProvider | null = null;
  #tokenRecorder: TokenRecorder | null = null;
  #listeners = new Set<SwitchListener>();
  #logger = Logger.getInstance();

  /** DI 容器注入: 清除 AI 依赖 singleton 的回调 */
  #clearDependents: (() => string[]) | null = null;

  /** DI 容器注入: Embedding fallback 初始化器 */
  #embedFallbackInit: EmbedFallbackInitializer | null = null;

  /** DI 数据管道: 切换时同步 singletons 中的 provider 引用（供 DI 工厂函数读取） */
  #syncToDi: ((provider: ManagedAiProvider, embed: ManagedAiProvider | null) => void) | null = null;

  constructor(initialProvider: ManagedAiProvider) {
    this.#provider = initialProvider;
    this.#wireTokenTracking();
  }

  // ═══════════════════════════════════════════════════════
  //  读取接口
  // ═══════════════════════════════════════════════════════

  /** 当前 AI Provider (只读) */
  get provider(): ManagedAiProvider {
    return this.#provider;
  }

  /** 当前 Embedding Provider (优先 fallback，回退到主 provider) */
  get embedProvider(): ManagedAiProvider {
    return this.#embedProvider ?? this.#provider;
  }

  /** 原始 Embedding fallback (可能为 null) */
  get rawEmbedProvider(): ManagedAiProvider | null {
    return this.#embedProvider;
  }

  /** 是否处于 Mock 模式 */
  get isMock(): boolean {
    return this.#provider.name === 'mock';
  }

  /** provider 是否可用于 AI 操作（非 mock） */
  get isReady(): boolean {
    return !!this.#provider && !this.isMock;
  }

  /** 当前 provider 名称 */
  get name(): string {
    return this.#provider.name;
  }

  /** 当前模型 */
  get model(): string {
    return this.#provider.model;
  }

  /** 结构化信息快照 */
  get info(): ProviderInfo {
    return {
      name: this.#provider.name,
      model: this.#provider.model,
      isMock: this.isMock,
      supportsEmbedding:
        typeof this.#provider.supportsEmbedding === 'function' &&
        this.#provider.supportsEmbedding(),
    };
  }

  // ═══════════════════════════════════════════════════════
  //  热切换 — 唯一的全局切换入口
  // ═══════════════════════════════════════════════════════

  /**
   * 切换 AI Provider — 原子操作
   *
   * 自动处理:
   *   1. Token 追踪 AOP 重新挂载
   *   2. Embedding fallback 重建
   *   3. DI 数据管道同步（singletons.aiProvider）
   *   4. DI 容器中的 AI 依赖 singleton 级联清除
   *   5. 监听器回调通知
   */
  switchProvider(newProvider: ManagedAiProvider): SwitchResult {
    const prev = this.info;

    // 1. 替换核心引用
    this.#provider = newProvider;

    // 2. AOP: 重新挂载 Token 追踪
    this.#wireTokenTracking();

    // 3. Embedding fallback 重建
    this.#embedProvider = null;
    if (this.#embedFallbackInit) {
      this.#embedProvider = this.#embedFallbackInit(newProvider);
    }

    // 4. DI 数据管道同步
    this.#syncToDi?.(this.#provider, this.#embedProvider);

    // 5. 清除 DI 容器中的依赖 singleton
    const clearedSingletons = this.#clearDependents?.() ?? [];

    const result: SwitchResult = {
      previous: prev,
      current: this.info,
      clearedSingletons,
    };

    // 6. 通知监听器
    for (const fn of this.#listeners) {
      try {
        fn(result);
      } catch {
        /* listener should not break switching */
      }
    }

    this.#logger.info('[AiProviderManager] Provider switched', {
      from: `${prev.name}/${prev.model}`,
      to: `${result.current.name}/${result.current.model}`,
      mock: result.current.isMock,
      cleared: clearedSingletons,
    });

    return result;
  }

  // ═══════════════════════════════════════════════════════
  //  Embedding 管理
  // ═══════════════════════════════════════════════════════

  /** 手动设置 Embedding fallback provider */
  setEmbedProvider(ep: ManagedAiProvider | null): void {
    this.#embedProvider = ep;
  }

  // ═══════════════════════════════════════════════════════
  //  AOP: Token 追踪
  // ═══════════════════════════════════════════════════════

  /** 注入 TokenRecorder (延迟绑定，避免循环依赖) */
  setTokenRecorder(recorder: TokenRecorder): void {
    this.#tokenRecorder = recorder;
    this.#wireTokenTracking();
  }

  /**
   * 在当前 provider 上安装 _onTokenUsage 回调
   * 每次 provider.chat() / chatWithTools() 等调用后自动触发
   */
  #wireTokenTracking(): void {
    const p = this.#provider;
    if (!p || typeof p !== 'object') {
      return;
    }

    p._onTokenUsage = (usage: TokenUsagePayload) => {
      if (!this.#tokenRecorder) {
        return;
      }
      try {
        this.#tokenRecorder.record({
          source: usage.source || 'provider',
          provider: p.name ?? undefined,
          model: p.model ?? undefined,
          inputTokens: usage.inputTokens || 0,
          outputTokens: usage.outputTokens || 0,
        });
      } catch {
        /* token tracking never breaks execution */
      }
    };
  }

  // ═══════════════════════════════════════════════════════
  //  事件
  // ═══════════════════════════════════════════════════════

  /** 注册切换监听器，返回取消注册函数 */
  onSwitch(fn: SwitchListener): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  // ═══════════════════════════════════════════════════════
  //  DI 绑定 (仅 ServiceContainer / AiModule 调用)
  // ═══════════════════════════════════════════════════════

  /** 注入 DI 容器的级联清理回调 */
  _bindDependentClearer(fn: () => string[]): void {
    this.#clearDependents = fn;
  }

  /** 注入 Embedding Fallback 初始化器 */
  _bindEmbedFallbackInit(fn: EmbedFallbackInitializer): void {
    this.#embedFallbackInit = fn;
  }

  /** 注入 DI 数据管道同步回调（切换时更新 singletons 中的 provider 引用） */
  _bindDiSync(fn: (provider: ManagedAiProvider, embed: ManagedAiProvider | null) => void): void {
    this.#syncToDi = fn;
  }
}

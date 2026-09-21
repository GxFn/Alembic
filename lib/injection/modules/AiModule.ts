/**
 * AiModule — AI Provider 服务注册
 *
 * 从 ServiceContainer.initialize() 中提取的 AI Provider 初始化逻辑,
 * 作为独立的 DI 模块管理 AI 相关服务的生命周期。
 *
 * 职责:
 *   - AI Provider 自动探测与创建
 *   - AiProviderManager 统一管理层
 *   - 独立固定 embedding 服务装配
 *   - AiFactory 实例注入
 *
 * @module AiModule
 */

import { AiProviderManager, type ManagedAiProvider } from '@alembic/agent/ai';
import { alignDeepSeekReasoningEffort } from '../../infrastructure/config/RuntimeConfigLoadReceipt.js';
import { getAiRuntimeStatus } from '../AiRuntimeStatus.js';
import { createEmbeddingProvider } from '../EmbeddingProvider.js';
import type { ServiceContainer } from '../ServiceContainer.js';

/**
 * 初始化 AI Provider（在模块注册前调用）
 *
 * 1. 装配独立 embedding 后动态导入 AiFactory
 * 2. 自动探测可用 AI Provider
 * 3. 创建 AiProviderManager（统一管理层）
 * 4. 绑定 LLM Token 追踪与生成型服务的 DI 失效
 */
export async function initialize(c: ServiceContainer) {
  const logger = c.logger;
  initializeEmbedding(c);

  // WorkspaceSettingsStore persists the provider-neutral key while DeepSeekProvider consumes
  // its provider-specific env contract. Reconcile once, before any provider is constructed;
  // an explicit provider-specific override always wins.
  alignDeepSeekReasoningEffort(process.env);

  // AiFactory 模块引用
  try {
    c.singletons._aiFactory = await import('@alembic/agent/ai');
  } catch {
    c.singletons._aiFactory = null;
  }

  // 自动探测 AI Provider
  if (!c.singletons.aiProvider && c.singletons._aiFactory) {
    try {
      const aiFactory = c.singletons._aiFactory as {
        autoDetectProvider?: () => Record<string, unknown>;
      };
      if (typeof aiFactory.autoDetectProvider === 'function') {
        c.singletons.aiProvider = aiFactory.autoDetectProvider();
        const provider = c.singletons.aiProvider as Record<string, unknown> | null;
        if (provider?.name === 'mock') {
          logger.warn(
            'AI provider auto-detect returned disabled mock provider; treating AI as unavailable'
          );
        } else {
          logger.info('AI provider injected into container', {
            provider: (provider?.constructor as { name?: string } | undefined)?.name || 'unknown',
          });
        }
      }
    } catch {
      c.singletons.aiProvider = null;
    }
  }

  // ── 创建 AiProviderManager（统一管理层）──
  // 无真实 provider 时保持 manager 缺席，调用方统一得到 AI unavailable，
  // 避免把未配置状态伪装成产品 mock provider。
  const manager = ensureManagerForProvider(c, c.singletons.aiProvider as ManagedAiProvider | null);
  if (!manager) {
    logger.warn('AI provider unavailable at startup; real provider configuration is required');
    return;
  }

  // Token 追踪 AOP（manager 自身已在构造时 wire，此处延迟注入 recorder）
  // recorder 注入放到 register() 之后（tokenUsageStore 需先注册）

  // embedding 已在 LLM 探测前独立装配；生成模型就绪不参与其选择。
}

/** 一个容器只装配一次固定 embedding；换 LLM 不读取后来的 embedding env。 */
export function initializeEmbedding(c: ServiceContainer): void {
  if (Object.hasOwn(c.singletons, '_embedProvider')) {
    return;
  }
  try {
    const config = c.singletons._config as Record<string, unknown> | undefined;
    c.singletons._embedProvider = createEmbeddingProvider(config);
    c.logger.info('[embedding] independent provider initialized', {
      configured: !!c.singletons._embedProvider,
    });
  } catch (err: unknown) {
    c.singletons._embedProvider = null;
    c.logger.warn('[embedding] configuration rejected; no generating-provider fallback', {
      reason: err instanceof Error ? err.message : 'invalid configuration',
    });
  }
}

/**
 * 注册 AI 相关的服务到容器
 *
 * - 标记 AI 模块就绪
 * - 注册 aiProviderManager 服务
 * - 延迟注入 TokenRecorder（tokenUsageStore 此时已可用）
 */
export function register(c: ServiceContainer) {
  c.singletons._aiModuleReady = true;

  // 注册 aiProviderManager（消费者通过 container.get('aiProviderManager') 获取）
  c.register('aiProviderManager', () => c.singletons._aiProviderManager);

  // 延迟注入 TokenRecorder 到 manager（tokenUsageStore 在 AppModule 中注册）
  const manager = c.singletons._aiProviderManager as AiProviderManager | null;
  if (!manager) {
    return;
  }
  attachTokenRecorder(c, manager);
}

export function ensureManagerForProvider(
  c: ServiceContainer,
  provider: ManagedAiProvider | null
): AiProviderManager | null {
  initializeEmbedding(c);
  if (!provider || provider.name === 'mock') {
    c.singletons._aiProviderManager = null;
    c.singletons.aiProvider = provider?.name === 'mock' ? null : provider;
    return null;
  }

  const existing = c.singletons._aiProviderManager as AiProviderManager | null | undefined;
  if (existing) {
    return existing;
  }

  const manager = new AiProviderManager(provider);
  c.singletons.aiProvider = provider;
  c.singletons._aiProviderManager = manager;

  // 绑定: DI 数据管道同步（切换时更新 singletons 中的 provider 引用，供工厂函数读取）
  manager._bindDiSync((nextProvider) => {
    c.singletons.aiProvider = nextProvider;
  });

  // 绑定: DI 级联清理回调
  manager._bindDependentClearer(() => clearAiDependentSingletons(c));

  // 无 LLM 启动后的首次启用也必须挂载 recorder；存储仍按调用时惰性解析。
  attachTokenRecorder(c, manager);

  return manager;
}

export function clearAiDependentSingletons(c: ServiceContainer): string[] {
  const cleared: string[] = [];
  for (const key of c._aiDependentSingletons || []) {
    if (c.singletons[key]) {
      c.singletons[key] = null;
      cleared.push(key);
    }
  }
  return cleared;
}

export function attachTokenRecorder(c: ServiceContainer, manager: AiProviderManager): void {
  const containerRef = c;
  manager.setTokenRecorder({
    record(r: {
      source: string;
      provider?: string;
      model?: string;
      inputTokens: number;
      outputTokens: number;
    }) {
      try {
        const store = containerRef.get('tokenUsageStore') as {
          record: (rec: typeof r) => void;
        };
        store.record(r);
      } catch {
        /* tokenUsageStore not available yet */
      }
    },
  });
}

export function isAiRuntimeReady(c: ServiceContainer): boolean {
  return getAiRuntimeStatus(c).ready;
}

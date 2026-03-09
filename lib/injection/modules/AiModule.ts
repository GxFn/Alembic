/**
 * AiModule — AI Provider 服务注册
 *
 * 从 ServiceContainer.initialize() 中提取的 AI Provider 初始化逻辑,
 * 作为独立的 DI 模块管理 AI 相关服务的生命周期。
 *
 * 职责:
 *   - AI Provider 自动探测与创建
 *   - Embedding fallback provider 管理
 *   - AiFactory 实例注入
 *
 * @module AiModule
 */

import type { ServiceContainer } from '../ServiceContainer.js';

/**
 * 初始化 AI Provider（在模块注册前调用）
 *
 * 1. 动态导入 AiFactory
 * 2. 自动探测可用 AI Provider
 * 3. 创建 Embedding fallback（若主 provider 不支持 embedding）
 */
export async function initialize(c: ServiceContainer) {
  const logger = c.logger;

  // AiFactory 模块引用
  try {
    c.singletons._aiFactory = await import('../../external/ai/AiFactory.js');
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
        logger.info('AI provider injected into container', {
          provider: (provider?.constructor as { name?: string } | undefined)?.name || 'unknown',
        });
      }
    } catch {
      c.singletons.aiProvider = null;
    }
  }

  // Embedding fallback provider
  initEmbeddingFallback(c);
}

/**
 * 创建/刷新 Embedding fallback provider
 *
 * 若主 provider 不支持 embedding（如 Claude），尝试从其他可用 provider 创建备用。
 */
export function initEmbeddingFallback(c: ServiceContainer) {
  const currentProvider = c.singletons.aiProvider as Record<string, unknown> | null;

  if (
    (currentProvider &&
      typeof (currentProvider as Record<string, (...args: unknown[]) => unknown>)
        .supportsEmbedding !== 'function') ||
    (currentProvider &&
      !(currentProvider as Record<string, (...args: unknown[]) => unknown>).supportsEmbedding?.())
  ) {
    try {
      const aiFactory = (c.singletons._aiFactory || {}) as {
        getAvailableFallbacks?: (name: string) => string[];
        createProvider?: (opts: Record<string, unknown>) => Record<string, unknown>;
      };
      const providerName = ((currentProvider?.name as string) || '').replace('-', '');
      const fbCandidates =
        typeof aiFactory.getAvailableFallbacks === 'function'
          ? aiFactory.getAvailableFallbacks(providerName)
          : [];
      for (const fb of fbCandidates) {
        try {
          const fbProvider = aiFactory.createProvider!({ provider: fb });
          if (
            typeof fbProvider.supportsEmbedding === 'function' &&
            (fbProvider.supportsEmbedding as () => boolean)()
          ) {
            c.singletons._embedProvider = fbProvider;
            c.logger.info('Embedding fallback provider created', { provider: fb });
            break;
          }
        } catch {
          /* skip */
        }
      }
    } catch {
      /* no embed fallback available */
    }
  }
}

/**
 * 注册 AI 相关的服务到容器
 *
 * 当前 AI Provider 和 AiFactory 通过 singletons 直接管理，
 * 此方法注册便于其他模块通过 container.get() 获取的快捷服务。
 */
export function register(c: ServiceContainer) {
  // aiProvider 和 _aiFactory 已通过 initialize() 写入 singletons
  // KnowledgeModule 中已注册 'aiProvider' 的 register 工厂
  // 此处仅标记 AI 模块已就绪
  c.singletons._aiModuleReady = true;
}

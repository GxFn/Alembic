/**
 * AiModule — AI Provider 服务注册
 *
 * 从 ServiceContainer.initialize() 中提取的 AI Provider 初始化逻辑,
 * 作为独立的 DI 模块管理 AI 相关服务的生命周期。
 *
 * 职责:
 *   - AI Provider 自动探测与创建
 *   - AiProviderManager 统一管理层
 *   - Embedding fallback provider 管理
 *   - AiFactory 实例注入
 *
 * @module AiModule
 */

import { AiProviderManager, type ManagedAiProvider } from '../../external/ai/AiProviderManager.js';
import type { ServiceContainer } from '../ServiceContainer.js';

/**
 * 初始化 AI Provider（在模块注册前调用）
 *
 * 1. 动态导入 AiFactory
 * 2. 自动探测可用 AI Provider
 * 3. 创建 AiProviderManager（统一管理层）
 * 4. 绑定 Token 追踪、Embedding fallback、DI 级联清理
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

  // ── 创建 AiProviderManager（统一管理层）──
  const manager = new AiProviderManager(
    (c.singletons.aiProvider as ManagedAiProvider) || { name: 'mock', model: 'mock-fallback' }
  );
  c.singletons._aiProviderManager = manager;

  // 绑定: DI 数据管道同步（切换时更新 singletons 中的 provider 引用，供工厂函数读取）
  manager._bindDiSync((provider, embed) => {
    c.singletons.aiProvider = provider;
    c.singletons._embedProvider = embed;
  });

  // 绑定: DI 级联清理回调
  manager._bindDependentClearer(() => {
    const cleared: string[] = [];
    for (const key of c._aiDependentSingletons || []) {
      if (c.singletons[key]) {
        c.singletons[key] = null;
        cleared.push(key);
      }
    }
    return cleared;
  });

  // 绑定: Embedding fallback 初始化器
  manager._bindEmbedFallbackInit((currentProvider) => {
    return createEmbedFallback(c, currentProvider);
  });

  // Token 追踪 AOP（manager 自身已在构造时 wire，此处延迟注入 recorder）
  // recorder 注入放到 register() 之后（tokenUsageStore 需先注册）

  // Embedding fallback: manager 的 embedFallbackInit 回调已绑定，初始化时主动触发一次
  const initialEmbed = createEmbedFallback(c, c.singletons.aiProvider as ManagedAiProvider | null);
  if (initialEmbed) {
    manager.setEmbedProvider(initialEmbed);
    c.singletons._embedProvider = initialEmbed;
  }
}

/**
 * 纯函数: 尝试为给定 provider 创建 Embedding fallback
 * 被 initEmbeddingFallback() 和 AiProviderManager 的 embedFallbackInit 回调共用
 */
function createEmbedFallback(
  c: ServiceContainer,
  currentProvider: ManagedAiProvider | null
): ManagedAiProvider | null {
  if (
    !currentProvider ||
    (typeof currentProvider.supportsEmbedding === 'function' && currentProvider.supportsEmbedding())
  ) {
    return null; // 主 provider 已支持 embedding，无需 fallback
  }
  try {
    const aiFactory = (c.singletons._aiFactory || {}) as {
      getAvailableFallbacks?: (name: string) => string[];
      createProvider?: (opts: Record<string, unknown>) => ManagedAiProvider;
    };
    const providerName = (currentProvider.name || '').replace('-', '');
    const fbCandidates =
      typeof aiFactory.getAvailableFallbacks === 'function'
        ? aiFactory.getAvailableFallbacks(providerName)
        : [];
    for (const fb of fbCandidates) {
      try {
        const fbProvider = aiFactory.createProvider?.({ provider: fb });
        if (
          fbProvider &&
          typeof fbProvider.supportsEmbedding === 'function' &&
          fbProvider.supportsEmbedding()
        ) {
          c.logger.info('Embedding fallback provider created', { provider: fb });
          return fbProvider;
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no embed fallback available */
  }
  return null;
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
  const manager = c.singletons._aiProviderManager as AiProviderManager;
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

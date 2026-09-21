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
 *
 * @module AiModule
 */

import { AiProviderManager, autoDetectProvider, type ManagedAiProvider } from '@alembic/agent/ai';
import { alignDeepSeekReasoningEffort } from '../../infrastructure/config/RuntimeConfigLoadReceipt.js';
import { createEmbeddingProvider } from '../EmbeddingProvider.js';
import type { ServiceContainer } from '../ServiceContainer.js';

/**
 * 初始化 AI Provider（在模块注册前调用）
 *
 * 1. 装配独立 embedding
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

  // 与 Manager 使用同一个公开 Agent 入口；不再缓存整份模块或伪装为可选 duck-type factory。
  if (!c.singletons.aiProvider) {
    try {
      const provider = autoDetectProvider();
      c.singletons.aiProvider = provider;
      logger.info('AI provider detection completed', {
        provider: provider?.name ?? null,
        configured: !!provider && provider.name !== 'mock',
      });
    } catch (err: unknown) {
      c.singletons.aiProvider = null;
      logger.warn('AI provider detection failed; runtime remains unavailable', {
        errorKind: err instanceof Error ? err.name : 'unknown',
      });
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
}

/** 一个容器只装配一次固定 embedding；换 LLM 不读取后来的 embedding env。 */
function initializeEmbedding(c: ServiceContainer): void {
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
 * - 注册 aiProviderManager 服务
 * - recorder 由 Manager 创建时绑定一次，调用时再解析存储。
 */
export function register(c: ServiceContainer) {
  c.register('aiProviderManager', () => c.singletons._aiProviderManager ?? null);
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
  manager.setTokenRecorder({
    // Manager 隔离并诊断计量错误；此处不再吞掉真实存储故障，也无需重复安装 hook。
    record: (usage) => c.get('tokenUsageStore').record(usage),
  });

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

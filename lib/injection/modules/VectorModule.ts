/**
 * VectorModule — 向量服务 DI 注册
 *
 * 注册:
 *   - vectorService: 统一向量服务层
 *   - contextualEnricher: 上下文增强器（可选，AI dependent）
 *
 * 依赖 KnowledgeModule 先注册: vectorStore, indexingPipeline, hybridRetriever
 * 依赖 InfraModule 先注册: eventBus, database
 */

import { ContextualEnricher } from '../../service/vector/ContextualEnricher.js';
import { VectorService } from '../../service/vector/VectorService.js';
import type { ServiceContainer } from '../ServiceContainer.js';

export function register(c: ServiceContainer) {
  // ═══ ContextualEnricher (可选, AI dependent) ═══
  c.singleton(
    'contextualEnricher',
    (ct: ServiceContainer) => {
      const aiProvider = ct.singletons.aiProvider || null;
      if (!aiProvider) {
        return null;
      }
      return new ContextualEnricher({
        aiProvider: aiProvider as ConstructorParameters<typeof ContextualEnricher>[0]['aiProvider'],
      });
    },
    { aiDependent: true }
  );

  // ═══ VectorService ═══
  c.singleton(
    'vectorService',
    (ct: ServiceContainer) => {
      const aiProvider = ct.singletons.aiProvider || null;
      const embedProvider = ct.singletons._embedProvider || aiProvider;
      const config =
        ((ct.singletons._config as Record<string, unknown> | undefined)?.vector as
          | Record<string, unknown>
          | undefined) || {};

      return new VectorService({
        vectorStore: ct.get('vectorStore'),
        indexingPipeline: ct.get('indexingPipeline'),
        hybridRetriever: ct.services.hybridRetriever
          ? (ct.get('hybridRetriever') as ConstructorParameters<
              typeof VectorService
            >[0]['hybridRetriever'])
          : null,
        eventBus: ct.services.eventBus ? ct.get('eventBus') : null,
        embedProvider: embedProvider as ConstructorParameters<
          typeof VectorService
        >[0]['embedProvider'],
        contextualEnricher: ct.services.contextualEnricher
          ? (ct.get('contextualEnricher') as InstanceType<typeof ContextualEnricher> | null)
          : null,
        autoSyncOnCrud: (config.autoSyncOnCrud as boolean) !== false,
        syncDebounceMs: (config.syncDebounceMs as number) || 2000,
        drizzle: ct.services.database
          ? ((ct.get('database') as unknown as { getDrizzle?(): unknown }).getDrizzle?.() as
              | import('../../infrastructure/database/drizzle/index.js').DrizzleDB
              | undefined)
          : undefined,
      });
    },
    { aiDependent: true }
  );
}

/**
 * 初始化 VectorService（在容器初始化后调用）
 * 用于绑定 EventBus 监听等异步初始化操作，同时将 ContextualEnricher 注入 IndexingPipeline
 */
export async function initializeVectorService(c: ServiceContainer): Promise<void> {
  // 将 ContextualEnricher 注入 IndexingPipeline（如果可用）
  if (c.services.contextualEnricher && c.services.indexingPipeline) {
    const config =
      ((c.singletons._config as Record<string, unknown> | undefined)?.vector as
        | Record<string, unknown>
        | undefined) || {};
    if (config.contextualEnrich) {
      const enricher = c.get('contextualEnricher') as InstanceType<
        typeof ContextualEnricher
      > | null;
      if (enricher) {
        const pipeline = c.get('indexingPipeline') as {
          setContextualEnricher?: (e: unknown) => void;
        };
        pipeline.setContextualEnricher?.(enricher);
      }
    }
  }

  if (c.services.vectorService) {
    try {
      const vectorService = c.get('vectorService') as InstanceType<typeof VectorService>;
      await vectorService.initialize();
    } catch (err: unknown) {
      const logger = c.singletons.logger || console;
      (logger as { warn?: (...args: unknown[]) => void }).warn?.(
        '[VectorModule] VectorService initialization failed (non-blocking)',
        { error: (err as Error).message }
      );
    }
  }
}

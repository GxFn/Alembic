/**
 * KnowledgeModule — 知识 + 搜索 + 向量服务注册
 *
 * 负责注册:
 *   - knowledgeService, knowledgeGraphService, codeEntityGraph, confidenceRouter
 *   - searchEngine, vectorStore, indexingPipeline
 *   - discovererRegistry, enhancementRegistry, languageService, dimensionCopy
 *   - constitution, aiProvider, projectGraph
 */

import { resolveProjectRoot } from '#shared/resolveProjectRoot.js';
import { getDiscovererRegistry } from '../../core/discovery/index.js';
import { getEnhancementRegistry } from '../../core/enhancement/index.js';
import { HnswVectorAdapter } from '../../infrastructure/vector/HnswVectorAdapter.js';
import { IndexingPipeline } from '../../infrastructure/vector/IndexingPipeline.js';
import { JsonVectorAdapter } from '../../infrastructure/vector/JsonVectorAdapter.js';
import { DimensionCopy } from '../../service/bootstrap/DimensionCopyRegistry.js';
import { CodeEntityGraph } from '../../service/knowledge/CodeEntityGraph.js';
import { ConfidenceRouter } from '../../service/knowledge/ConfidenceRouter.js';
import { KnowledgeGraphService } from '../../service/knowledge/KnowledgeGraphService.js';
import { KnowledgeService } from '../../service/knowledge/KnowledgeService.js';
import { HybridRetriever } from '../../service/search/HybridRetriever.js';
import { SearchEngine } from '../../service/search/SearchEngine.js';
import { LanguageService } from '../../shared/LanguageService.js';
import type { ServiceContainer } from '../ServiceContainer.js';

export function register(c: ServiceContainer) {
  // ═══ Knowledge ═══

  c.singleton(
    'confidenceRouter',
    (ct: ServiceContainer) =>
      new ConfidenceRouter(
        {},
        ct.get('qualityScorer') as ConstructorParameters<typeof ConfidenceRouter>[1]
      )
  );

  c.singleton(
    'knowledgeService',
    (ct: ServiceContainer) =>
      new KnowledgeService(
        ct.get('knowledgeRepository') as ConstructorParameters<typeof KnowledgeService>[0],
        ct.get('auditLogger') as ConstructorParameters<typeof KnowledgeService>[1],
        ct.get('gateway') as ConstructorParameters<typeof KnowledgeService>[2],
        ct.get('knowledgeGraphService') as ConstructorParameters<typeof KnowledgeService>[3],
        {
          fileWriter: ct.get('knowledgeFileWriter'),
          skillHooks: ct.get('skillHooks'),
          confidenceRouter: ct.get('confidenceRouter'),
          qualityScorer: ct.get('qualityScorer'),
          eventBus: ct.services.eventBus ? ct.get('eventBus') : null,
        } as ConstructorParameters<typeof KnowledgeService>[4]
      )
  );

  c.singleton(
    'knowledgeGraphService',
    (ct: ServiceContainer) =>
      new KnowledgeGraphService(
        ct.get('database') as unknown as ConstructorParameters<typeof KnowledgeGraphService>[0]
      )
  );

  c.singleton('codeEntityGraph', (ct: ServiceContainer) => {
    const projectRoot = resolveProjectRoot(ct);
    return new CodeEntityGraph(
      ct.get('database') as unknown as ConstructorParameters<typeof CodeEntityGraph>[0],
      { projectRoot }
    );
  });

  // ═══ Search + Vector ═══

  c.singleton(
    'searchEngine',
    (ct: ServiceContainer) => {
      const aiProvider = ct.singletons.aiProvider || null;
      const embedProvider = ct.singletons._embedProvider || aiProvider;
      const vectorService = ct.services.vectorService ? ct.get('vectorService') : null;
      return new SearchEngine(
        ct.get('database') as unknown as ConstructorParameters<typeof SearchEngine>[0],
        {
          aiProvider: embedProvider,
          vectorStore: ct.get('vectorStore'),
          vectorService,
          hybridRetriever: ct.get('hybridRetriever'),
          // CrossEncoderReranker disabled — BM25+vector dual-recall + CoarseRanker + MultiSignalRanker
          // is sufficient for knowledge-base scale (hundreds~thousands of entries).
          // Re-enable when document scale grows to 10k+ or external noisy sources are integrated.
          crossEncoderReranker: null,
        } as unknown as ConstructorParameters<typeof SearchEngine>[1]
      );
    },
    { aiDependent: true }
  );

  c.singleton('vectorStore', (ct: ServiceContainer) => {
    const projectRoot = resolveProjectRoot(ct);
    const config =
      ((ct.singletons._config as Record<string, unknown> | undefined)?.vector as
        | Record<string, unknown>
        | undefined) || {};
    const adapter = (config.adapter as string) || 'auto';

    // 根据配置选择适配器
    if (adapter === 'json') {
      const store = new JsonVectorAdapter(projectRoot as string);
      store.initSync();
      return store;
    }

    if (adapter === 'hnsw' || adapter === 'auto') {
      try {
        const hnsw = (config.hnsw as Record<string, unknown> | undefined) || {};
        const persistence = (config.persistence as Record<string, unknown> | undefined) || {};
        const store = new HnswVectorAdapter(projectRoot as string, {
          M: hnsw.M as number | undefined,
          efConstruct: hnsw.efConstruct as number | undefined,
          efSearch: hnsw.efSearch as number | undefined,
          quantize: config.quantize as string | undefined,
          quantizeThreshold: config.quantizeThreshold as number | undefined,
          flushIntervalMs: persistence.flushIntervalMs as number | undefined,
          flushBatchSize: persistence.flushBatchSize as number | undefined,
        });
        store.initSync();
        return store;
      } catch (err: unknown) {
        // HNSW 初始化失败, 降级到 JSON — 记录警告便于排查
        const logger = ct.singletons.logger || console;
        (logger as { warn?: (...args: unknown[]) => void }).warn?.(
          '[vectorStore] HNSW init failed, falling back to JsonVectorAdapter',
          {
            error: (err as Error).message,
            adapter,
          }
        );
        const store = new JsonVectorAdapter(projectRoot as string);
        store.initSync();
        return store;
      }
    }

    // 未知适配器, 默认 JSON
    const store = new JsonVectorAdapter(projectRoot as string);
    store.initSync();
    return store;
  });

  c.singleton(
    'indexingPipeline',
    (ct: ServiceContainer) => {
      const aiProvider = ct.singletons.aiProvider || null;
      const embedProvider = ct.singletons._embedProvider || aiProvider;
      return new IndexingPipeline({
        vectorStore: ct.get('vectorStore'),
        aiProvider: embedProvider,
      } as ConstructorParameters<typeof IndexingPipeline>[0]);
    },
    { aiDependent: true }
  );

  c.singleton('hybridRetriever', (ct: ServiceContainer) => {
    const config = (ct.singletons._config as Record<string, unknown> | undefined)?.vector as
      | Record<string, unknown>
      | undefined;
    const hybrid = (config?.hybrid as Record<string, unknown> | undefined) || {};
    return new HybridRetriever({
      vectorStore: ct.get('vectorStore'),
      rrfK: (hybrid.rrfK as number) || 60,
      alpha: (hybrid.alpha as number) || 0.5,
    } as ConstructorParameters<typeof HybridRetriever>[0]);
  });

  // ═══ Discovery + Shared ═══

  c.register('discovererRegistry', () => getDiscovererRegistry());
  c.register('enhancementRegistry', () => getEnhancementRegistry());
  c.register('languageService', () => LanguageService);
  c.register('dimensionCopy', () => DimensionCopy);
  c.register('constitution', () => c.singletons.constitution || null);
  c.register('aiProvider', () => c.singletons.aiProvider || null);
  c.register('projectGraph', () => c.singletons.projectGraph || null);
}

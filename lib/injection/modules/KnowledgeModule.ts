/**
 * KnowledgeModule — 知识 + 搜索 + 向量服务注册
 *
 * 负责注册:
 *   - knowledgeService, knowledgeGraphService, codeEntityGraph, confidenceRouter
 *   - searchEngine, vectorStore, indexingPipeline
 *   - discovererRegistry, enhancementRegistry, languageService, dimensionCopy
 *   - constitution, aiProvider, projectGraph
 */

import { DimensionCopy } from '#domain/dimension/DimensionCopy.js';
import { resolveDataRoot, resolveProjectRoot } from '#shared/resolveProjectRoot.js';
import { getDiscovererRegistry } from '../../core/discovery/index.js';
import { getEnhancementRegistry } from '../../core/enhancement/index.js';
import type { ReportStore } from '../../infrastructure/report/ReportStore.js';
import { HnswVectorAdapter } from '../../infrastructure/vector/HnswVectorAdapter.js';
import { IndexingPipeline } from '../../infrastructure/vector/IndexingPipeline.js';
import { JsonVectorAdapter } from '../../infrastructure/vector/JsonVectorAdapter.js';
import { LifecycleEventRepository } from '../../repository/evolution/LifecycleEventRepository.js';
import type { ProposalRepository } from '../../repository/evolution/ProposalRepository.js';
import { WarningRepository } from '../../repository/evolution/WarningRepository.js';
import type { KnowledgeEdgeRepositoryImpl } from '../../repository/knowledge/KnowledgeEdgeRepository.js';
import type KnowledgeRepositoryImpl from '../../repository/knowledge/KnowledgeRepository.impl.js';
import type { RecipeSourceRefRepositoryImpl } from '../../repository/sourceref/RecipeSourceRefRepository.js';
import { ConsolidationAdvisor } from '../../service/evolution/ConsolidationAdvisor.js';
import { ContentPatcher } from '../../service/evolution/ContentPatcher.js';
import { DecayDetector } from '../../service/evolution/DecayDetector.js';
import { EnhancementSuggester } from '../../service/evolution/EnhancementSuggester.js';
import { EvolutionGateway } from '../../service/evolution/EvolutionGateway.js';
import { FileChangeHandler } from '../../service/evolution/FileChangeHandler.js';
import { LifecycleStateMachine } from '../../service/evolution/LifecycleStateMachine.js';
import { ProposalExecutor } from '../../service/evolution/ProposalExecutor.js';
import { RedundancyAnalyzer } from '../../service/evolution/RedundancyAnalyzer.js';
import { StagingManager } from '../../service/evolution/StagingManager.js';
import { FileChangeDispatcher } from '../../service/FileChangeDispatcher.js';
import { CodeEntityGraph } from '../../service/knowledge/CodeEntityGraph.js';
import { ConfidenceRouter } from '../../service/knowledge/ConfidenceRouter.js';
import { KnowledgeGraphService } from '../../service/knowledge/KnowledgeGraphService.js';
import { KnowledgeService } from '../../service/knowledge/KnowledgeService.js';
import { SourceRefReconciler } from '../../service/knowledge/SourceRefReconciler.js';
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
          edgeRepo: ct.get('knowledgeEdgeRepository'),
          proposalRepo: ct.get('proposalRepository'),
        } as ConstructorParameters<typeof KnowledgeService>[4]
      )
  );

  c.singleton(
    'knowledgeGraphService',
    (ct: ServiceContainer) =>
      new KnowledgeGraphService(
        ct.get('knowledgeEdgeRepository') as ConstructorParameters<typeof KnowledgeGraphService>[0]
      )
  );

  c.singleton('codeEntityGraph', (ct: ServiceContainer) => {
    const projectRoot = resolveProjectRoot(ct);
    return new CodeEntityGraph(
      ct.get('codeEntityRepository') as ConstructorParameters<typeof CodeEntityGraph>[0],
      ct.get('knowledgeEdgeRepository') as ConstructorParameters<typeof CodeEntityGraph>[1],
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
          crossEncoderReranker: null,
          signalBus: ct.singletons.signalBus || null,
          knowledgeRepo: ct.get('knowledgeRepository'),
          sourceRefRepo: ct.get('recipeSourceRefRepository'),
        } as unknown as ConstructorParameters<typeof SearchEngine>[1]
      );
    },
    { aiDependent: true }
  );

  c.singleton('vectorStore', (ct: ServiceContainer) => {
    const dataRoot = resolveDataRoot(ct);
    const wz = ct.singletons.writeZone as
      | import('../../infrastructure/io/WriteZone.js').WriteZone
      | undefined;
    const config =
      ((ct.singletons._config as Record<string, unknown> | undefined)?.vector as
        | Record<string, unknown>
        | undefined) || {};
    const adapter = (config.adapter as string) || 'auto';

    // 根据配置选择适配器
    if (adapter === 'json') {
      const store = new JsonVectorAdapter(dataRoot as string, { writeZone: wz });
      store.initSync();
      return store;
    }

    if (adapter === 'hnsw' || adapter === 'auto') {
      try {
        const hnsw = (config.hnsw as Record<string, unknown> | undefined) || {};
        const persistence = (config.persistence as Record<string, unknown> | undefined) || {};
        const store = new HnswVectorAdapter(dataRoot as string, {
          M: hnsw.M as number | undefined,
          efConstruct: hnsw.efConstruct as number | undefined,
          efSearch: hnsw.efSearch as number | undefined,
          quantize: config.quantize as string | undefined,
          quantizeThreshold: config.quantizeThreshold as number | undefined,
          flushIntervalMs: persistence.flushIntervalMs as number | undefined,
          flushBatchSize: persistence.flushBatchSize as number | undefined,
          writeZone: wz,
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
        const store = new JsonVectorAdapter(dataRoot as string, { writeZone: wz });
        store.initSync();
        return store;
      }
    }

    // 未知适配器, 默认 JSON
    const store = new JsonVectorAdapter(dataRoot as string, { writeZone: wz });
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

  // ═══ Governance / Evolution ═══

  c.singleton('sourceRefReconciler', (ct: ServiceContainer) => {
    const projectRoot = resolveProjectRoot();
    const sourceRefRepo = ct.get('recipeSourceRefRepository') as RecipeSourceRefRepositoryImpl;
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepositoryImpl;
    return new SourceRefReconciler(projectRoot, sourceRefRepo, knowledgeRepo, {
      signalBus:
        (ct.singletons.signalBus as
          | import('../../infrastructure/signal/SignalBus.js').SignalBus
          | undefined) || undefined,
    });
  });

  c.singleton('stagingManager', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepositoryImpl;
    return new StagingManager(knowledgeRepo, {
      signalBus:
        (ct.singletons.signalBus as
          | import('../../infrastructure/signal/SignalBus.js').SignalBus
          | undefined) || undefined,
    });
  });

  c.singleton('decayDetector', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepositoryImpl;
    return new DecayDetector(knowledgeRepo, {
      signalBus:
        (ct.singletons.signalBus as
          | import('../../infrastructure/signal/SignalBus.js').SignalBus
          | undefined) || undefined,
      knowledgeEdgeRepo: ct.services.knowledgeEdgeRepository
        ? (ct.get('knowledgeEdgeRepository') as KnowledgeEdgeRepositoryImpl)
        : undefined,
      sourceRefRepo: ct.services.recipeSourceRefRepository
        ? (ct.get('recipeSourceRefRepository') as RecipeSourceRefRepositoryImpl)
        : undefined,
      drizzle: (
        ct.get('database') as unknown as {
          getDrizzle(): import('../../infrastructure/database/drizzle/index.js').DrizzleDB;
        }
      ).getDrizzle(),
    });
  });

  c.singleton('redundancyAnalyzer', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepositoryImpl;
    return new RedundancyAnalyzer(knowledgeRepo, {
      signalBus:
        (ct.singletons.signalBus as
          | import('../../infrastructure/signal/SignalBus.js').SignalBus
          | undefined) || undefined,
    });
  });

  c.singleton('enhancementSuggester', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepositoryImpl;
    return new EnhancementSuggester(knowledgeRepo, {
      signalBus:
        (ct.singletons.signalBus as
          | import('../../infrastructure/signal/SignalBus.js').SignalBus
          | undefined) || undefined,
    });
  });

  c.singleton('warningRepository', (ct: ServiceContainer) => {
    const db = ct.get('database') as unknown as { getDrizzle(): unknown };
    const drizzle = db.getDrizzle();
    return new WarningRepository(drizzle as ConstructorParameters<typeof WarningRepository>[0]);
  });

  c.singleton('contentPatcher', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepositoryImpl;
    const sourceRefRepo = ct.get('recipeSourceRefRepository') as RecipeSourceRefRepositoryImpl;
    return new ContentPatcher(knowledgeRepo, sourceRefRepo);
  });

  c.singleton('lifecycleEventRepository', (ct: ServiceContainer) => {
    const db = ct.get('database') as unknown as { getDrizzle(): unknown };
    const drizzle = db.getDrizzle();
    return new LifecycleEventRepository(
      drizzle as ConstructorParameters<typeof LifecycleEventRepository>[0]
    );
  });

  c.singleton('lifecycleStateMachine', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepositoryImpl;
    const lifecycleEventRepo = ct.get('lifecycleEventRepository') as LifecycleEventRepository;
    const signalBus = ct.get(
      'signalBus'
    ) as import('../../infrastructure/signal/SignalBus.js').SignalBus;
    const proposalRepo = ct.get('proposalRepository') as ProposalRepository;
    return new LifecycleStateMachine(knowledgeRepo, lifecycleEventRepo, signalBus, proposalRepo);
  });

  c.singleton('proposalExecutor', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepositoryImpl;
    const proposalRepo = ct.get('proposalRepository') as ProposalRepository;
    const lifecycle = ct.get('lifecycleStateMachine') as LifecycleStateMachine;
    const contentPatcher = ct.get('contentPatcher') as ContentPatcher;
    const edgeRepo = ct.get('knowledgeEdgeRepository') as KnowledgeEdgeRepositoryImpl;
    return new ProposalExecutor(knowledgeRepo, proposalRepo, lifecycle, contentPatcher, edgeRepo);
  });

  c.singleton('consolidationAdvisor', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepositoryImpl;
    return new ConsolidationAdvisor(knowledgeRepo);
  });

  c.singleton('evolutionGateway', (ct: ServiceContainer) => {
    const proposalRepo = ct.get('proposalRepository') as ProposalRepository;
    const lifecycle = ct.get('lifecycleStateMachine') as LifecycleStateMachine;
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepositoryImpl;
    return new EvolutionGateway(proposalRepo, lifecycle, knowledgeRepo);
  });

  c.singleton('fileChangeHandler', (ct: ServiceContainer) => {
    const sourceRefRepo = ct.get('recipeSourceRefRepository') as RecipeSourceRefRepositoryImpl;
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepositoryImpl;
    const contentPatcher = ct.get('contentPatcher') as ContentPatcher;
    const gateway = ct.get('evolutionGateway') as EvolutionGateway;
    return new FileChangeHandler(sourceRefRepo, knowledgeRepo, contentPatcher, {
      signalBus:
        (ct.singletons.signalBus as
          | import('../../infrastructure/signal/SignalBus.js').SignalBus
          | undefined) || undefined,
      evolutionGateway: gateway,
    });
  });

  c.singleton('fileChangeDispatcher', (ct: ServiceContainer) => {
    const dispatcher = new FileChangeDispatcher();
    const handler = ct.get('fileChangeHandler') as FileChangeHandler;
    dispatcher.register(handler);
    return dispatcher;
  });
}

/**
 * 初始化知识服务（在容器初始化后调用）
 * 绑定 EventBus → SearchEngine.refreshIndex() + recipe_source_refs 填充
 */
export function initializeKnowledgeServices(c: ServiceContainer): void {
  if (!c.services.eventBus || !c.services.searchEngine) {
    return;
  }

  try {
    const { EventBus } = await_import_EventBus();
    const eventBus = c.get('eventBus') as InstanceType<typeof EventBus>;
    const searchEngine = c.get('searchEngine') as {
      refreshIndex: (opts?: { force?: boolean }) => void;
    };

    // Bug 修复: BM25 索引与 Vector 索引一致性 — 将 knowledge:changed 事件绑定到 refreshIndex
    eventBus.on('knowledge:changed', () => {
      try {
        searchEngine.refreshIndex();
      } catch {
        /* refreshIndex failure is non-fatal */
      }
    });

    // recipe_source_refs 填充：MCP 内提交新知识后同步更新桥接表
    eventBus.on('knowledge:changed', (data: unknown) => {
      try {
        const d = data as { action?: string; entryId?: string };
        if (d.action === 'create' && d.entryId) {
          void _populateSourceRefsForEntry(c, d.entryId);
        }
      } catch {
        /* sourceRef population failure is non-fatal */
      }
    });
  } catch {
    /* EventBus/SearchEngine not available — skip binding */
  }
}

/** EventBus 延迟引用（避免循环依赖） */
function await_import_EventBus() {
  // EventBus 类型已经通过 container 解析，此处只用于 TS 类型
  return {
    EventBus: Object as unknown as typeof import('../../infrastructure/event/EventBus.js').EventBus,
  };
}

/**
 * 从 knowledge_entries.reasoning 中提取 sources 并填充 recipe_source_refs 桥接表
 * 使用 KnowledgeRepository + RecipeSourceRefRepository 类型安全 API
 */
async function _populateSourceRefsForEntry(c: ServiceContainer, entryId: string): Promise<void> {
  try {
    const knowledgeRepo = c.get('knowledgeRepository') as KnowledgeRepositoryImpl;
    const sourceRefRepo = c.get('recipeSourceRefRepository') as RecipeSourceRefRepositoryImpl;

    const row = await knowledgeRepo.findSourceFileAndReasoning(entryId);
    if (!row?.reasoning) {
      return;
    }

    let sources: string[] = [];
    try {
      const reasoning = JSON.parse(row.reasoning);
      sources = Array.isArray(reasoning.sources)
        ? reasoning.sources.filter(
            (s: unknown) => typeof s === 'string' && (s as string).length > 0
          )
        : [];
    } catch {
      return;
    }

    if (sources.length === 0) {
      return;
    }

    const now = Date.now();
    for (const sourcePath of sources) {
      try {
        sourceRefRepo.upsert({
          recipeId: entryId,
          sourcePath,
          status: 'active',
          verifiedAt: now,
        });
      } catch {
        /* table may not exist yet */
      }
    }
  } catch {
    /* repos may not be registered yet */
  }
}

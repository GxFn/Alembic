/**
 * KnowledgeModule — 知识 + 搜索 + 向量服务注册
 *
 * 负责注册:
 *   - knowledgeService, knowledgeGraphService, confidenceRouter
 *   - searchEngine, vectorStore, indexingPipeline
 *   - enhancementRegistry, languageService, dimensionCopy
 *   - aiProvider
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { DimensionCopy } from '@alembic/core/dimensions';
import { getFrameworkEnhancements } from '@alembic/core/enhancement';
import {
  ConsolidationAdvisor,
  ContentPatcher,
  DecayDetector,
  EnhancementSuggester,
  LifecycleStateMachine,
  ProposalExecutor,
  ProposalGateway,
  RedundancyAnalyzer,
  StagingManager,
} from '@alembic/core/evolution';
import {
  ConfidenceRouter,
  computeSourceRegionFingerprint,
  createFsSourceRefResolver,
  KnowledgeGraphService,
  KnowledgeService,
  parseSourceLineRange,
  RecipeProductionGateway,
  resolveGroundedSourcePaths,
  SourceRefReconciler,
  stripSourceRangeSuffix,
} from '@alembic/core/knowledge';
import type {
  KnowledgeEdgeRepository,
  KnowledgeRepository,
  LifecycleEventRepository,
  ProposalRepository,
  SourceRefRepository,
} from '@alembic/core/repositories';
import { HybridRetriever, SearchEngine } from '@alembic/core/search';
import { findSimilarRecipes } from '@alembic/core/service/candidate';
import { LanguageService } from '@alembic/core/shared';
import {
  HnswVectorAdapter,
  IndexingPipeline,
  JsonVectorAdapter,
  RecipeVectorGenerationManager,
  type VectorStore,
} from '@alembic/core/vector';
import {
  resolveDataRoot,
  resolveKnowledgeScanDirs,
  resolveProjectRoot,
} from '@alembic/core/workspace';
import {
  normalizeProjectScopeSourceRefsForRuntime,
  resolveProjectScopeSourceIdentitiesFromContainer,
} from '../../project-scope/ProjectScopeAnalysis.js';
import { createMainDriftGitReader } from '../../recipe-pipeline/sustain/driftBaseline.js';
import { InProcessFileChangeHandler } from '../../recipe-pipeline/sustain/evolution/InProcessFileChangeHandler.js';
import { FileChangeDispatcher } from '../../service/FileChangeDispatcher.js';
import {
  FileRecipeVectorGenerationStorage,
  GenerationRoutingVectorStore,
  RecipeVectorGenerationRuntime,
} from '../../service/vector/RecipeVectorGenerationRuntime.js';
import type { ServiceContainer } from '../ServiceContainer.js';
import { getCoreRepositoryBundle } from './InfraModule.js';

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
          // P5/C8: 注入深度接地 port，激活主体 in-process AI 的深度加权评分(未注入时退化为 legacy)。
          // 与 AlembicPlugin 共用 Core createFsSourceRefResolver 保证双宿主接地判定 parity(P6 门)。
          groundedSourcePaths: (item: Record<string, unknown>) =>
            resolveGroundedSourcePaths(item, {
              sourceRefResolver: createFsSourceRefResolver(),
              projectRoot: resolveProjectRoot(ct),
            }),
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

  c.singleton('baseVectorStore', (ct: ServiceContainer) => {
    const dataRoot = resolveDataRoot(ct);
    const wz = ct.singletons.writeZone as import('@alembic/core/io').WriteZone | undefined;
    const config =
      ((ct.singletons._config as Record<string, unknown> | undefined)?.vector as
        | Record<string, unknown>
        | undefined) || {};
    return createConfiguredVectorStore(dataRoot as string, config, wz, ct);
  });

  c.singleton('recipeVectorGenerationStorage', (ct: ServiceContainer) => {
    const dataRoot = resolveDataRoot(ct) as string;
    const wz = ct.singletons.writeZone as import('@alembic/core/io').WriteZone | undefined;
    const config =
      ((ct.singletons._config as Record<string, unknown> | undefined)?.vector as
        | Record<string, unknown>
        | undefined) || {};
    return new FileRecipeVectorGenerationStorage({
      baseStore: ct.get('baseVectorStore'),
      dataRoot,
      createStore: (storeRoot) => createConfiguredVectorStore(storeRoot, config, wz, ct),
    });
  });

  c.singleton('recipeVectorGenerationManager', (ct: ServiceContainer) => {
    const storage = ct.get('recipeVectorGenerationStorage');
    return new RecipeVectorGenerationManager(storage, storage);
  });

  c.singleton(
    'recipeVectorGenerationRuntime',
    (ct: ServiceContainer) => {
      const aiProvider = ct.singletons.aiProvider || null;
      const embedProvider = ct.singletons._embedProvider || aiProvider;
      return new RecipeVectorGenerationRuntime({
        embedProvider: embedProvider as ConstructorParameters<
          typeof RecipeVectorGenerationRuntime
        >[0]['embedProvider'],
        generationManager: ct.get('recipeVectorGenerationManager'),
        knowledgeService: ct.get('knowledgeService'),
        storage: ct.get('recipeVectorGenerationStorage'),
      });
    },
    { aiDependent: true }
  );

  c.singleton('vectorStore', (ct: ServiceContainer) => {
    return new GenerationRoutingVectorStore(
      ct.get('baseVectorStore'),
      ct.get('recipeVectorGenerationStorage')
    );
  });

  c.singleton(
    'indexingPipeline',
    (ct: ServiceContainer) => {
      const aiProvider = ct.singletons.aiProvider || null;
      const embedProvider = ct.singletons._embedProvider || aiProvider;
      const dataRoot = resolveDataRoot(ct);
      return new IndexingPipeline({
        projectRoot: dataRoot,
        scanDirs: resolveKnowledgeScanDirs(ct),
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

  // ═══ Shared ═══

  c.register('enhancementRegistry', () => getFrameworkEnhancements());
  c.register('languageService', () => LanguageService);
  c.register('dimensionCopy', () => DimensionCopy);
  c.register('aiProvider', () => c.singletons.aiProvider || null);

  // ═══ Governance / Evolution ═══

  c.singleton('sourceRefReconciler', (ct: ServiceContainer) => {
    const projectRoot = resolveProjectRoot();
    const sourceRefRepo = ct.get('recipeSourceRefRepository') as SourceRefRepository;
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepository;
    // P-C:注入 gitReader,配合调用方传 baselineCommit 后 drifted 可细分
    // line-shift/content-change(与 Plugin KnowledgeModule 同款,parity)。
    return new SourceRefReconciler(projectRoot, sourceRefRepo, knowledgeRepo, {
      signalBus: ct.singletons.signalBus || undefined,
      gitReader: createMainDriftGitReader(projectRoot),
    } as ConstructorParameters<typeof SourceRefReconciler>[3]);
  });

  c.singleton('stagingManager', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepository;
    return new StagingManager(knowledgeRepo, {
      lifecycle: ct.services.lifecycleStateMachine
        ? (ct.get('lifecycleStateMachine') as LifecycleStateMachine)
        : undefined,
      signalBus: ct.singletons.signalBus || undefined,
    } as ConstructorParameters<typeof StagingManager>[1]);
  });

  c.singleton('decayDetector', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepository;
    return new DecayDetector(knowledgeRepo, {
      signalBus: ct.singletons.signalBus || undefined,
      knowledgeEdgeRepo: ct.services.knowledgeEdgeRepository
        ? (ct.get('knowledgeEdgeRepository') as KnowledgeEdgeRepository)
        : undefined,
      sourceRefRepo: ct.services.recipeSourceRefRepository
        ? (ct.get('recipeSourceRefRepository') as SourceRefRepository)
        : undefined,
      lifecycleStateMachine: ct.services.lifecycleStateMachine
        ? (ct.get('lifecycleStateMachine') as LifecycleStateMachine)
        : undefined,
      drizzle: (
        ct.get('database') as unknown as {
          getDrizzle(): import('@alembic/core/database').DrizzleDB;
        }
      ).getDrizzle(),
    } as ConstructorParameters<typeof DecayDetector>[1]);
  });

  c.singleton('redundancyAnalyzer', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepository;
    return new RedundancyAnalyzer(knowledgeRepo, {
      signalBus: ct.singletons.signalBus || undefined,
    } as ConstructorParameters<typeof RedundancyAnalyzer>[1]);
  });

  c.singleton('enhancementSuggester', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepository;
    return new EnhancementSuggester(knowledgeRepo, {
      signalBus: ct.singletons.signalBus || undefined,
    } as ConstructorParameters<typeof EnhancementSuggester>[1]);
  });

  c.singleton('warningRepository', (ct: ServiceContainer) => {
    return getCoreRepositoryBundle(ct).warningRepository;
  });

  c.singleton('contentPatcher', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepository;
    const sourceRefRepo = ct.get('recipeSourceRefRepository') as SourceRefRepository;
    // P-B:注入 projectRoot,update 提案执行后 refs 立即带 region 指纹落锚。
    return new ContentPatcher(knowledgeRepo, sourceRefRepo, {
      projectRoot: resolveProjectRoot(ct),
    });
  });

  c.singleton('lifecycleEventRepository', (ct: ServiceContainer) => {
    return getCoreRepositoryBundle(ct).lifecycleEventRepository;
  });

  c.singleton('lifecycleStateMachine', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepository;
    const lifecycleEventRepo = ct.get('lifecycleEventRepository') as LifecycleEventRepository;
    const signalBus = ct.get('signalBus') as unknown as ConstructorParameters<
      typeof LifecycleStateMachine
    >[2];
    const proposalRepo = ct.get('proposalRepository') as ProposalRepository;
    return new LifecycleStateMachine(knowledgeRepo, lifecycleEventRepo, signalBus, proposalRepo);
  });

  c.singleton('proposalExecutor', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepository;
    const proposalRepo = ct.get('proposalRepository') as ProposalRepository;
    const lifecycle = ct.get('lifecycleStateMachine') as LifecycleStateMachine;
    const contentPatcher = ct.get('contentPatcher') as ContentPatcher;
    const edgeRepo = ct.get('knowledgeEdgeRepository') as KnowledgeEdgeRepository;
    return new ProposalExecutor(knowledgeRepo, proposalRepo, lifecycle, contentPatcher, edgeRepo);
  });

  c.singleton('consolidationAdvisor', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepository;
    return new ConsolidationAdvisor(knowledgeRepo);
  });

  c.singleton('proposalGateway', (ct: ServiceContainer) => {
    const proposalRepo = ct.get('proposalRepository') as ProposalRepository;
    const lifecycle = ct.get('lifecycleStateMachine') as LifecycleStateMachine;
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepository;
    return new ProposalGateway(proposalRepo, lifecycle, knowledgeRepo);
  });

  c.singleton('recipeProductionGateway', (ct: ServiceContainer) => {
    const knowledgeService = ct.get('knowledgeService');
    const dataRoot = resolveDataRoot(ct) as string;
    let consolidationAdvisor = null;
    let proposalRepository = null;
    let proposalGateway = null;
    try {
      consolidationAdvisor = ct.get('consolidationAdvisor');
    } catch {
      /* optional */
    }
    try {
      proposalRepository = ct.get('proposalRepository');
    } catch {
      /* optional */
    }
    try {
      proposalGateway = ct.get('proposalGateway');
    } catch {
      /* optional */
    }
    return new RecipeProductionGateway({
      knowledgeService: knowledgeService as unknown as ConstructorParameters<
        typeof RecipeProductionGateway
      >[0]['knowledgeService'],
      projectRoot: dataRoot,
      consolidationAdvisor: consolidationAdvisor as unknown as ConstructorParameters<
        typeof RecipeProductionGateway
      >[0]['consolidationAdvisor'],
      proposalRepository: proposalRepository as unknown as ConstructorParameters<
        typeof RecipeProductionGateway
      >[0]['proposalRepository'],
      proposalGateway: proposalGateway as unknown as ConstructorParameters<
        typeof RecipeProductionGateway
      >[0]['proposalGateway'],
      findSimilarRecipes,
    });
  });

  c.singleton('fileChangeHandler', (ct: ServiceContainer) => {
    const sourceRefRepo = ct.get('recipeSourceRefRepository') as SourceRefRepository;
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepository;
    const contentPatcher = ct.get('contentPatcher') as ContentPatcher;
    const gateway = ct.get('proposalGateway') as ProposalGateway;
    const dataRoot = resolveDataRoot(ct) as string;
    const projectRoot = resolveProjectRoot(ct);
    return new InProcessFileChangeHandler(sourceRefRepo, knowledgeRepo, contentPatcher, {
      signalBus:
        (ct.singletons.signalBus as import('@alembic/core/events').SignalBus | undefined) ||
        undefined,
      proposalGateway: gateway,
      dataRoot,
      projectRoot,
    });
  });

  c.singleton('fileChangeDispatcher', (ct: ServiceContainer) => {
    const dispatcher = new FileChangeDispatcher();
    const handler = ct.get('fileChangeHandler') as InProcessFileChangeHandler;
    dispatcher.register(handler);
    return dispatcher;
  });
}

function createConfiguredVectorStore(
  dataRoot: string,
  config: Record<string, unknown>,
  writeZone: import('@alembic/core/io').WriteZone | undefined,
  container: ServiceContainer
): VectorStore {
  const adapter = (config.adapter as string) || 'auto';
  if (adapter === 'json') {
    const store = new JsonVectorAdapter(dataRoot, { writeZone });
    store.initSync();
    return store;
  }

  if (adapter === 'hnsw' || adapter === 'auto') {
    try {
      const hnsw = (config.hnsw as Record<string, unknown> | undefined) || {};
      const persistence = (config.persistence as Record<string, unknown> | undefined) || {};
      const store = new HnswVectorAdapter(dataRoot, {
        M: hnsw.M as number | undefined,
        efConstruct: hnsw.efConstruct as number | undefined,
        efSearch: hnsw.efSearch as number | undefined,
        quantize: config.quantize as string | undefined,
        quantizeThreshold: config.quantizeThreshold as number | undefined,
        flushIntervalMs: persistence.flushIntervalMs as number | undefined,
        flushBatchSize: persistence.flushBatchSize as number | undefined,
        writeZone,
      });
      store.initSync();
      return store;
    } catch (err: unknown) {
      const logger = container.singletons.logger || console;
      (logger as { warn?: (...args: unknown[]) => void }).warn?.(
        '[vectorStore] HNSW init failed, falling back to JsonVectorAdapter',
        { adapter, error: (err as Error).message }
      );
    }
  }

  const store = new JsonVectorAdapter(dataRoot, { writeZone });
  store.initSync();
  return store;
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
    EventBus: Object as unknown as typeof import('@alembic/core/events').EventBus,
  };
}

/**
 * 从 knowledge_entries.reasoning 中提取 sources 并填充 recipe_source_refs 桥接表
 * 使用 KnowledgeRepository + RecipeSourceRefRepository 类型安全 API
 */
async function _populateSourceRefsForEntry(c: ServiceContainer, entryId: string): Promise<void> {
  try {
    const knowledgeRepo = c.get('knowledgeRepository') as KnowledgeRepository;
    const sourceRefRepo = c.get('recipeSourceRefRepository') as SourceRefRepository;

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

    const sourceIdentities = resolveProjectScopeSourceIdentitiesFromContainer(c);
    if (sourceIdentities.length > 0) {
      sources = normalizeProjectScopeSourceRefsForRuntime(
        sources,
        sourceIdentities
      ).activeSourceRefs;
    }

    if (sources.length === 0) {
      return;
    }

    const now = Date.now();
    // P-B(2026-07-11 落锚 parity):主体挖掘链新建 refs 此前无 contentFp,
    // 漂移检测对新知识失明直到下次 reconcile(BiliDili 真机 16 条 NULL 实证)。
    // 插入时同步算 region 指纹(512KB 护栏);失败留空由 reconcile 兜底,不阻断。
    const projectRoot = resolveProjectRoot(c);
    for (const sourcePath of sources) {
      let contentFp: string | undefined;
      try {
        const relFile = stripSourceRangeSuffix(sourcePath);
        const absolute = path.isAbsolute(relFile) ? relFile : path.join(projectRoot, relFile);
        const stat = await fsp.stat(absolute);
        if (stat.isFile() && stat.size <= 512 * 1024) {
          const content = await fsp.readFile(absolute, 'utf8');
          contentFp = computeSourceRegionFingerprint(content, parseSourceLineRange(sourcePath));
        }
      } catch {
        /* 文件不可读——留空,reconcile 兜底补锚 */
      }
      try {
        sourceRefRepo.upsert({
          recipeId: entryId,
          sourcePath,
          status: 'active',
          verifiedAt: now,
          ...(contentFp ? { contentFp } : {}),
        });
      } catch {
        /* table may not exist yet */
      }
    }
  } catch {
    /* repos may not be registered yet */
  }
}

/** 检索资源装配：搜索、向量存储/代际、索引管线；只注册惰性工厂。 */
import { HybridRetriever, SearchEngine } from '@alembic/core/search';
import {
  HnswVectorAdapter,
  IndexingPipeline,
  JsonVectorAdapter,
  RecipeVectorGenerationManager,
  type VectorStore,
} from '@alembic/core/vector';
import { resolveDataRoot, resolveKnowledgeScanDirs } from '@alembic/core/workspace';
import {
  FileRecipeVectorGenerationStorage,
  GenerationRoutingVectorStore,
  RecipeVectorGenerationRuntime,
} from '../../service/vector/RecipeVectorGenerationRuntime.js';
import { createLiveContextualEnricher } from '../ContextualEnrichment.js';
import { getEmbeddingProvider } from '../EmbeddingProvider.js';
import type { ServiceContainer } from '../ServiceContainer.js';

export function registerKnowledgeRetrieval(c: ServiceContainer) {
  // ═══ Search + Vector ═══

  c.singleton('searchEngine', (ct: ServiceContainer) => {
    const embedProvider = getEmbeddingProvider(ct);
    const vectorService = ct.services.vectorService ? ct.get('vectorService') : null;
    return new SearchEngine(ct.get('database'), {
      // Core 的兼容查询槽只调用 embed(query)；显式投影到 query 避免丢失 Qwen 指令。
      aiProvider: embedProvider
        ? { embed: (query: string) => embedProvider.embedQuery(query) }
        : null,
      vectorStore: ct.get('vectorStore'),
      vectorService,
      hybridRetriever: ct.get('hybridRetriever'),
      crossEncoderReranker: null,
      signalBus: ct.singletons.signalBus || null,
      knowledgeRepo: ct.get('knowledgeRepository'),
      sourceRefRepo: ct.get('recipeSourceRefRepository'),
    } as unknown as ConstructorParameters<typeof SearchEngine>[1]);
  });

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

  c.singleton('recipeVectorGenerationRuntime', (ct: ServiceContainer) => {
    const embedProvider = getEmbeddingProvider(ct);
    return new RecipeVectorGenerationRuntime({
      embedProvider,
      generationManager: ct.get('recipeVectorGenerationManager'),
      knowledgeService: ct.get('knowledgeService'),
      storage: ct.get('recipeVectorGenerationStorage'),
    });
  });

  c.singleton('vectorStore', (ct: ServiceContainer) => {
    return new GenerationRoutingVectorStore(
      ct.get('baseVectorStore'),
      ct.get('recipeVectorGenerationStorage'),
      () => getEmbeddingProvider(ct)?.describeCapabilities() ?? null
    );
  });

  c.singleton('indexingPipeline', (ct: ServiceContainer) => {
    const embedProvider = getEmbeddingProvider(ct);
    const dataRoot = resolveDataRoot(ct);
    const pipeline = new ProfiledIndexingPipeline(
      {
        projectRoot: dataRoot,
        scanDirs: resolveKnowledgeScanDirs(ct),
        vectorStore: ct.get('vectorStore'),
        aiProvider: embedProvider ?? undefined,
      },
      async () => {
        const store = ct.get('vectorStore');
        if (!(store instanceof GenerationRoutingVectorStore)) {
          throw new Error('Indexing requires a profile-aware vector store');
        }
        await store.assertIndexingProfile();
      }
    );
    pipeline.setContextualEnricher(createLiveContextualEnricher(ct));
    return pipeline;
  });

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
}

/** 宿主迁移门禁；分块、增量算法及 embedding 批处理仍完整委托给 Core。 */
class ProfiledIndexingPipeline extends IndexingPipeline {
  constructor(
    options: ConstructorParameters<typeof IndexingPipeline>[0],
    private readonly assertProfile: () => Promise<void>
  ) {
    super(options);
  }

  override async run(options: NonNullable<Parameters<IndexingPipeline['run']>[0]> = {}) {
    // force/clear 都由调用者明确请求重建，Core 在这两条路径不会复用历史向量。
    if (!options.force && !options.clear) {
      await this.assertProfile();
    }
    return super.run(options);
  }
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

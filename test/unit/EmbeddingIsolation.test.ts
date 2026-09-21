import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ManagedAiProvider } from '@alembic/agent/ai';
import { type EmbeddingPort, IndexingPipeline } from '@alembic/core/vector';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as AiModule from '../../lib/injection/modules/AiModule.js';
import { registerKnowledgeRetrieval } from '../../lib/injection/modules/KnowledgeRetrievalModule.js';
import * as VectorModule from '../../lib/injection/modules/VectorModule.js';
import { ServiceContainer } from '../../lib/injection/ServiceContainer.js';

// 仅固定LLM自动发现结果；真实Manager、容器与模块工厂仍执行，测试不读取操作者凭据。
vi.mock('@alembic/agent/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@alembic/agent/ai')>()),
  autoDetectProvider: () => null,
}));

describe('embedding and LLM lifecycle isolation', () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const roots: string[] = [];
  const containers: ServiceContainer[] = [];
  let embeddingHttpStatus = 200;

  function llm(model: string) {
    return {
      name: 'openai',
      model,
      supportsEmbedding: () => true,
      chat: vi.fn(async () => `Context from ${model}`),
      embed: vi.fn(async (texts: string | string[]) =>
        Array.isArray(texts)
          ? texts.map(() => [1, ...Array<number>(1023).fill(0)])
          : [1, ...Array<number>(1023).fill(0)]
      ),
    };
  }

  async function configuredContainer(
    provider: ReturnType<typeof llm>,
    enabled = true,
    contextualEnrich = true
  ) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'alembic-embedding-isolation-'));
    roots.push(root);
    const container = new ServiceContainer();
    containers.push(container);
    container.singletons._projectRoot = root;
    // 显式沙箱坐标阻止WorkspaceResolver向父仓库或操作者知识库walk-up。
    container.singletons._workspaceResolver = {
      dataRoot: root,
      recipesDir: path.join(root, 'Alembic/recipes'),
      candidatesDir: path.join(root, 'Alembic/candidates'),
    };
    container.singletons._config = {
      vector: {
        adapter: 'json',
        contextualEnrich,
        autoSyncOnCrud: false,
        localEmbedding: { enabled, endpoint: 'http://embedding.invalid' },
      },
    };
    container.singletons.aiProvider = provider;
    // 只替换资料来源；SearchEngine/IndexingPipeline/VectorService/代际工厂都是真实产品实现。
    container.register('database', () => ({
      prepare: () => ({ all: () => [], get: () => undefined, run: () => ({ changes: 0 }) }),
    }));
    container.register('knowledgeRepository', () => ({}));
    container.register('recipeSourceRefRepository', () => ({}));
    container.register('knowledgeService', () => ({
      list: async () => ({
        data: [
          {
            id: 'recipe-embedding-fixture',
            title: 'Keep the fixed embedding generation',
            lifecycle: 'active',
            whenClause: 'When the generation LLM is switched',
            doClause: 'Keep the retrieval model and active generation unchanged',
            dontClause: 'Do not use a text model as an embedding fallback',
            content: { pattern: 'Build a shadow generation before atomically activating it.' },
          },
        ],
      }),
    }));
    await AiModule.initialize(container);
    registerKnowledgeRetrieval(container);
    VectorModule.register(container);
    AiModule.register(container);
    await VectorModule.initializeVectorService(container);
    return { container, root };
  }

  function resources(container: ServiceContainer) {
    return {
      embedding: container.singletons._embedProvider,
      search: container.get('searchEngine'),
      indexing: container.get('indexingPipeline'),
      vector: container.get('vectorService'),
      generation: container.get('recipeVectorGenerationRuntime'),
    };
  }

  beforeEach(() => {
    requests.length = 0;
    embeddingHttpStatus = 200;
    for (const name of [
      'ALEMBIC_EMBED_PROVIDER',
      'ALEMBIC_EMBED_MODEL',
      'ALEMBIC_EMBED_DIMENSION',
      'ALEMBIC_EMBED_BASE_URL',
      'ALEMBIC_EMBED_ENABLED',
      'ALEMBIC_EMBED_API_KEY',
      'OLLAMA_HOST',
    ]) {
      vi.stubEnv(name, undefined);
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (new URL(url).pathname !== '/api/embed') {
          throw new Error(
            `Unexpected network route in embedding fixture: ${new URL(url).pathname}`
          );
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({ url, body });
        if (embeddingHttpStatus !== 200) {
          return new Response(JSON.stringify({ error: 'fixture embedding unavailable' }), {
            status: embeddingHttpStatus,
            headers: { 'content-type': 'application/json' },
          });
        }
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return new Response(
          JSON.stringify({
            model: body.model,
            embeddings: inputs.map(() => [1, ...Array<number>(1023).fill(0)]),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      })
    );
  });

  afterEach(async () => {
    for (const container of containers.splice(0)) {
      const vector = container.singletons.vectorService as
        | ReturnType<typeof resources>['vector']
        | null;
      await vector?.destroy();
      (container.singletons.baseVectorStore as { destroy?(): void } | undefined)?.destroy?.();
    }
    for (const root of roots.splice(0)) {
      await fs.rm(root, { force: true, recursive: true });
    }
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test('initializes fixed native Qwen query/document embedding without a configured LLM', async () => {
    const container = new ServiceContainer();
    container.singletons._config = { vector: { localEmbedding: { enabled: true } } };
    await AiModule.initialize(container);
    AiModule.register(container);

    expect(container.singletons.aiProvider).toBeNull();
    expect(container.singletons._aiProviderManager).toBeNull();
    const embedding = container.singletons._embedProvider as EmbeddingPort | null | undefined;
    expect(embedding).toMatchObject({
      embedQuery: expect.any(Function),
      embedDocuments: expect.any(Function),
      describeCapabilities: expect.any(Function),
    });
    if (!embedding) {
      throw new Error('Independent embedding port was not initialized');
    }
    expect(embedding.describeCapabilities()).toMatchObject({
      provider: 'ollama',
      model: 'qwen3-embedding:0.6b',
      dimension: 1024,
      inputKinds: ['query', 'document'],
      formatProfile: 'asymmetric',
    });
    expect(await embedding.embedQuery('fixture query')).toHaveLength(1024);
    expect(await embedding.embedDocuments(['fixture document'])).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(requests.every(({ url }) => new URL(url).pathname === '/api/embed')).toBe(true);
    expect(requests.map(({ body }) => body.model)).toEqual([
      'qwen3-embedding:0.6b',
      'qwen3-embedding:0.6b',
    ]);
    expect(requests[0].body.input).toEqual([expect.stringContaining('Instruct:')]);
    expect(requests[0].body.input).toEqual([expect.stringContaining('fixture query')]);
    expect(requests[1].body.input).toEqual(['fixture document']);
  });

  test('attaches LLM metering on first activation without replacing the independent embedding', async () => {
    const container = new ServiceContainer();
    container.singletons._config = { vector: { localEmbedding: { enabled: true } } };
    const record = vi.fn();
    container.register('tokenUsageStore', () => ({ record }));
    await AiModule.initialize(container);
    AiModule.register(container);
    const embedding = container.singletons._embedProvider;
    const first: ManagedAiProvider = llm('activated');
    container.reloadAiProvider(first as unknown as Record<string, unknown>);
    first._onTokenUsage?.({ inputTokens: 2, outputTokens: 3, totalTokens: 5, source: 'chat' });
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'activated', inputTokens: 2 })
    );
    expect(container.singletons._embedProvider).toBe(embedding);
  });

  test('keeps retrieval instances while real LLM enrichment is recreated behind the installed delegate', async () => {
    const attachEnricher = vi.spyOn(IndexingPipeline.prototype, 'setContextualEnricher');
    const firstLlm = llm('fixture-first');
    const nextLlm = llm('fixture-next');
    const { container } = await configuredContainer(firstLlm);
    const before = resources(container);
    const originalEnricher = container.get('contextualEnricher');
    const attachmentIndex = attachEnricher.mock.contexts.lastIndexOf(before.indexing);
    const installedDelegate = attachEnricher.mock.calls[attachmentIndex]?.[0];
    expect(installedDelegate).toBeTruthy();
    if (!installedDelegate) {
      throw new Error(
        'The real indexing pipeline did not receive a contextual enrichment delegate'
      );
    }
    const document = {
      title: 'Fixture',
      kind: 'code',
      content: 'Document fixture',
      sourcePath: 'fixture.md',
    };
    await installedDelegate.enrichChunks(document, [{ content: 'First chunk', metadata: {} }]);

    container.reloadAiProvider(nextLlm);
    const after = resources(container);
    expect(container.singletons.aiProvider).toBe(nextLlm);
    expect(container.get('contextualEnricher')).not.toBe(originalEnricher);
    expect(after.embedding).toBe(before.embedding);
    expect(after.search).toBe(before.search);
    expect(after.indexing).toBe(before.indexing);
    expect(after.vector).toBe(before.vector);
    expect(after.generation).toBe(before.generation);
    // Core SearchEngine的旧查询口接收embed桥；该桥应保留并转到typed embedQuery。
    expect(after.search.aiProvider).toBe(before.search.aiProvider);
    expect(after.search.aiProvider).not.toBeNull();
    const queryStart = requests.length;
    await after.search.aiProvider?.embed('Fixture query through the search bridge');
    expect(requests).toHaveLength(queryStart + 1);
    expect(requests.at(-1)?.body.input).toEqual([expect.stringContaining('Instruct:')]);
    // 使用切换前已装配的同一委托，验证保留下来的管线不会继续调用旧LLM。
    await installedDelegate.enrichChunks(document, [{ content: 'Second chunk', metadata: {} }]);
    expect(firstLlm.chat).toHaveBeenCalledTimes(1);
    expect(nextLlm.chat).toHaveBeenCalledTimes(1);
    expect(firstLlm.embed).not.toHaveBeenCalled();
    expect(nextLlm.embed).not.toHaveBeenCalled();
  });

  test('builds and activates a real native Qwen generation and keeps its active pointer across LLM switches', async () => {
    const firstLlm = llm('fixture-generation-first');
    const nextLlm = llm('fixture-generation-next');
    const { container } = await configuredContainer(firstLlm);
    const before = resources(container);
    const storage = container.get('recipeVectorGenerationStorage');
    const built = await before.generation.rebuild('migration');
    expect(built.status).toBe('activated');
    const active = await storage.readActive();
    expect(active?.generationId).toBe(built.generationId);
    const manifest = await storage.readManifest(String(built.generationId));
    expect(manifest).toMatchObject({
      status: 'ready',
      provider: 'ollama',
      model: 'qwen3-embedding:0.6b',
      dimension: 1024,
      recipeCount: 1,
    });
    expect(manifest?.expectedIds.length).toBeGreaterThan(0);
    expect(requests.length).toBeGreaterThan(0);
    expect(
      requests.every(
        ({ url, body }) =>
          new URL(url).pathname === '/api/embed' && body.model === 'qwen3-embedding:0.6b'
      )
    ).toBe(true);
    const generationStore = await storage.open(String(built.generationId));
    expect(await generationStore.listIds()).toEqual(
      expect.arrayContaining(manifest?.expectedIds ?? [])
    );

    container.reloadAiProvider(nextLlm);
    const after = resources(container);
    expect(after.generation).toBe(before.generation);
    expect(await after.generation.status()).toEqual({ active, manifest });
    expect(await storage.readActive()).toEqual(active);
    const queryStart = requests.length;
    await after.vector.search('Find the fixed embedding generation');
    expect(requests).toHaveLength(queryStart + 1);
    expect(requests.at(-1)?.body.input).toEqual([expect.stringContaining('Instruct:')]);
    expect(firstLlm.embed).not.toHaveBeenCalled();
    expect(nextLlm.embed).not.toHaveBeenCalled();
  });

  test.each([
    'legacy',
    'incomplete-owned',
  ] as const)('requires explicit re-embedding before incremental indexing can relabel %s vectors', async (kind) => {
    const { container, root } = await configuredContainer(llm('unused'), true, false);
    const pipeline = container.get('indexingPipeline');
    const base = container.get('baseVectorStore');
    const content = 'Keep the embedding space of this document explicit.';
    await fs.mkdir(path.join(root, 'recipes'), { recursive: true });
    await fs.writeFile(path.join(root, 'recipes', 'fixed.md'), content);
    const id = 'recipes_fixed.md_0';
    const old = {
      id,
      content,
      vector: [0, 1, ...Array<number>(1022).fill(0)],
      metadata: {
        type: 'recipe',
        sourcePath: 'recipes/fixed.md',
        sourceHash: pipeline.hashContent(content),
        chunkIndex: 0,
        totalChunks: kind === 'legacy' ? 1 : 2,
        ...(kind === 'legacy'
          ? {}
          : { indexingProducer: 'file-indexing-pipeline-v1', embeddingProfile: 'old-model' }),
      },
    };
    await base.upsert(old);

    await expect(pipeline.run()).rejects.toMatchObject({
      code: 'EMBEDDING_PROFILE_MIGRATION_REQUIRED',
    });
    expect(requests).toHaveLength(0);
    expect(await base.getById(id)).toMatchObject(old);

    const rebuilt = await pipeline.run({ force: true });
    expect(rebuilt).toMatchObject({ embedded: 1, upserted: 1, errors: 0 });
    expect(requests).toHaveLength(1);
    expect(await base.getById(id)).toMatchObject({
      vector: [1, ...Array<number>(1023).fill(0)],
      metadata: { embeddingProfile: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(await pipeline.run()).toMatchObject({ skipped: 1, errors: 0 });
    expect(requests).toHaveLength(1);
  });

  test.each([
    'disabled',
    'unavailable',
  ] as const)('never falls back to LLM.embed when the fixed embedding is %s', async (mode) => {
    const provider = llm(`fixture-${mode}`);
    const { container, root } = await configuredContainer(provider, mode !== 'disabled');
    const current = resources(container);
    if (mode === 'unavailable') {
      embeddingHttpStatus = 503;
    }
    await current.vector.search('Fixture search without an embedding fallback');
    await fs.mkdir(path.join(root, 'recipes'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'recipes', 'fixture.md'),
      '# Fixture\n\nKeep embedding independent from text generation.\n'
    );
    await current.indexing.run({ force: true });
    const generation = await Promise.allSettled([current.generation.rebuild('migration')]);
    expect(provider.embed).not.toHaveBeenCalled();
    if (mode === 'disabled') {
      expect(current.search.aiProvider).toBeNull();
      expect(generation[0].status).toBe('rejected');
      expect(requests).toHaveLength(0);
    } else {
      expect(current.search.aiProvider).not.toBe(provider);
      await expect(
        current.search.aiProvider?.embed('Unavailable search bridge')
      ).rejects.toMatchObject({
        code: 'EMBEDDING_UNAVAILABLE',
      });
      expect(generation[0]).toMatchObject({ status: 'fulfilled', value: { status: 'failed' } });
      expect(requests.length).toBeGreaterThan(0);
    }
    expect(await container.get('recipeVectorGenerationStorage').readActive()).toBeNull();
  });
});

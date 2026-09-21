import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HybridRetriever } from '@alembic/core/search';
import {
  type EmbeddingCapabilityDescriptor,
  IndexingPipeline,
  JsonVectorAdapter,
  RecipeVectorGenerationManager,
} from '@alembic/core/vector';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ProfiledVectorService } from '../../lib/service/vector/ProfiledVectorService.js';
import {
  FileRecipeVectorGenerationStorage,
  GenerationRoutingVectorStore,
  RecipeVectorGenerationRuntime,
} from '../../lib/service/vector/RecipeVectorGenerationRuntime.js';

describe('RecipeVectorGenerationRuntime', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'alembic-recipe-generation-'));
  });

  afterEach(async () => {
    await fs.rm(root, { force: true, recursive: true });
  });

  test('dry-run computes a manifest without creating storage or changing active routing', async () => {
    const { runtime, storage } = buildRuntime(root, embeddingProvider());

    const result = await runtime.dryRun('migration');

    expect(result).toMatchObject({ status: 'dry-run', writePerformed: false });
    expect(result.manifest).toMatchObject({ recipeCount: 1, status: 'building' });
    expect(await storage.readActive()).toBeNull();
    await expect(fs.access(storage.generationsRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test.each([
    'profile-migration',
    'storage-unavailable',
  ])('keeps %s fallback sparse without opening the embedding service circuit', async (mode) => {
    const first = buildRuntime(root, embeddingProvider({ model: 'embed-v1' }));
    await first.runtime.rebuild('migration');
    const provider = embeddingProvider({ model: 'embed-v2' });
    const query = vi.spyOn(provider, 'embedQuery');
    let storageRecovered = mode === 'profile-migration';
    const routed = new GenerationRoutingVectorStore(
      jsonStore(path.join(root, 'base')),
      first.storage,
      () => provider.describeCapabilities()
    );
    const service = new ProfiledVectorService(
      {
        vectorStore: routed,
        indexingPipeline: new IndexingPipeline({
          projectRoot: root,
          vectorStore: routed,
          aiProvider: provider,
        }),
        hybridRetriever: new HybridRetriever({ vectorStore: routed }),
        embedProvider: provider,
        eventBus: null,
        contextualEnricher: null,
        autoSyncOnCrud: false,
        syncDebounceMs: 10,
      },
      async () => {
        if (!storageRecovered) {
          throw new Error('Fixture index unavailable');
        }
        await routed.assertEmbeddingProfile();
      }
    );
    const sparseSearchFn = () => [{ id: 'lexical-fixture', score: 1 }];
    for (let i = 0; i < 4; i++) {
      const hits = await service.hybridSearch('recipe', { sparseSearchFn });
      expect(hits).toContainEqual(
        expect.objectContaining({
          id: 'lexical-fixture',
          vectorUsed: false,
          semanticUsed: false,
          fallbackReason:
            mode === 'profile-migration'
              ? 'embedding-profile-migration-required'
              : 'vector-store-unavailable',
        })
      );
    }
    expect(query).not.toHaveBeenCalled();
    await buildRuntime(root, provider).runtime.rebuild('migration');
    storageRecovered = true;
    await service.hybridSearch('recipe', { sparseSearchFn });
    expect(query).toHaveBeenCalledOnce();
    query.mockRestore();
    await service.destroy();
  });

  test('filters the base embedding profile before topK selection', async () => {
    const base = jsonStore(path.join(root, 'base'));
    const storage = new FileRecipeVectorGenerationStorage({
      baseStore: base,
      dataRoot: root,
      createStore: jsonStore,
    });
    const routed = new GenerationRoutingVectorStore(base, storage, () =>
      embeddingProvider().describeCapabilities()
    );
    await base.upsert({
      id: 'legacy-high',
      content: 'common',
      vector: [1, 0, 0],
      metadata: { type: 'code' },
    });
    await routed.upsert({
      id: 'current-valid',
      content: 'common',
      vector: [0.8, 0.6, 0],
      metadata: { type: 'code' },
    });
    expect((await routed.searchVector([1, 0, 0], { topK: 1 })).map(resultId)).toEqual([
      'current-valid',
    ]);
    expect((await routed.query([1, 0, 0], 1)).map(resultId)).toEqual(['current-valid']);
    expect((await routed.hybridSearch([1, 0, 0], 'common', { topK: 1 })).map(resultId)).toEqual([
      'current-valid',
    ]);
    await routed.upsert({
      id: 'current-high',
      content: 'common',
      vector: [1, 0, 0],
      metadata: { type: 'code' },
    });
    await routed.upsert({
      id: 'business-tagged',
      content: 'common',
      vector: [0.6, 0.8, 0],
      metadata: { type: 'code', tags: ['requested'] },
    });
    expect(
      (await routed.searchVector([1, 0, 0], { topK: 1, filter: { tags: ['requested'] } })).map(
        resultId
      )
    ).toEqual(['business-tagged']);
  });

  test.each([
    'upsert',
    'batchUpsert',
  ] as const)('%s writes to the generation snapshot whose embedding profile was validated', async (operation) => {
    const first = buildRuntime(root, embeddingProvider({ model: 'embed-v1' }));
    await first.runtime.rebuild('migration');
    const firstActive = await first.storage.readActive();
    const second = buildRuntime(root, embeddingProvider({ model: 'embed-v2' }));
    await second.runtime.rebuild('migration');
    const secondActive = await second.storage.readActive();
    if (!firstActive || !secondActive) {
      throw new Error('Expected both fixture generations to be active after rebuild');
    }
    const read = vi
      .spyOn(first.storage, 'readActive')
      .mockResolvedValueOnce(firstActive)
      .mockResolvedValue(secondActive);
    try {
      const routed = new GenerationRoutingVectorStore(
        jsonStore(path.join(root, 'base')),
        first.storage,
        () => embeddingProvider({ model: 'embed-v1' }).describeCapabilities()
      );
      const item = vectorItem('recipe_region_snapshot_probe', 'recipe-semantic-region');
      if (operation === 'upsert') {
        await routed.upsert(item);
      } else {
        await routed.batchUpsert([item]);
      }
      expect(
        await (await first.storage.open(firstActive.generationId)).getById(item.id)
      ).toMatchObject({
        id: item.id,
      });
      expect(
        await (await first.storage.open(secondActive.generationId)).getById(item.id)
      ).toBeNull();
      expect(read).toHaveBeenCalledOnce();
    } finally {
      read.mockRestore();
    }
  });

  test('queries the generation snapshot whose embedding profile was validated', async () => {
    const first = buildRuntime(root, embeddingProvider({ model: 'embed-v1' }));
    await first.runtime.rebuild('migration');
    const firstActive = await first.storage.readActive();
    const second = buildRuntime(root, embeddingProvider({ model: 'embed-v2' }));
    await second.runtime.rebuild('migration');
    const secondActive = await second.storage.readActive();
    const read = vi
      .spyOn(first.storage, 'readActive')
      .mockResolvedValueOnce(firstActive)
      .mockResolvedValue(secondActive);
    try {
      const routed = new GenerationRoutingVectorStore(
        jsonStore(path.join(root, 'base')),
        first.storage,
        () => embeddingProvider({ model: 'embed-v1' }).describeCapabilities()
      );
      const hits = await routed.searchVector([1, 0, 0]);
      expect(hits.length).toBeGreaterThan(0);
      expect(
        hits.every(
          (hit) => (hit.item.metadata as Record<string, unknown>).generationModel === 'embed-v1'
        )
      ).toBe(true);
      expect(await second.storage.readActive()).toEqual(secondActive);
    } finally {
      read.mockRestore();
    }
  });

  test.each([
    { field: 'provider', change: { provider: 'different-provider' } },
    { field: 'model at the same dimension', change: { model: 'embed-v2' } },
    { field: 'dimension', change: { dimension: 4 } },
    { field: 'format', change: { formatProfile: 'asymmetric' } },
    { field: 'normalization', change: { normalization: 'provider-defined' } },
  ] as const)('rejects dense reads after the active embedding $field changes without modifying stored data', async ({
    change,
  }) => {
    const original = embeddingProvider();
    const { runtime, storage } = buildRuntime(root, original);
    const built = await runtime.rebuild('migration');
    expect(built.status).toBe('activated');
    const vectorId = built.manifest?.expectedIds[0];
    if (!vectorId) {
      throw new Error('The real generation fixture did not create a Recipe vector');
    }
    const activeBefore = await storage.readActive();
    const activeStore = await storage.open(String(built.generationId));
    const vectorBefore = await activeStore.getById(vectorId);
    const base = jsonStore(path.join(root, 'base'));
    const descriptor: EmbeddingCapabilityDescriptor = {
      ...original.describeCapabilities(),
      ...change,
    };
    const routed = new GenerationRoutingVectorStore(base, storage, () => descriptor);
    const filesBefore = await snapshotFiles(root);
    const queryVector = [1, ...new Array<number>((descriptor.dimension ?? 3) - 1).fill(0)];

    // 同维度不同模型也不能混用；三个真正的 dense 入口都必须在旧索引查询前拒绝。
    const denseResults = await Promise.allSettled([
      routed.searchVector(queryVector),
      routed.query(queryVector),
      routed.hybridSearch(queryVector, 'Recipe', { topK: 10 }),
    ]);
    for (const [index, result] of denseResults.entries()) {
      expect(result.status, ['searchVector', 'query', 'hybridSearch'][index]).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(Error);
        expect(result.reason.message).toContain('embedding-profile-migration-required');
      }
    }

    // Profile 拒绝不是清库：管理/稀疏读取和 active pointer 继续保留原事实。
    expect(await routed.getById(vectorId)).toEqual(vectorBefore);
    expect(await routed.listIds()).toContain(vectorId);
    expect((await routed.searchByFilter({})).map(resultId)).toContain(vectorId);
    expect(Array.isArray(await routed.hybridSearch(null, 'Recipe', { topK: 10 }))).toBe(true);
    expect(await storage.readActive()).toEqual(activeBefore);
    expect(await activeStore.getById(vectorId)).toEqual(vectorBefore);
    expect(await snapshotFiles(root)).toEqual(filesBefore);

    const compatible = new GenerationRoutingVectorStore(base, storage, () =>
      original.describeCapabilities()
    );
    expect((await compatible.searchVector([1, 0, 0])).map(resultId)).toContain(vectorId);
  });

  test('plans maintenance after an embedding model change instead of rebuilding the active generation', async () => {
    const original = buildRuntime(root, embeddingProvider({ model: 'embed-v1' }));
    const built = await original.runtime.rebuild('migration');
    expect(built.status).toBe('activated');
    const activeBefore = await original.storage.readActive();
    const manifestBefore = await original.storage.readManifest(String(built.generationId));
    const filesBefore = await snapshotFiles(root);
    // 新模型仍为三维，防止仅靠维度判断掩盖不同向量空间。
    const changed = buildRuntime(root, embeddingProvider({ model: 'embed-v2' }));

    const result = await changed.runtime.maintain('incremental');

    expect(result).toMatchObject({
      status: 'planned',
      writePerformed: false,
      manifest: { model: 'embed-v2', dimension: 3 },
    });
    expect(await changed.storage.readActive()).toEqual(activeBefore);
    expect(await changed.storage.readManifest(String(built.generationId))).toEqual(manifestBefore);
    expect(await snapshotFiles(root)).toEqual(filesBefore);
  });

  test('shadow verification activates atomically, failed rebuild preserves active and diagnostics', async () => {
    const first = buildRuntime(root, embeddingProvider());
    const activated = await first.runtime.rebuild('migration');

    expect(activated.status).toBe('activated');
    const firstActive = await first.storage.readActive();
    expect(firstActive?.generationId).toBe(activated.generationId);

    const failing = buildRuntime(root, embeddingProvider({ fail: true, model: 'embed-v2' }));
    const failed = await failing.runtime.rebuild('full-build');

    expect(failed.status).toBe('failed');
    expect(await failing.storage.readActive()).toEqual(firstActive);
    expect(failed.generationId).not.toBeNull();
    expect(await failing.storage.readManifest(String(failed.generationId))).toMatchObject({
      status: 'failed',
    });
  });

  test('rollback switches to a verified previous generation without clearing first', async () => {
    const first = buildRuntime(root, embeddingProvider({ model: 'embed-v1' }));
    const generationOne = await first.runtime.rebuild('migration');
    const second = buildRuntime(root, embeddingProvider({ model: 'embed-v2' }));
    const generationTwo = await second.runtime.rebuild('full-build');

    expect(generationTwo.status).toBe('activated');
    const routed = new GenerationRoutingVectorStore(
      jsonStore(path.join(root, 'base')),
      second.storage
    );
    const vectorId = generationTwo.manifest?.expectedIds[0];
    expect(vectorId).toBeTruthy();
    expect((await routed.getById(String(vectorId)))?.metadata).toMatchObject({
      generationModel: 'embed-v2',
    });
    const rollback = await second.runtime.rollback(String(generationOne.generationId));

    expect(rollback).toMatchObject({
      status: 'rolled-back',
      generationId: generationOne.generationId,
    });
    expect((await second.storage.readActive())?.generationId).toBe(generationOne.generationId);
    expect((await routed.getById(String(vectorId)))?.metadata).toMatchObject({
      generationModel: 'embed-v1',
    });
  });

  test('reader routing preserves generic vectors while Recipe reads follow active generation', async () => {
    const base = jsonStore(path.join(root, 'base'));
    const storage = new FileRecipeVectorGenerationStorage({
      baseStore: base,
      dataRoot: root,
      createStore: jsonStore,
    });
    await base.upsert(vectorItem('code-symbol', 'code'));
    const generation = await storage.createShadow('generation-one');
    await generation.upsert(
      vectorItem('recipe_region_recipe-1_identity_hash', 'recipe-semantic-region')
    );
    await storage.writeManifest('generation-one', manifestFixture('generation-one'));
    await storage.activate({ generationId: 'generation-one', manifestHash: 'manifest-one' }, null);
    const routed = new GenerationRoutingVectorStore(base, storage);

    expect(await routed.listIds()).toEqual(
      expect.arrayContaining(['code-symbol', 'recipe_region_recipe-1_identity_hash'])
    );
    await routed.clear();
    expect(await routed.listIds()).toEqual(['recipe_region_recipe-1_identity_hash']);
  });

  test('legacy Recipe vectors remain visible until an active generation is verified', async () => {
    const base = jsonStore(path.join(root, 'base'));
    const storage = new FileRecipeVectorGenerationStorage({
      baseStore: base,
      dataRoot: root,
      createStore: jsonStore,
    });
    await base.batchUpsert([
      vectorItem('entry_recipe-legacy', 'legacy-recipe'),
      vectorItem('code-symbol', 'code'),
    ]);
    const routed = new GenerationRoutingVectorStore(base, storage);

    await expectVisibleIds(routed, ['entry_recipe-legacy', 'code-symbol']);

    await storage.createShadow('unverified-generation');
    await storage.activate(
      { generationId: 'unverified-generation', manifestHash: 'missing-manifest' },
      null
    );

    await expectVisibleIds(routed, ['entry_recipe-legacy', 'code-symbol']);
  });

  test('verified activation isolates legacy base Recipe vectors on every read surface', async () => {
    const base = jsonStore(path.join(root, 'base'));
    const storage = new FileRecipeVectorGenerationStorage({
      baseStore: base,
      dataRoot: root,
      createStore: jsonStore,
    });
    await base.batchUpsert([
      vectorItem('entry_recipe-legacy', 'legacy-recipe'),
      vectorItem('code-symbol', 'code'),
    ]);
    const generation = await storage.createShadow('verified-generation');
    await generation.upsert(
      vectorItem('recipe_region_recipe-1_identity_hash', 'recipe-semantic-region')
    );
    await storage.writeManifest('verified-generation', manifestFixture('verified-generation'));
    await storage.activate(
      { generationId: 'verified-generation', manifestHash: 'manifest-one' },
      null
    );
    const routed = new GenerationRoutingVectorStore(base, storage);

    await expectVisibleIds(routed, ['code-symbol', 'recipe_region_recipe-1_identity_hash']);
    expect(await routed.getById('entry_recipe-legacy')).toBeNull();
    expect(await routed.getById('recipe_region_recipe-1_identity_hash')).toMatchObject({
      id: 'recipe_region_recipe-1_identity_hash',
    });
  });

  test('rejects Recipe region writes before explicit generation activation', async () => {
    const base = jsonStore(path.join(root, 'base'));
    const storage = new FileRecipeVectorGenerationStorage({
      baseStore: base,
      dataRoot: root,
      createStore: jsonStore,
    });
    const routed = new GenerationRoutingVectorStore(base, storage);

    await routed.upsert(vectorItem('code-symbol', 'code'));
    await expect(
      routed.upsert(vectorItem('recipe_region_recipe-1_identity_hash', 'recipe-semantic-region'))
    ).rejects.toThrow('recipe-vector-generation-not-active');
    expect(await base.listIds()).toEqual(['code-symbol']);
  });

  test('CAS contention never removes another process lock', async () => {
    const base = jsonStore(path.join(root, 'base'));
    const storage = new FileRecipeVectorGenerationStorage({
      baseStore: base,
      dataRoot: root,
      createStore: jsonStore,
    });
    const currentStore = await storage.createShadow('generation-current');
    await currentStore.upsert({
      ...vectorItem('recipe_region_recipe-1_identity_hash', 'recipe-semantic-region'),
      metadata: { generation: 'current', type: 'recipe-semantic-region' },
    });
    await storage.writeManifest('generation-current', manifestFixture('generation-current'));
    expect(
      await storage.activate(
        { generationId: 'generation-current', manifestHash: 'manifest-one' },
        null
      )
    ).toBe(true);
    const lockPath = path.join(root, '.asd', 'context', 'recipe-vector-active.json.lock');
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    const foreignLock = JSON.stringify({
      version: 1,
      ownerPid: process.pid,
      ownerToken: randomUUID(),
      acquiredAt: Date.now(),
    });
    await fs.writeFile(lockPath, foreignLock);

    expect(
      await storage.activate(
        { generationId: 'generation-next', manifestHash: 'hash-next' },
        'generation-current'
      )
    ).toBe(false);
    expect(await fs.readFile(lockPath, 'utf8')).toBe(foreignLock);
    expect((await storage.readActive())?.generationId).toBe('generation-current');
    const routed = new GenerationRoutingVectorStore(base, storage);
    expect((await routed.getById('recipe_region_recipe-1_identity_hash'))?.metadata).toMatchObject({
      generation: 'current',
    });
  });

  test('reclaims an auditable stale lock owned by a dead process', async () => {
    const storage = new FileRecipeVectorGenerationStorage({
      dataRoot: root,
      createStore: jsonStore,
    });
    const lockPath = path.join(root, '.asd', 'context', 'recipe-vector-active.json.lock');
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        version: 1,
        ownerPid: 99_999_999,
        ownerToken: randomUUID(),
        acquiredAt: Date.now() - 60_000,
      })
    );

    expect(
      await storage.activate({ generationId: 'generation-after-crash', manifestHash: 'hash' }, null)
    ).toBe(true);
    expect(await storage.readActive()).toEqual({
      generationId: 'generation-after-crash',
      manifestHash: 'hash',
    });
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('recovers a legacy empty crash lock only after its stale timeout', async () => {
    const storage = new FileRecipeVectorGenerationStorage({
      dataRoot: root,
      createStore: jsonStore,
    });
    const lockPath = path.join(root, '.asd', 'context', 'recipe-vector-active.json.lock');
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, '');
    const staleTime = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, staleTime, staleTime);

    expect(
      await storage.activate(
        { generationId: 'generation-after-empty-lock', manifestHash: 'hash' },
        null
      )
    ).toBe(true);
    expect((await storage.readActive())?.generationId).toBe('generation-after-empty-lock');
  });

  test('independent storage instances preserve CAS with exactly one activator', async () => {
    for (let round = 0; round < 10; round += 1) {
      const roundRoot = path.join(root, `cas-${round}`);
      const first = new FileRecipeVectorGenerationStorage({
        dataRoot: roundRoot,
        createStore: jsonStore,
      });
      const second = new FileRecipeVectorGenerationStorage({
        dataRoot: roundRoot,
        createStore: jsonStore,
      });

      const results = await Promise.all([
        first.activate({ generationId: 'generation-one', manifestHash: 'one' }, null),
        second.activate({ generationId: 'generation-two', manifestHash: 'two' }, null),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(['generation-one', 'generation-two']).toContain(
        (await first.readActive())?.generationId
      );
    }
  });

  test('provider-independent terminal cleanup removes base and every known generation', async () => {
    const base = jsonStore(path.join(root, 'base'));
    const storage = new FileRecipeVectorGenerationStorage({
      baseStore: base,
      dataRoot: root,
      createStore: jsonStore,
    });
    await base.upsert(vectorItem('entry_recipe-1', 'legacy'));
    for (const id of ['generation-one', 'generation-two']) {
      const store = await storage.createShadow(id);
      await store.upsert(
        vectorItem('recipe_region_recipe-1_identity_hash', 'recipe-semantic-region')
      );
    }

    await storage.removeRecipeByIdentity('recipe-1');

    expect(await base.listIds()).toEqual([]);
    expect(await (await storage.open('generation-one')).listIds()).toEqual([]);
    expect(await (await storage.open('generation-two')).listIds()).toEqual([]);
  });
});

function buildRuntime(root: string, embedProvider: ReturnType<typeof embeddingProvider>) {
  const storage = new FileRecipeVectorGenerationStorage({
    dataRoot: root,
    createStore: (storeRoot) => {
      const store = new JsonVectorAdapter(storeRoot);
      store.initSync();
      return store;
    },
  });
  const manager = new RecipeVectorGenerationManager(storage, storage);
  const runtime = new RecipeVectorGenerationRuntime({
    embedProvider,
    generationManager: manager,
    knowledgeService: {
      async list() {
        return {
          data: [
            {
              toJSON() {
                return {
                  id: 'recipe-1',
                  title: 'Recipe One',
                  lifecycle: 'active',
                  whenClause: 'When testing generation routing',
                  doClause: 'Build a shadow generation and verify it',
                  dontClause: 'Do not clear the active generation first',
                  content: { pattern: 'Keep active routing stable until verification succeeds.' },
                };
              },
            },
          ],
        };
      },
    },
    storage,
  });
  return { runtime, storage };
}

function embeddingProvider(options: { fail?: boolean; model?: string } = {}) {
  return {
    describeCapabilities() {
      return {
        provider: 'test-provider',
        model: options.model ?? 'embed-v1',
        dimension: 3,
        inputKinds: ['query', 'document'] as const,
        batchSupported: true,
        normalization: 'normalized' as const,
        formatProfile: 'symmetric' as const,
      };
    },
    async embedQuery() {
      return [1, 0, 0];
    },
    async embedDocuments(texts: readonly string[]) {
      if (options.fail) {
        throw new Error('simulated-embedding-failure');
      }
      return texts.map(() => [1, 0, 0]);
    },
  };
}

function jsonStore(storeRoot: string) {
  const store = new JsonVectorAdapter(storeRoot);
  store.initSync();
  return store;
}

async function snapshotFiles(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [child, content] of Object.entries(await snapshotFiles(entryPath))) {
        files[path.join(entry.name, child)] = content;
      }
    } else if (entry.isFile()) {
      files[entry.name] = await fs.readFile(entryPath, 'utf8');
    }
  }
  return files;
}

function vectorItem(id: string, type: string) {
  return { id, content: id, vector: [1, 0, 0], metadata: { type } };
}

function manifestFixture(generationId: string) {
  return {
    manifestVersion: 1 as const,
    projectionSchemaVersion: 'recipe-retrieval-v1',
    vectorSchemaVersion: 2,
    provider: 'test-provider',
    model: 'embed-v1',
    dimension: 3,
    formatProfile: 'symmetric' as const,
    normalization: 'normalized' as const,
    corpusFingerprint: 'corpus-one',
    corpusHash: 'corpus-one',
    generationId,
    status: 'ready' as const,
    createdFrom: 'migration' as const,
    manifestHash: 'manifest-one',
    recipeCount: 1,
    documentCount: 1,
    expectedIds: ['recipe_region_recipe-1_identity_hash'],
    expectedIdsByRecipe: { 'recipe-1': ['recipe_region_recipe-1_identity_hash'] },
  };
}

async function expectVisibleIds(
  store: GenerationRoutingVectorStore,
  expectedIds: string[]
): Promise<void> {
  const expected = [...expectedIds].sort();
  const vector = await store.searchVector([1, 0, 0], { topK: 10 });
  const filtered = await store.searchByFilter({});
  const queried = await store.query([1, 0, 0], 10);
  const hybrid = await store.hybridSearch([1, 0, 0], 'entry recipe code symbol', { topK: 10 });

  expect(vector.map(resultId).sort()).toEqual(expected);
  expect(filtered.map(resultId).sort()).toEqual(expected);
  expect(queried.map(resultId).sort()).toEqual(expected);
  expect(hybrid.map(resultId).sort()).toEqual(expected);
  expect((await store.listIds()).sort()).toEqual(expected);
  expect((await store.getStats()).count).toBe(expected.length);
  for (const id of expected) {
    expect(await store.getById(id)).toMatchObject({ id });
  }
}

function resultId(value: unknown): string {
  const record = value as Record<string, unknown>;
  const item = record.item as Record<string, unknown> | undefined;
  return String(record.id ?? item?.id ?? '');
}

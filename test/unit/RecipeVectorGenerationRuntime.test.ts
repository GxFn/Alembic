import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonVectorAdapter, RecipeVectorGenerationManager } from '@alembic/core/vector';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
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
    const storage = new FileRecipeVectorGenerationStorage({
      dataRoot: root,
      createStore: jsonStore,
    });
    const lockPath = path.join(root, '.asd', 'context', 'recipe-vector-active.json.lock');
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, 'foreign-owner');

    expect(
      await storage.activate({ generationId: 'generation-one', manifestHash: 'hash' }, null)
    ).toBe(false);
    expect(await fs.readFile(lockPath, 'utf8')).toBe('foreign-owner');
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

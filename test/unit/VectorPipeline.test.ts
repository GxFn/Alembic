import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let JsonVectorAdapter, IndexingPipeline;

beforeAll(async () => {
  const vecMod = await import('../../lib/infrastructure/vector/JsonVectorAdapter.js');
  JsonVectorAdapter = vecMod.JsonVectorAdapter;
  const pipeMod = await import('../../lib/infrastructure/vector/IndexingPipeline.js');
  IndexingPipeline = pipeMod.IndexingPipeline;
});

/* ────────────────────────────────────────────
 *  JsonVectorAdapter
 * ──────────────────────────────────────────── */
describe('JsonVectorAdapter', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-vec-'));
    fs.mkdirSync(path.join(tmpDir, '.asd', 'context', 'index'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should persist and reload via initSync()', async () => {
    const store1 = new JsonVectorAdapter(tmpDir);
    await store1.upsert({
      id: 'doc-1',
      content: 'hello world',
      vector: [0.1, 0.2],
      metadata: { type: 'test' },
    });
    await store1.upsert({
      id: 'doc-2',
      content: 'foo bar',
      vector: [0.3, 0.4],
      metadata: { type: 'test' },
    });

    // New instance — must call initSync to load from disk
    const store2 = new JsonVectorAdapter(tmpDir);
    const beforeInit = await store2.getById('doc-1');
    expect(beforeInit).toBeNull(); // No data before init

    store2.initSync();
    const afterInit = await store2.getById('doc-1');
    expect(afterInit).not.toBeNull();
    expect(afterInit.content).toBe('hello world');

    const doc2 = await store2.getById('doc-2');
    expect(doc2).not.toBeNull();
    expect(doc2.content).toBe('foo bar');
  });

  it('should support query() as searchVector alias', async () => {
    const store = new JsonVectorAdapter(tmpDir);
    await store.batchUpsert([
      { id: 'a', content: 'alpha', vector: [1, 0, 0], metadata: { title: 'Alpha' } },
      { id: 'b', content: 'beta', vector: [0.9, 0.1, 0], metadata: { title: 'Beta' } },
      { id: 'c', content: 'gamma', vector: [0, 1, 0], metadata: { title: 'Gamma' } },
    ]);

    const results = await store.query([1, 0, 0], 2);
    expect(results).toHaveLength(2);
    // Should be sorted by similarity — 'a' exact match first
    expect(results[0].id).toBe('a');
    expect(results[0].similarity).toBeCloseTo(1.0, 3);
    expect(results[0].metadata.title).toBe('Alpha');
    // Second result should be 'b' (0.9 cosine)
    expect(results[1].id).toBe('b');
    expect(results[1].similarity).toBeGreaterThan(0.9);
  });

  it('should return correct stats', async () => {
    const store = new JsonVectorAdapter(tmpDir);
    await store.upsert({ id: 'v1', content: 'test', vector: [1, 2], metadata: {} });
    await store.upsert({ id: 'v2', content: 'test2', vector: [], metadata: {} });

    const stats = await store.getStats();
    expect(stats.count).toBe(2);
    expect(stats.hasVectors).toBe(1); // only v1 has non-empty vector
  });

  it('hybridSearch should work with empty vector (keyword-only)', async () => {
    const store = new JsonVectorAdapter(tmpDir);
    await store.batchUpsert([
      { id: 'x', content: 'singleton pattern for shared instance', vector: [], metadata: {} },
      { id: 'y', content: 'factory method for object creation', vector: [], metadata: {} },
    ]);

    const results = await store.hybridSearch([], 'singleton shared', { topK: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].item.id).toBe('x');
    expect(results[0].keywordScore).toBeGreaterThan(0);
  });
});

/* ────────────────────────────────────────────
 *  IndexingPipeline
 * ──────────────────────────────────────────── */
describe('IndexingPipeline', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-pipe-'));
    // Create recipes/ directory with test file
    fs.mkdirSync(path.join(tmpDir, 'recipes'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'recipes', 'test-recipe.md'),
      [
        '# Singleton Pattern',
        '',
        'Use `sharedInstance` for thread-safe singleton in Objective-C.',
        '',
        '```objectivec',
        '+ (instancetype)sharedInstance {',
        '    static id instance;',
        '    static dispatch_once_t onceToken;',
        '    dispatch_once(&onceToken, ^{ instance = [[self alloc] init]; });',
        '    return instance;',
        '}',
        '```',
      ].join('\n')
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should scan and index recipe files without AI provider', async () => {
    const store = new JsonVectorAdapter(tmpDir);
    const pipeline = new IndexingPipeline({
      vectorStore: store,
      aiProvider: null, // No AI — vectors will be empty []
      projectRoot: tmpDir,
    });

    const stats = await pipeline.run();
    expect(stats.scanned).toBeGreaterThan(0);
    expect(stats.upserted).toBeGreaterThan(0);
    expect(stats.embedded).toBe(0); // No AI provider

    // Verify data was written to store
    const ids = await store.listIds();
    expect(ids.length).toBeGreaterThan(0);
  });

  it('should support incremental indexing (skip unchanged)', async () => {
    const store = new JsonVectorAdapter(tmpDir);
    const pipeline = new IndexingPipeline({
      vectorStore: store,
      projectRoot: tmpDir,
    });

    const first = await pipeline.run();
    expect(first.upserted).toBeGreaterThan(0);

    const second = await pipeline.run();
    expect(second.skipped).toBeGreaterThan(0);
    expect(second.upserted).toBe(0); // Nothing changed
  });

  it('should re-index when force=true', async () => {
    const store = new JsonVectorAdapter(tmpDir);
    const pipeline = new IndexingPipeline({
      vectorStore: store,
      projectRoot: tmpDir,
    });

    await pipeline.run();
    const forced = await pipeline.run({ force: true });
    expect(forced.upserted).toBeGreaterThan(0);
    expect(forced.skipped).toBe(0);
  });

  it('should not write when dryRun=true', async () => {
    const store = new JsonVectorAdapter(tmpDir);
    const pipeline = new IndexingPipeline({
      vectorStore: store,
      projectRoot: tmpDir,
    });

    const stats = await pipeline.run({ dryRun: true });
    expect(stats.scanned).toBeGreaterThan(0);
    expect(stats.upserted).toBe(0);

    const ids = await store.listIds();
    expect(ids.length).toBe(0); // Nothing written
  });
});

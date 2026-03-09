/**
 * VectorService — 统一向量服务层 单元测试
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock 工厂 ──

function createMockVectorStore() {
  return {
    upsert: vi.fn().mockResolvedValue(undefined),
    batchUpsert: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    getById: vi.fn().mockResolvedValue(null),
    getStats: vi
      .fn()
      .mockResolvedValue({ count: 0, dimension: 768, indexSize: 0, quantized: false }),
    searchVector: vi.fn().mockResolvedValue([]),
    listIds: vi.fn().mockResolvedValue([]),
  };
}

function createMockPipeline() {
  return {
    run: vi.fn().mockResolvedValue({
      scanned: 10,
      chunked: 30,
      enriched: 0,
      embedded: 30,
      upserted: 30,
      skipped: 0,
      errors: 0,
    }),
    setAiProvider: vi.fn(),
  };
}

function createMockEmbedProvider() {
  return {
    embed: vi.fn().mockImplementation((texts: string | string[]) => {
      if (Array.isArray(texts)) {
        return Promise.resolve(texts.map(() => [0.1, 0.2, 0.3]));
      }
      return Promise.resolve([0.1, 0.2, 0.3]);
    }),
  };
}

function createMockEventBus() {
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  return {
    on: vi.fn((event: string, handler: (data: unknown) => void) => {
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event)!.push(handler);
    }),
    off: vi.fn(),
    emit: vi.fn((event: string, ...args: unknown[]) => {
      const handlers = listeners.get(event) || [];
      for (const h of handlers) {
        h(args[0]);
      }
      return true;
    }),
    emitAsync: vi.fn().mockResolvedValue(undefined),
    removeListener: vi.fn(),
  };
}

function createMockHybridRetriever() {
  return {
    search: vi
      .fn()
      .mockResolvedValue([
        { id: 'doc1', score: 0.9, rrfScore: 0.9, data: { item: { id: 'doc1' } } },
      ]),
    fuse: vi.fn().mockReturnValue([{ id: 'doc1', score: 0.9, rrfScore: 0.9 }]),
  };
}

// ── 动态导入 ──

let VectorService: typeof import('../../lib/service/vector/VectorService.js').VectorService;

beforeAll(async () => {
  const mod = await import('../../lib/service/vector/VectorService.js');
  VectorService = mod.VectorService;
});

// ── Tests ──

describe('VectorService', () => {
  let vectorStore: ReturnType<typeof createMockVectorStore>;
  let pipeline: ReturnType<typeof createMockPipeline>;
  let embedProvider: ReturnType<typeof createMockEmbedProvider>;
  let eventBus: ReturnType<typeof createMockEventBus>;
  let hybridRetriever: ReturnType<typeof createMockHybridRetriever>;

  beforeEach(() => {
    vectorStore = createMockVectorStore();
    pipeline = createMockPipeline();
    embedProvider = createMockEmbedProvider();
    eventBus = createMockEventBus();
    hybridRetriever = createMockHybridRetriever();
  });

  function createService(overrides: Record<string, unknown> = {}) {
    return new VectorService({
      vectorStore: vectorStore as never,
      indexingPipeline: pipeline as never,
      hybridRetriever: ('hybridRetriever' in overrides
        ? overrides.hybridRetriever
        : hybridRetriever) as never,
      eventBus: ('eventBus' in overrides ? overrides.eventBus : eventBus) as never,
      embedProvider: ('embedProvider' in overrides
        ? overrides.embedProvider
        : embedProvider) as never,
      contextualEnricher: ('contextualEnricher' in overrides
        ? overrides.contextualEnricher
        : null) as never,
      autoSyncOnCrud: (overrides.autoSyncOnCrud ?? false) as boolean,
      syncDebounceMs: (overrides.syncDebounceMs ?? 2000) as number,
    });
  }

  // ── fullBuild ──

  describe('fullBuild()', () => {
    it('should delegate to indexingPipeline.run()', async () => {
      const svc = createService();
      const result = await svc.fullBuild({ force: true });

      expect(pipeline.run).toHaveBeenCalledWith(
        expect.objectContaining({ force: true, dryRun: false, clear: false })
      );
      expect(result.scanned).toBe(10);
      expect(result.chunked).toBe(30);
      expect(result.embedded).toBe(30);
      expect(result.upserted).toBe(30);
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should pass clear option to pipeline', async () => {
      const svc = createService();
      await svc.fullBuild({ clear: true });

      expect(pipeline.run).toHaveBeenCalledWith(expect.objectContaining({ clear: true }));
    });

    it('should pass dryRun option to pipeline', async () => {
      const svc = createService();
      await svc.fullBuild({ dryRun: true });

      expect(pipeline.run).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    });
  });

  // ── incrementalUpdate ──

  describe('incrementalUpdate()', () => {
    it('should call pipeline.run with force=true for changed files', async () => {
      const svc = createService();
      const result = await svc.incrementalUpdate(['file1.md', 'file2.ts']);

      expect(pipeline.run).toHaveBeenCalledWith(
        expect.objectContaining({ force: true, dryRun: false, clear: false })
      );
      expect(result.scanned).toBe(10);
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should return zeros for empty file list', async () => {
      const svc = createService();
      const result = await svc.incrementalUpdate([]);

      expect(pipeline.run).not.toHaveBeenCalled();
      expect(result.scanned).toBe(0);
      expect(result.duration).toBe(0);
    });
  });

  // ── clear ──

  describe('clear()', () => {
    it('should delegate to vectorStore.clear()', async () => {
      const svc = createService();
      await svc.clear();
      expect(vectorStore.clear).toHaveBeenCalledOnce();
    });
  });

  // ── validate ──

  describe('validate()', () => {
    it('should return healthy when index has data and embed is available', async () => {
      vectorStore.getStats.mockResolvedValue({ count: 100, dimension: 768 });
      const svc = createService();
      const result = await svc.validate();

      expect(result.healthy).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should report empty index issue', async () => {
      vectorStore.getStats.mockResolvedValue({ count: 0, dimension: 0 });
      const svc = createService();
      const result = await svc.validate();

      expect(result.healthy).toBe(false);
      expect(result.issues.some((i) => i.includes('empty'))).toBe(true);
    });

    it('should report missing embed provider', async () => {
      vectorStore.getStats.mockResolvedValue({ count: 10, dimension: 768 });
      const svc = createService({ embedProvider: null });
      const result = await svc.validate();

      expect(result.healthy).toBe(false);
      expect(result.issues.some((i) => i.includes('embedding provider'))).toBe(true);
    });

    it('should report dimension=0 with non-empty index', async () => {
      vectorStore.getStats.mockResolvedValue({ count: 5, dimension: 0 });
      const svc = createService();
      const result = await svc.validate();

      expect(result.healthy).toBe(false);
      expect(result.issues.some((i) => i.includes('dimension'))).toBe(true);
    });

    it('should handle getStats failure gracefully', async () => {
      vectorStore.getStats.mockRejectedValue(new Error('store unavailable'));
      const svc = createService();
      const result = await svc.validate();

      expect(result.healthy).toBe(false);
      expect(result.issues.some((i) => i.includes('store unavailable'))).toBe(true);
    });

    it('should check orphan vectors via listIds when available', async () => {
      vectorStore.getStats.mockResolvedValue({ count: 5, dimension: 768 });
      vectorStore.listIds = vi.fn().mockResolvedValue(['entry_abc', 'chunk_1']);
      const svc = createService();
      const result = await svc.validate();

      expect(result.healthy).toBe(true);
      expect(vectorStore.listIds).toHaveBeenCalled();
    });
  });

  // ── search ──

  describe('search()', () => {
    it('should embed query and search vectorStore', async () => {
      vectorStore.searchVector.mockResolvedValue([{ item: { id: 'doc1' }, score: 0.95 }]);
      const svc = createService();
      const results = await svc.search('test query', { topK: 5 });

      expect(embedProvider.embed).toHaveBeenCalledWith('test query');
      expect(vectorStore.searchVector).toHaveBeenCalledWith(
        [0.1, 0.2, 0.3],
        expect.objectContaining({ topK: 5 })
      );
      expect(results).toHaveLength(1);
      expect(results[0].score).toBe(0.95);
    });

    it('should return empty when no embedProvider', async () => {
      const svc = createService({ embedProvider: null });
      const results = await svc.search('query');

      expect(results).toHaveLength(0);
      expect(vectorStore.searchVector).not.toHaveBeenCalled();
    });

    it('should handle embed failure gracefully', async () => {
      embedProvider.embed.mockRejectedValue(new Error('API error'));
      const svc = createService();
      const results = await svc.search('query');

      expect(results).toHaveLength(0);
    });
  });

  // ── hybridSearch ──

  describe('hybridSearch()', () => {
    it('should delegate to hybridRetriever when available', async () => {
      const svc = createService();
      const results = await svc.hybridSearch('test query', { topK: 5 });

      expect(embedProvider.embed).toHaveBeenCalledWith('test query');
      expect(hybridRetriever.search).toHaveBeenCalled();
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('doc1');
    });

    it('should fall back to search() when no hybridRetriever', async () => {
      vectorStore.searchVector.mockResolvedValue([{ item: { id: 'fallback1' }, score: 0.8 }]);
      const svc = createService({ hybridRetriever: null });
      const results = await svc.hybridSearch('query');

      expect(results).toHaveLength(1);
    });

    it('should return empty when no embedProvider', async () => {
      const svc = createService({ embedProvider: null });
      const results = await svc.hybridSearch('query');
      expect(results).toHaveLength(0);
    });

    it('should handle embed failure gracefully', async () => {
      embedProvider.embed.mockRejectedValue(new Error('API error'));
      const svc = createService();
      const results = await svc.hybridSearch('query');
      expect(results).toHaveLength(0);
    });
  });

  // ── syncEntry ──

  describe('syncEntry()', () => {
    const entry = { id: '123', title: 'Test', content: 'Hello world', kind: 'recipe' };

    it('should embed text and upsert to vectorStore', async () => {
      const svc = createService();
      await svc.syncEntry(entry);

      expect(embedProvider.embed).toHaveBeenCalledWith('Test\n\nHello world');
      expect(vectorStore.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'entry_123',
          content: 'Test\n\nHello world',
          vector: [0.1, 0.2, 0.3],
          metadata: expect.objectContaining({
            entryId: '123',
            title: 'Test',
            kind: 'recipe',
          }),
        })
      );
    });

    it('should skip when no embedProvider', async () => {
      const svc = createService({ embedProvider: null });
      await svc.syncEntry(entry);
      expect(vectorStore.upsert).not.toHaveBeenCalled();
    });

    it('should handle object content (body + code)', async () => {
      const svc = createService();
      await svc.syncEntry({
        id: '456',
        title: 'Complex',
        content: { body: 'Description', code: 'let x = 1;' },
      });

      expect(embedProvider.embed).toHaveBeenCalledWith('Complex\n\nDescription\n\nlet x = 1;');
    });

    it('should skip entry with empty content', async () => {
      const svc = createService();
      await svc.syncEntry({ id: '789', title: '', content: '' });
      expect(vectorStore.upsert).not.toHaveBeenCalled();
    });

    it('should handle embed failure gracefully', async () => {
      embedProvider.embed.mockRejectedValue(new Error('embed fail'));
      const svc = createService();
      // Should not throw
      await svc.syncEntry(entry);
      expect(vectorStore.upsert).not.toHaveBeenCalled();
    });
  });

  // ── removeEntry ──

  describe('removeEntry()', () => {
    it('should remove from vectorStore with entry_ prefix', async () => {
      const svc = createService();
      await svc.removeEntry('123');
      expect(vectorStore.remove).toHaveBeenCalledWith('entry_123');
    });

    it('should not throw on remove failure', async () => {
      vectorStore.remove.mockRejectedValue(new Error('not found'));
      const svc = createService();
      await svc.removeEntry('123'); // should not throw
    });
  });

  // ── batchSync ──

  describe('batchSync()', () => {
    it('should batch embed and upsert multiple entries', async () => {
      const svc = createService();
      const entries = [
        { id: '1', title: 'A', content: 'content-a', kind: 'recipe' },
        { id: '2', title: 'B', content: 'content-b', kind: 'concept' },
      ];
      const result = await svc.batchSync(entries);

      expect(embedProvider.embed).toHaveBeenCalledWith(['A\n\ncontent-a', 'B\n\ncontent-b']);
      expect(vectorStore.batchUpsert).toHaveBeenCalledOnce();
      expect(result.added).toBe(2);
      expect(result.errors).toHaveLength(0);
    });

    it('should return early with no embed provider', async () => {
      const svc = createService({ embedProvider: null });
      const result = await svc.batchSync([{ id: '1', title: 'A', content: 'x' }]);
      expect(result.added).toBe(0);
    });

    it('should return early with empty entries', async () => {
      const svc = createService();
      const result = await svc.batchSync([]);
      expect(result.added).toBe(0);
      expect(embedProvider.embed).not.toHaveBeenCalled();
    });

    it('should capture errors during batch embed', async () => {
      embedProvider.embed.mockRejectedValue(new Error('batch fail'));
      const svc = createService();
      const result = await svc.batchSync([{ id: '1', title: 'A', content: 'x' }]);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('batch fail');
    });
  });

  // ── getStats ──

  describe('getStats()', () => {
    it('should return normalized stats', async () => {
      vectorStore.getStats.mockResolvedValue({
        count: 42,
        dimension: 768,
        indexSize: 1024,
        quantized: true,
      });
      const svc = createService({ autoSyncOnCrud: false });
      const stats = await svc.getStats();

      expect(stats.count).toBe(42);
      expect(stats.dimension).toBe(768);
      expect(stats.indexSize).toBe(1024);
      expect(stats.quantized).toBe(true);
      expect(stats.embedProviderAvailable).toBe(true);
      expect(stats.autoSyncEnabled).toBe(false);
    });

    it('should indicate embed not available when null', async () => {
      vectorStore.getStats.mockResolvedValue({ count: 0 });
      const svc = createService({ embedProvider: null });
      const stats = await svc.getStats();
      expect(stats.embedProviderAvailable).toBe(false);
    });
  });

  // ── similarById ──

  describe('similarById()', () => {
    it('should find similar items by vector', async () => {
      vectorStore.getById.mockResolvedValue({ id: 'doc1', vector: [0.5, 0.6, 0.7] });
      vectorStore.searchVector.mockResolvedValue([
        { item: { id: 'doc1' }, score: 1.0 },
        { item: { id: 'doc2' }, score: 0.9 },
        { item: { id: 'doc3' }, score: 0.8 },
      ]);
      const svc = createService();
      const results = await svc.similarById('doc1', 2);

      // Should exclude self (doc1), returning doc2 and doc3
      expect(results).toHaveLength(2);
      expect(results[0].item).toEqual({ id: 'doc2' });
    });

    it('should return empty when entry not found', async () => {
      vectorStore.getById.mockResolvedValue(null);
      const svc = createService();
      const results = await svc.similarById('nonexistent');
      expect(results).toHaveLength(0);
    });

    it('should return empty when entry has no vector', async () => {
      vectorStore.getById.mockResolvedValue({ id: 'doc1', vector: [] });
      const svc = createService();
      const results = await svc.similarById('doc1');
      expect(results).toHaveLength(0);
    });
  });

  // ── initialize ──

  describe('initialize()', () => {
    it('should be idempotent', async () => {
      const svc = createService({ autoSyncOnCrud: false });
      await svc.initialize();
      await svc.initialize(); // second call is a no-op
    });
  });

  // ── migrateDimension ──

  describe('migrateDimension()', () => {
    it('should clear index, switch provider, and rebuild', async () => {
      const newProvider = createMockEmbedProvider();
      const svc = createService();
      const result = await svc.migrateDimension(newProvider as never);

      expect(vectorStore.clear).toHaveBeenCalledOnce();
      expect(pipeline.setAiProvider).toHaveBeenCalledWith(newProvider);
      expect(pipeline.run).toHaveBeenCalledWith(
        expect.objectContaining({ force: true, clear: false })
      );
      expect(result.scanned).toBe(10);
    });

    it('should call onProgress callback', async () => {
      const newProvider = createMockEmbedProvider();
      const svc = createService();
      const progressCalls: unknown[] = [];
      await svc.migrateDimension(newProvider as never, {
        onProgress: (info) => progressCalls.push(info),
      });

      expect(progressCalls.length).toBeGreaterThan(0);
      expect(progressCalls.some((p: unknown) => (p as { phase: string }).phase === 'migrate')).toBe(
        true
      );
    });
  });

  // ── destroy ──

  describe('destroy()', () => {
    it('should allow re-initialization after destroy', async () => {
      const svc = createService({ autoSyncOnCrud: false });
      await svc.initialize();
      svc.destroy();
      // Should not throw on re-init
      await svc.initialize();
    });
  });
});

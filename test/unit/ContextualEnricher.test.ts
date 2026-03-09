/**
 * ContextualEnricher — 上下文增强管线 单元测试
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock AI Provider ──

function createMockAiProvider() {
  return {
    chat: vi
      .fn()
      .mockResolvedValue('This chunk discusses the configuration of the vector search module.'),
  };
}

// ── 动态导入 ──

let ContextualEnricher: typeof import('../../lib/service/vector/ContextualEnricher.js').ContextualEnricher;

beforeAll(async () => {
  const mod = await import('../../lib/service/vector/ContextualEnricher.js');
  ContextualEnricher = mod.ContextualEnricher;
});

// ── Tests ──

describe('ContextualEnricher', () => {
  let aiProvider: ReturnType<typeof createMockAiProvider>;

  beforeEach(() => {
    aiProvider = createMockAiProvider();
  });

  const document = {
    title: 'Vector Service Design',
    content:
      'This document describes the design of the vector service including indexing, querying, and CRUD sync.',
    kind: 'architecture',
    sourcePath: '/docs/vector-service.md',
  };

  function createEnricher(opts: { cacheEnabled?: boolean } = {}) {
    return new ContextualEnricher({
      aiProvider: aiProvider as never,
      cacheEnabled: opts.cacheEnabled,
    });
  }

  // ── enrichChunks ──

  describe('enrichChunks()', () => {
    it('should add context prefix to each chunk', async () => {
      const enricher = createEnricher();
      const chunks = [
        { content: 'IndexingPipeline handles indexing.', metadata: { chunkIndex: 0 } },
        { content: 'VectorStore provides query methods.', metadata: { chunkIndex: 1 } },
      ];

      const result = await enricher.enrichChunks(document, chunks);

      expect(result).toHaveLength(2);
      // Each chunk should have context prefix in brackets
      expect(result[0].content).toContain('[');
      expect(result[0].content).toContain('IndexingPipeline handles indexing.');
      expect(result[0].metadata.contextEnriched).toBe(true);
      expect(result[0].metadata.contextLength).toBeGreaterThan(0);

      // AI provider should be called once per chunk
      expect(aiProvider.chat).toHaveBeenCalledTimes(2);
    });

    it('should return empty array for empty chunks', async () => {
      const enricher = createEnricher();
      const result = await enricher.enrichChunks(document, []);
      expect(result).toHaveLength(0);
      expect(aiProvider.chat).not.toHaveBeenCalled();
    });

    it('should pass system prompt and chunk content to AI', async () => {
      const enricher = createEnricher();
      const chunks = [{ content: 'Hello world', metadata: {} }];

      await enricher.enrichChunks(document, chunks);

      expect(aiProvider.chat).toHaveBeenCalledWith(
        expect.stringContaining('<chunk>'),
        expect.objectContaining({
          system: expect.stringContaining(document.title),
          maxTokens: 120,
          temperature: 0,
        })
      );
    });

    it('should truncate long documents in system prompt', async () => {
      const enricher = createEnricher();
      const longDoc = {
        ...document,
        content: 'x'.repeat(10000), // exceeds 8000 char limit
      };
      const chunks = [{ content: 'test', metadata: {} }];

      await enricher.enrichChunks(longDoc, chunks);

      const systemPrompt = aiProvider.chat.mock.calls[0][1]?.system as string;
      expect(systemPrompt).toContain('[... document truncated ...]');
      expect(systemPrompt.length).toBeLessThan(10500); // should be truncated
    });

    it('should escape XML in document title', async () => {
      const enricher = createEnricher();
      const xssDoc = {
        ...document,
        title: 'Test <script>alert(1)</script>',
      };
      const chunks = [{ content: 'test', metadata: {} }];

      await enricher.enrichChunks(xssDoc, chunks);

      const systemPrompt = aiProvider.chat.mock.calls[0][1]?.system as string;
      expect(systemPrompt).toContain('&lt;script&gt;');
      expect(systemPrompt).not.toContain('<script>');
    });

    it('should handle per-chunk AI failure gracefully', async () => {
      aiProvider.chat
        .mockResolvedValueOnce('Good context')
        .mockRejectedValueOnce(new Error('API error'))
        .mockResolvedValueOnce('Another context');

      const enricher = createEnricher();
      const chunks = [
        { content: 'chunk1', metadata: { idx: 0 } },
        { content: 'chunk2', metadata: { idx: 1 } }, // will fail
        { content: 'chunk3', metadata: { idx: 2 } },
      ];

      const result = await enricher.enrichChunks(document, chunks);

      expect(result).toHaveLength(3);
      // First and third should be enriched
      expect(result[0].metadata.contextEnriched).toBe(true);
      expect(result[2].metadata.contextEnriched).toBe(true);
      // Second should be returned unchanged (no enrichment)
      expect(result[1].content).toBe('chunk2');
      expect(result[1].metadata.contextEnriched).toBeUndefined();
    });

    it('should strip quotes from AI response', async () => {
      aiProvider.chat.mockResolvedValue('"This is a quoted context response."');
      const enricher = createEnricher();
      const chunks = [{ content: 'test', metadata: {} }];

      const result = await enricher.enrichChunks(document, chunks);

      // Should not start with [ + "
      expect(result[0].content).not.toContain('["');
    });

    it('should limit context length to 500 chars', async () => {
      aiProvider.chat.mockResolvedValue('x'.repeat(600));
      const enricher = createEnricher();
      const chunks = [{ content: 'test', metadata: {} }];

      const result = await enricher.enrichChunks(document, chunks);

      // Context is in brackets before the content
      const contextPart = result[0].content.split('\n\n')[0];
      // brackets + context ≤ 502 + 2 for brackets
      expect(contextPart.length).toBeLessThanOrEqual(505);
    });
  });

  // ── Caching ──

  describe('caching', () => {
    it('should cache enrichment results (same source+content → no re-call)', async () => {
      const enricher = createEnricher({ cacheEnabled: true });
      const chunks = [{ content: 'Hello world', metadata: {} }];

      await enricher.enrichChunks(document, chunks);
      expect(aiProvider.chat).toHaveBeenCalledOnce();

      // Same chunk again
      await enricher.enrichChunks(document, chunks);
      expect(aiProvider.chat).toHaveBeenCalledOnce(); // no additional call
    });

    it('should not use cache when disabled', async () => {
      const enricher = createEnricher({ cacheEnabled: false });
      const chunks = [{ content: 'Hello world', metadata: {} }];

      await enricher.enrichChunks(document, chunks);
      await enricher.enrichChunks(document, chunks);

      expect(aiProvider.chat).toHaveBeenCalledTimes(2);
    });

    it('should expose cacheSize', async () => {
      const enricher = createEnricher();
      expect(enricher.cacheSize).toBe(0);

      await enricher.enrichChunks(document, [
        { content: 'a', metadata: {} },
        { content: 'b', metadata: {} },
      ]);

      expect(enricher.cacheSize).toBe(2);
    });

    it('should clear cache on clearCache()', async () => {
      const enricher = createEnricher();
      await enricher.enrichChunks(document, [{ content: 'test', metadata: {} }]);
      expect(enricher.cacheSize).toBe(1);

      enricher.clearCache();
      expect(enricher.cacheSize).toBe(0);
    });
  });
});

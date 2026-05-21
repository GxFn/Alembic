import { describe, expect, it, vi } from 'vitest';
import { CrossEncoderReranker } from '../../lib/service/search/CrossEncoderReranker.js';

describe('CrossEncoderReranker', () => {
  it('falls back to deterministic Jaccard scoring when no AI provider is configured', async () => {
    const reranker = new CrossEncoderReranker({
      aiProvider: null,
      logger: { warn: vi.fn() },
    });

    const result = await reranker.rerank('react hooks', [
      { id: 'a', title: 'react hooks guide', content: 'useState useEffect' },
      { id: 'b', title: 'vue composition', content: 'ref reactive' },
    ]);

    expect(result.map((item) => item.id)).toEqual(['a', 'b']);
    expect(result[0]).toHaveProperty('semanticScore');
  });

  it('uses AI scores when a structured provider is available', async () => {
    const reranker = new CrossEncoderReranker({
      aiProvider: {
        chatWithStructuredOutput: vi.fn().mockResolvedValue([
          { i: 0, s: 0.2 },
          { i: 1, s: 0.9 },
        ]),
      },
      logger: { warn: vi.fn() },
    });

    const result = await reranker.rerank('best match', [
      { id: 'low', title: 'partial', content: 'partial' },
      { id: 'high', title: 'best match', content: 'best match' },
    ]);

    expect(result.map((item) => item.id)).toEqual(['high', 'low']);
    expect(result[0].semanticScore).toBe(0.9);
  });
});

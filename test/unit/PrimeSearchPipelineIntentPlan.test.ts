import { describe, expect, test, vi } from 'vitest';
import { normalizeHostIntentContext } from '../../lib/service/task/HostIntentContext.js';
import { extract } from '../../lib/service/task/IntentExtractor.js';
import { buildIntentSearchPlan } from '../../lib/service/task/IntentSearchPlan.js';
import { PrimeSearchPipeline } from '../../lib/service/task/PrimeSearchPipeline.js';

describe('PrimeSearchPipeline IntentSearchPlan consumption', () => {
  test('uses applied IntentSearchPlan lexical query and exposes plan evidence in searchMeta', async () => {
    const searchEngine = {
      search: vi.fn(async (query: string) => ({
        items: [
          {
            description: `match for ${query}`,
            id: `recipe-${searchEngine.search.mock.calls.length}`,
            kind: 'pattern',
            language: 'typescript',
            score: 0.91,
            sourceRefs: ['src/service.ts:12'],
            title: `Recipe ${query}`,
            trigger: query,
          },
        ],
      })),
    };
    const pipeline = new PrimeSearchPipeline(searchEngine);
    const hostIntentContext = normalizeHostIntentContext({
      intentContext: {
        recognizedIntentDraft: {
          confidence: 0.9,
          constraints: ['dependency injection'],
          query: 'compose service factory',
          sourceRefs: ['host:intent'],
          status: 'recognized',
        },
      },
      userQuery: 'fallback query',
    });
    const plan = buildIntentSearchPlan({
      hostIntentContext,
      intentContext: {
        recognizedIntentDraft: {
          confidence: 0.9,
          constraints: ['dependency injection'],
          query: 'compose service factory',
          sourceRefs: ['host:intent'],
          status: 'recognized',
        },
      },
      mode: 'prime',
      rawQuery: 'fallback query',
    });

    const result = await pipeline.search(extract('fallback query'), { intentSearchPlan: plan });

    expect(searchEngine.search.mock.calls[0]?.[0]).toContain('compose service factory');
    expect(searchEngine.search.mock.calls[0]?.[0]).toContain('dependency injection');
    expect(result?.searchMeta.intentSearchPlan).toMatchObject({
      applied: true,
      rankingProfile: 'prime-intent',
      sourceRefs: ['host:intent'],
      whySelected: expect.arrayContaining(['recognizedIntentDraft.query']),
    });
    expect(result?.searchMeta.intentEvidence).toMatchObject({
      semanticAnchors: expect.arrayContaining([
        expect.objectContaining({ value: expect.stringContaining('compose service factory') }),
      ]),
      topAnchorMatches: expect.arrayContaining([
        expect.objectContaining({ itemId: 'recipe-1', matchType: 'text' }),
      ]),
      scoreBreakdown: expect.arrayContaining([
        expect.objectContaining({
          finalScore: 0.91,
          itemId: 'recipe-1',
          lexicalScore: 0.91,
        }),
      ]),
    });
    expect(result?.searchMeta.primeInjectionPackage).toMatchObject({
      injection: expect.objectContaining({
        selectedCount: expect.any(Number),
        status: 'degraded',
      }),
      selectedKnowledge: expect.arrayContaining([
        expect.objectContaining({
          evidenceRefs: expect.arrayContaining([
            'scoreBreakdown:recipe-1',
            'topAnchorMatch:recipe-1',
          ]),
          injectionStatus: 'selected',
          itemId: 'recipe-1',
          sourceRefs: ['src/service.ts:12'],
        }),
      ]),
      trace: expect.objectContaining({
        sourceRefs: expect.arrayContaining(['host:intent', 'src/service.ts:12']),
      }),
    });
    expect(result?.searchMeta.queries[0]).toContain('compose service factory');
  });
});

import { describe, expect, test } from 'vitest';
import {
  recipeBelongsToDimension,
  resolveRecipeDimensionId,
} from '#domain/dimension/RecipeDimension.js';

describe('RecipeDimension resolver', () => {
  test('uses explicit dimensionId as the canonical owner', () => {
    expect(
      resolveRecipeDimensionId({
        dimensionId: 'error-resilience',
        category: 'architecture',
        knowledgeType: 'code-pattern',
      })
    ).toBe('error-resilience');
  });

  test('lets runtime dimensions disambiguate legacy knowledgeType before registry category fallback', () => {
    expect(
      resolveRecipeDimensionId(
        {
          category: 'architecture',
          knowledgeType: 'api',
        },
        { knownDimensionIds: ['api', 'ui'] }
      )
    ).toBe('api');
  });

  test('does not count broad artifact types across explicitly owned dimensions', () => {
    const entry = { category: 'error-resilience', knowledgeType: 'best-practice' };

    expect(
      recipeBelongsToDimension(entry, { id: 'error-resilience', knowledgeTypes: ['best-practice'] })
    ).toBe(true);
    expect(
      recipeBelongsToDimension(entry, {
        id: 'observability-logging',
        knowledgeTypes: ['best-practice'],
      })
    ).toBe(false);
  });

  test('falls back to dimension knowledgeTypes only when no owner was resolved', () => {
    const entry = { category: '', knowledgeType: 'code-pattern' };

    expect(
      recipeBelongsToDimension(entry, { id: 'design-patterns', knowledgeTypes: ['code-pattern'] })
    ).toBe(true);
  });

  test('recovers legacy dimension tags and agent notes', () => {
    expect(
      resolveRecipeDimensionId({
        tags: ['bootstrap', 'dimension:testing-quality'],
      })
    ).toBe('testing-quality');
    expect(resolveRecipeDimensionId({ agentNotes: { dimensionId: 'design-patterns' } })).toBe(
      'design-patterns'
    );
  });
});

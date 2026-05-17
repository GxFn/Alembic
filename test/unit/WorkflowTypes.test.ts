import { normalizeDimensionIds, normalizeStringArray } from '@alembic/core/host-agent-workflows';
import { describe, expect, test } from 'vitest';

describe('WorkflowTypes normalization', () => {
  test('normalizes comma-separated and repeated dimension arguments', () => {
    expect(normalizeDimensionIds(['design-patterns,error-resilience', 'architecture'])).toEqual([
      'design-patterns',
      'error-resilience',
      'architecture',
    ]);
  });

  test('trims empty values and ignores non-string values', () => {
    expect(normalizeStringArray([' api ', '', 'ui,,storage', 42, null])).toEqual([
      'api',
      'ui',
      'storage',
    ]);
  });
});

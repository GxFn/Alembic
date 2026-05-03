import { describe, expect, test } from 'vitest';
import {
  normalizeDimensionIds,
  normalizeStringArray,
} from '../../lib/workflows/shared/WorkflowTypes.js';

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

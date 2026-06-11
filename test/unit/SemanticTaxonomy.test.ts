import { describe, expect, test } from 'vitest';
import {
  DEPRECATED_LIFECYCLE_CAUSES,
  HOST_INTENT_CONTEXT_MODES,
  HOST_INTENT_LEGACY_COMPATIBILITY,
  SEARCH_MODE_FIELD_TAXONOMY,
} from '../../lib/shared/semantic-taxonomy.js';

describe('Alembic semantic taxonomy', () => {
  test('records HostIntentContext modes and legacy ownership without schema changes', () => {
    expect(HOST_INTENT_CONTEXT_MODES).toEqual([
      'host-intent-frame',
      'mixed-host-intent-and-legacy-args',
      'legacy-args-only',
    ]);
    expect(HOST_INTENT_LEGACY_COMPATIBILITY).toMatchObject({
      consumer: 'alembic-plugin',
      owner: 'alembic-main',
    });
  });

  test('names search mode fields and deprecated lifecycle causes explicitly', () => {
    expect(Object.keys(SEARCH_MODE_FIELD_TAXONOMY)).toEqual([
      'actualMode',
      'degradedMode',
      'hookMode',
      'legacyFallbackMode',
      'requestedMode',
      'runtimeMode',
    ]);
    expect(DEPRECATED_LIFECYCLE_CAUSES.map((entry) => entry.cause)).toEqual([
      'manual-curation',
      'evolution-decay',
      'source-orphan-cleanup',
    ]);
  });
});

import { describe, expect, test } from 'vitest';
import { resolveAiDimensionConcurrency } from '../../lib/workflows/ai-execution/AiDimensionSessionRunner.js';

describe('AI dimension session runner settings', () => {
  test('uses sanitized workflow concurrency settings', () => {
    expect(
      resolveAiDimensionConcurrency({
        ALEMBIC_PARALLEL_CONCURRENCY: '5',
      })
    ).toEqual({ enableParallel: true, concurrency: 5 });

    expect(
      resolveAiDimensionConcurrency({
        ALEMBIC_PARALLEL_BOOTSTRAP: 'false',
        ALEMBIC_PARALLEL_CONCURRENCY: '5',
      })
    ).toEqual({ enableParallel: false, concurrency: 1 });

    expect(
      resolveAiDimensionConcurrency({
        ALEMBIC_PARALLEL_CONCURRENCY: '0',
      })
    ).toEqual({ enableParallel: true, concurrency: 3 });
  });

  test('accepts the profile-level concurrency env as a compatibility fallback', () => {
    expect(
      resolveAiDimensionConcurrency({
        ALEMBIC_BOOTSTRAP_CONCURRENCY: '4',
      })
    ).toEqual({ enableParallel: true, concurrency: 4 });
  });
});

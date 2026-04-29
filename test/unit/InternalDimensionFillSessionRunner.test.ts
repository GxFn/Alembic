import { describe, expect, test } from 'vitest';
import { resolveInternalDimensionExecutionConcurrency } from '#workflows/capabilities/execution/internal-agent/InternalDimensionFillSessionRunner.js';

describe('internal dimension fill session runner settings', () => {
  test('uses sanitized workflow concurrency settings', () => {
    expect(
      resolveInternalDimensionExecutionConcurrency({
        ALEMBIC_PARALLEL_CONCURRENCY: '5',
      })
    ).toEqual({ enableParallel: true, concurrency: 5 });

    expect(
      resolveInternalDimensionExecutionConcurrency({
        ALEMBIC_PARALLEL_BOOTSTRAP: 'false',
        ALEMBIC_PARALLEL_CONCURRENCY: '5',
      })
    ).toEqual({ enableParallel: false, concurrency: 1 });

    expect(
      resolveInternalDimensionExecutionConcurrency({
        ALEMBIC_PARALLEL_CONCURRENCY: '0',
      })
    ).toEqual({ enableParallel: true, concurrency: 3 });
  });

  test('accepts the profile-level concurrency env as a compatibility fallback', () => {
    expect(
      resolveInternalDimensionExecutionConcurrency({
        ALEMBIC_BOOTSTRAP_CONCURRENCY: '4',
      })
    ).toEqual({ enableParallel: true, concurrency: 4 });
  });
});

import { describe, expect, test } from 'vitest';
import {
  resolveAiDimensionConcurrency,
  resolveBootstrapGroundingEnforcement,
} from '../../lib/workflows/ai-execution/AiDimensionSessionRunner.js';

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

  test('resolves the AP-7 per-invocation grounding-enforcement opt-in from env (default observe-only)', () => {
    // 显式 opt-in：质量验证会话（PCVM/Test）设置 env → guard。
    expect(resolveBootstrapGroundingEnforcement({ ALEMBIC_GROUNDING_ENFORCEMENT: 'guard' })).toBe(
      'guard'
    );
    // 显式 observe-only。
    expect(resolveBootstrapGroundingEnforcement({ ALEMBIC_GROUNDING_ENFORCEMENT: 'off' })).toBe(
      'off'
    );
    // 未设 / 非法值 → undefined（不覆盖，回退默认 observe-only，零行为变更）。
    expect(resolveBootstrapGroundingEnforcement({})).toBeUndefined();
    expect(
      resolveBootstrapGroundingEnforcement({ ALEMBIC_GROUNDING_ENFORCEMENT: 'bogus' })
    ).toBeUndefined();
  });
});

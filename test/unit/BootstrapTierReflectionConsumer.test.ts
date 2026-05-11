import { describe, expect, test, vi } from 'vitest';
import {
  consumeBootstrapTierReflection,
  type DimensionStat,
} from '#workflows/capabilities/execution/internal-agent/BootstrapConsumers.js';
import type { SessionStore } from '../../lib/agent/memory/SessionStore.js';

describe('bootstrap tier reflection consumer', () => {
  test('builds and stores tier reflection from completed dimension stats', () => {
    const addTierReflection = vi.fn();
    const tierResults = new Map<string, DimensionStat>([
      ['api', { candidateCount: 2, durationMs: 10 }],
      ['ui', { candidateCount: 1, durationMs: 20 }],
    ]);

    const reflection = consumeBootstrapTierReflection({
      tierIndex: 0,
      tierResults,
      sessionStore: {
        getDimensionReport: (dimId: string) => ({
          findings: [{ finding: `${dimId} shares src/core.ts`, evidence: 'src/core.ts:1' }],
          digest: { gaps: [`${dimId} gap`] },
        }),
        addTierReflection,
      } as unknown as SessionStore,
    });

    expect(reflection).toMatchObject({
      tierIndex: 0,
      completedDimensions: ['api', 'ui'],
    });
    expect(reflection?.topFindings).toHaveLength(2);
    expect(reflection?.crossDimensionPatterns).toContain(
      '文件 "src/core.ts" 被 2 个维度引用 — 可能是系统核心组件'
    );
    expect(addTierReflection).toHaveBeenCalledWith(0, reflection);
  });
});

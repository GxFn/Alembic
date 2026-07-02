import type { SessionStore } from '@alembic/agent/memory';
import type { AgentRunResult } from '@alembic/agent/service';
import { describe, expect, test, vi } from 'vitest';
import {
  consumeGenerateSessionResult,
  consumeMissingGenerateDimensions,
  type DimensionStat,
} from '../../lib/workflows/ai-execution/GenerateConsumers.js';

function makeRunResult(partial: Partial<AgentRunResult>): AgentRunResult {
  return {
    runId: 'run-1',
    profileId: 'generate-session',
    reply: '',
    status: 'success',
    phases: {},
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0, iterations: 0, durationMs: 0 },
    diagnostics: null,
    ...partial,
  };
}

describe('bootstrap session consumer', () => {
  test('projects parent result and reports missing dimensions through callback', () => {
    const consumeMissingDimension = vi.fn();
    const dimensionStats: Record<string, DimensionStat> = {
      restored: { candidateCount: 0, durationMs: 0, restoredFromCheckpoint: true },
    };

    const projection = consumeGenerateSessionResult({
      parentRunResult: makeRunResult({
        status: 'success',
        phases: {
          dimensionResults: {
            api: makeRunResult({ runId: 'api:run', profileId: 'generate-dimension' }),
          },
        },
      }),
      activeDimIds: ['api', 'ui', 'restored'],
      skippedDimIds: ['restored'],
      durationMs: 123,
      sessionStore: {
        getStats: () => ({
          completedDimensions: 1,
          totalFindings: 2,
          referencedFiles: 3,
          crossReferences: 4,
          tierReflections: 5,
          cache: { hitRate: '80%', searchCacheSize: 1, fileCacheSize: 2 },
        }),
      } as unknown as SessionStore,
      dimensionStats,
      consumeMissingDimension,
    });

    expect(projection.completedDimensions).toBe(1);
    expect(projection.missingDimensionIds).toEqual(['ui']);
    expect(consumeMissingDimension).toHaveBeenCalledWith('ui');
  });

  test('does not report missing dimensions that already have stats', () => {
    const consumeMissingDimension = vi.fn();
    consumeMissingGenerateDimensions({
      missingDimensionIds: ['api', 'ui'],
      dimensionStats: {
        api: { candidateCount: 0, durationMs: 0, error: 'already recorded' },
      },
      consumeMissingDimension,
    });

    expect(consumeMissingDimension).toHaveBeenCalledTimes(1);
    expect(consumeMissingDimension).toHaveBeenCalledWith('ui');
  });
});

import { describe, expect, test, vi } from 'vitest';
import {
  type CandidateResults,
  consumeBootstrapDimensionError,
  consumeBootstrapDimensionResult,
  type DimensionCandidateData,
  type DimensionStat,
} from '#workflows/deprecated-cold-start/consumers/BootstrapDimensionConsumer.js';
import type { DimensionContext } from '#workflows/deprecated-cold-start/context/DimensionContext.js';
import type { BootstrapDimensionProjection } from '#workflows/deprecated-cold-start/projections/BootstrapDimensionProjection.js';
import type { MemoryCoordinator } from '../../lib/agent/memory/MemoryCoordinator.js';
import type { SessionStore } from '../../lib/agent/memory/SessionStore.js';
import type { BootstrapEventEmitter } from '../../lib/service/bootstrap/BootstrapEventEmitter.js';

function makeProjection(): BootstrapDimensionProjection {
  return {
    analysisText: 'short analysis',
    artifact: { analysisText: 'short analysis', referencedFiles: ['src/a.ts'], findings: ['one'] },
    runtimeToolCalls: [
      {
        tool: 'submit_knowledge',
        args: { title: 'Candidate', category: 'api', summary: 'Summary' },
      },
    ],
    combinedTokenUsage: { input: 3, output: 5 },
    analysisReport: {
      dimensionId: 'api',
      analysisText: 'short analysis',
      findings: ['one'],
      referencedFiles: ['src/a.ts'],
    },
    producerResult: {
      candidateCount: 1,
      rejectedCount: 0,
      toolCalls: [
        {
          tool: 'submit_knowledge',
          args: { title: 'Candidate', category: 'api', summary: 'Summary' },
        },
      ],
      reply: 'producer reply',
      tokenUsage: { input: 3, output: 5 },
    },
    submitCalls: [],
    successCount: 0,
    rejectedCount: 0,
  };
}

describe('bootstrap dimension consumer', () => {
  test('writes dimension result side effects through explicit dependencies', async () => {
    const candidateResults: CandidateResults = { created: 0, failed: 0, errors: [] };
    const dimensionCandidates: Record<string, DimensionCandidateData> = {};
    const dimensionStats: Record<string, DimensionStat> = {};
    const storeDimensionReport = vi.fn();
    const addDimensionDigest = vi.fn();
    const addSubmittedCandidate = vi.fn();
    const emitDimensionComplete = vi.fn();

    const result = await consumeBootstrapDimensionResult({
      ctx: {},
      dimId: 'api',
      dimConfig: { label: 'API' },
      needsCandidates: false,
      projection: makeProjection(),
      runResult: { degraded: false },
      dimStartTime: Date.now(),
      analystScopeId: 'api:analyst',
      memoryCoordinator: {
        getActiveContext: () => ({
          distill: () => ({ keyFindings: [], totalObservations: 0, toolCallSummary: [] }),
        }),
      } as unknown as MemoryCoordinator,
      sessionStore: {
        storeDimensionReport,
        addDimensionDigest,
        addSubmittedCandidate,
      } as unknown as SessionStore,
      dimContext: {
        addDimensionDigest,
        addSubmittedCandidate,
      } as unknown as DimensionContext,
      candidateResults,
      dimensionCandidates,
      dimensionStats,
      emitter: { emitDimensionComplete } as unknown as BootstrapEventEmitter,
      dataRoot: '/tmp',
      sessionId: 'session-1',
    });

    expect(candidateResults.created).toBe(1);
    expect(dimensionCandidates.api?.analysisReport.referencedFiles).toEqual(['src/a.ts']);
    expect(storeDimensionReport).toHaveBeenCalledWith(
      'api',
      expect.objectContaining({ analysisText: 'short analysis', referencedFiles: ['src/a.ts'] })
    );
    expect(addDimensionDigest).toHaveBeenCalled();
    expect(addSubmittedCandidate).toHaveBeenCalledWith(
      'api',
      expect.objectContaining({ title: 'Candidate', subTopic: 'api', summary: 'Summary' })
    );
    expect(emitDimensionComplete).toHaveBeenCalledWith(
      'api',
      expect.objectContaining({ type: 'skill', created: 1 })
    );
    expect(dimensionStats.api).toMatchObject({ candidateCount: 1, analysisText: 'short analysis' });
    expect(result).toBe(dimensionStats.api);
  });

  test('records dimension errors through explicit dependencies', () => {
    const candidateResults: CandidateResults = { created: 0, failed: 0, errors: [] };
    const dimensionStats: Record<string, DimensionStat> = {};
    const emitDimensionComplete = vi.fn();

    const result = consumeBootstrapDimensionError({
      dimId: 'api',
      err: new Error('boom'),
      candidateResults,
      dimensionStats,
      emitter: { emitDimensionComplete } as unknown as BootstrapEventEmitter,
    });

    expect(candidateResults.errors).toEqual([{ dimId: 'api', error: 'boom' }]);
    expect(dimensionStats.api).toEqual({ candidateCount: 0, durationMs: 0, error: 'boom' });
    expect(emitDimensionComplete).toHaveBeenCalledWith('api', {
      type: 'error',
      reason: 'boom',
    });
    expect(result).toBe(dimensionStats.api);
  });
});

import type { MemoryCoordinator, SessionStore } from '@alembic/agent/memory';
import { describe, expect, test, vi } from 'vitest';
import {
  type CandidateResults,
  consumeBootstrapDimensionError,
  consumeBootstrapDimensionResult,
  type DimensionCandidateData,
  type DimensionStat,
} from '#workflows/capabilities/execution/internal-agent/BootstrapConsumers.js';
import type { BootstrapDimensionProjection } from '#workflows/capabilities/execution/internal-agent/BootstrapProjections.js';
import type { DimensionContext } from '#workflows/capabilities/execution/internal-agent/DimensionContext.js';
import type { BootstrapEventEmitter } from '../../lib/service/bootstrap/BootstrapEventEmitter.js';

function makeProjection(): BootstrapDimensionProjection {
  const successfulSubmit = {
    tool: 'knowledge',
    args: {
      action: 'submit',
      params: { title: 'Candidate', category: 'api', summary: 'Summary' },
    },
    result: { status: 'created', title: 'Candidate' },
  };
  const failedSubmit = {
    tool: 'knowledge',
    args: {
      action: 'submit',
      params: { category: 'api', summary: 'Missing title' },
    },
    result: { error: 'Missing required param: title' },
  };
  return {
    analysisText: 'short analysis',
    artifact: { analysisText: 'short analysis', referencedFiles: ['src/a.ts'], findings: ['one'] },
    runtimeToolCalls: [successfulSubmit, failedSubmit],
    combinedTokenUsage: { input: 3, output: 5 },
    efficiency: {
      toolCalls: 2,
      duplicateToolCalls: 1,
      cacheHits: 1,
      cacheMisses: 1,
      tokenUsage: { input: 3, output: 5, reasoning: 2, cacheHit: 1 },
      maxCompactionLevel: 1,
      totalCompactedItems: 4,
      nudgeCount: 1,
      replanCount: 0,
      emptyRetries: 1,
      forcedSummary: false,
    },
    analysisReport: {
      dimensionId: 'api',
      analysisText: 'short analysis',
      findings: ['one'],
      referencedFiles: ['src/a.ts'],
    },
    producerResult: {
      candidateCount: 1,
      rejectedCount: 0,
      toolCalls: [successfulSubmit, failedSubmit],
      reply: 'producer reply',
      tokenUsage: { input: 3, output: 5 },
      efficiency: {
        toolCalls: 2,
        duplicateToolCalls: 1,
        cacheHits: 1,
        cacheMisses: 1,
        tokenUsage: { input: 3, output: 5, reasoning: 2, cacheHit: 1 },
        maxCompactionLevel: 1,
        totalCompactedItems: 4,
        nudgeCount: 1,
        replanCount: 0,
        emptyRetries: 1,
        forcedSummary: false,
      },
    },
    submitCalls: [successfulSubmit, failedSubmit],
    successCount: 1,
    rejectedCount: 1,
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
      expect.objectContaining({
        type: 'skill',
        created: 1,
        efficiency: expect.objectContaining({ duplicateToolCalls: 1, cacheHits: 1 }),
        tokenUsage: { input: 3, output: 5 },
      })
    );
    expect(dimensionStats.api).toMatchObject({
      candidateCount: 1,
      analysisText: 'short analysis',
      efficiency: expect.objectContaining({
        tokenUsage: { input: 3, output: 5, reasoning: 2, cacheHit: 1 },
        emptyRetries: 1,
      }),
    });
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
    expect(dimensionStats.api).toEqual({
      status: 'error',
      candidateCount: 0,
      durationMs: 0,
      error: 'boom',
      diagnostics: null,
    });
    expect(emitDimensionComplete).toHaveBeenCalledWith('api', {
      type: 'error',
      status: 'error',
      reason: 'boom',
    });
    expect(result).toBe(dimensionStats.api);
  });

  test('records degraded evidence runs without marking the dimension normally complete', async () => {
    const candidateResults: CandidateResults = { created: 0, failed: 0, errors: [] };
    const dimensionCandidates: Record<string, DimensionCandidateData> = {};
    const dimensionStats: Record<string, DimensionStat> = {};
    const storeDimensionReport = vi.fn();
    const addDimensionDigest = vi.fn();
    const addSubmittedCandidate = vi.fn();
    const emitDimensionComplete = vi.fn();
    const projection = makeProjection();
    projection.producerResult.candidateCount = 1;
    projection.successCount = 1;
    const diagnostics = {
      degraded: true,
      fallbackUsed: false,
      warnings: [],
      timedOutStages: [],
      blockedTools: [],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures: [
        {
          stage: 'quality_gate_record_repair',
          action: 'degraded_no_findings',
          reason: 'note_finding records were not repaired',
        },
      ],
    };

    await consumeBootstrapDimensionResult({
      ctx: {},
      dimId: 'api',
      dimConfig: { label: 'API' },
      needsCandidates: true,
      projection,
      runResult: {
        status: 'success',
        reply: 'degraded_no_findings',
        degraded: true,
        diagnostics,
      },
      dimStartTime: Date.now(),
      analystScopeId: 'api:analyst',
      memoryCoordinator: {
        getActiveContext: () => ({
          distill: () => ({
            keyFindings: [{ finding: 'memory finding' }],
            totalObservations: 1,
            toolCallSummary: [],
          }),
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

    expect(candidateResults.created).toBe(0);
    expect(addSubmittedCandidate).not.toHaveBeenCalled();
    expect(storeDimensionReport).toHaveBeenCalledWith(
      'api',
      expect.objectContaining({
        findings: [{ finding: 'one' }],
        workingMemoryDistilled: expect.objectContaining({
          keyFindings: [{ finding: 'memory finding' }],
        }),
      })
    );
    expect(emitDimensionComplete).toHaveBeenCalledWith(
      'api',
      expect.objectContaining({
        status: 'degraded_no_findings',
        created: 0,
        reason: 'note_finding records were not repaired',
      })
    );
    expect(dimensionStats.api).toMatchObject({
      status: 'degraded_no_findings',
      candidateCount: 0,
      rejectedCount: 2,
      error: 'note_finding records were not repaired',
      diagnostics: expect.objectContaining({ degraded: true }),
    });
  });

  test('preserves submitted candidates when only the producer summary times out', async () => {
    const candidateResults: CandidateResults = { created: 0, failed: 0, errors: [] };
    const dimensionCandidates: Record<string, DimensionCandidateData> = {};
    const dimensionStats: Record<string, DimensionStat> = {};
    const storeDimensionReport = vi.fn();
    const addDimensionDigest = vi.fn();
    const addSubmittedCandidate = vi.fn();
    const emitDimensionComplete = vi.fn();
    const projection = makeProjection();
    projection.produceResult = {
      reply: '[run stopped: stage_timeout]',
      toolCalls: projection.runtimeToolCalls,
    };

    await consumeBootstrapDimensionResult({
      ctx: {},
      dimId: 'api',
      dimConfig: { label: 'API' },
      needsCandidates: true,
      projection,
      runResult: {
        status: 'success',
        reply: '[run stopped: stage_timeout]',
        degraded: false,
        diagnostics: {
          degraded: false,
          fallbackUsed: false,
          warnings: [],
          timedOutStages: ['produce'],
          blockedTools: [],
          truncatedToolCalls: 0,
          emptyResponses: 0,
          aiErrorCount: 0,
          gateFailures: [],
        },
      },
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
    expect(addSubmittedCandidate).toHaveBeenCalledWith(
      'api',
      expect.objectContaining({ title: 'Candidate' })
    );
    expect(emitDimensionComplete).toHaveBeenCalledWith(
      'api',
      expect.objectContaining({
        status: 'v3-pipeline-complete',
        created: 1,
      })
    );
    expect(dimensionStats.api).toMatchObject({
      status: 'v3-pipeline-complete',
      candidateCount: 1,
      recoveredProducerTimeout: true,
      error: undefined,
    });
  });
});

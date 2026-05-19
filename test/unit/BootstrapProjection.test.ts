import type { AgentRunResult } from '@alembic/agent/service';
import { describe, expect, test } from 'vitest';
import {
  normalizeDimensionFindings,
  projectAgentRunResult,
  projectBootstrapDimensionAgentOutput,
  projectBootstrapSessionResult,
} from '#workflows/capabilities/execution/internal-agent/BootstrapProjections.js';

function makeRunResult(partial: Partial<AgentRunResult>): AgentRunResult {
  return {
    runId: 'run-1',
    profileId: 'bootstrap-dimension',
    reply: '',
    status: 'success',
    phases: {},
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0, iterations: 0, durationMs: 0 },
    diagnostics: null,
    ...partial,
  };
}

describe('bootstrap projections', () => {
  test('projects dimension agent output into analysis and producer summaries', () => {
    const projection = projectBootstrapDimensionAgentOutput({
      dimId: 'overview',
      needsCandidates: true,
      runResult: {
        reply: 'fallback analysis',
        tokenUsage: { input: 10, output: 20 },
        efficiency: {
          toolCalls: 4,
          duplicateToolCalls: 1,
          cacheHits: 2,
          cacheMisses: 3,
          tokenUsage: { input: 10, output: 20, reasoning: 4, cacheHit: 6 },
          maxCompactionLevel: 2,
          totalCompactedItems: 7,
          nudgeCount: 1,
          replanCount: 1,
          emptyRetries: 0,
          forcedSummary: false,
        },
        phases: {
          analyze: { reply: 'analysis text' },
          quality_gate: {
            artifact: {
              analysisText: 'artifact analysis',
              referencedFiles: [],
              findings: ['important finding'],
              metadata: { artifactVersion: 2 },
            },
          },
          produce: { reply: 'producer reply' },
        },
        toolCalls: [
          {
            tool: 'code',
            args: { action: 'read_file', filePath: 'src/a.ts' },
          },
          {
            tool: 'knowledge',
            args: { action: 'search', params: { query: 'overview' } },
            result: { status: 'ok' },
          },
          {
            tool: 'knowledge',
            args: { action: 'submit', params: { title: 'Accepted candidate' } },
            result: { status: 'accepted' },
          },
          {
            tool: 'knowledge',
            args: { action: 'submit', params: { title: 'Rejected candidate' } },
            result: { status: 'rejected' },
          },
        ],
      },
    });

    expect(projection.analysisReport).toMatchObject({
      dimensionId: 'overview',
      analysisText: 'artifact analysis',
      findings: ['important finding'],
      referencedFiles: ['src/a.ts'],
      metadata: {
        toolCallCount: 4,
        tokenUsage: { input: 10, output: 20 },
        efficiency: expect.objectContaining({
          duplicateToolCalls: 1,
          cacheHits: 2,
          maxCompactionLevel: 2,
        }),
        artifactVersion: 2,
      },
    });
    expect(projection.producerResult).toMatchObject({
      candidateCount: 1,
      rejectedCount: 1,
      reply: 'producer reply',
      tokenUsage: { input: 10, output: 20 },
      efficiency: expect.objectContaining({
        tokenUsage: { input: 10, output: 20, reasoning: 4, cacheHit: 6 },
        nudgeCount: 1,
      }),
    });
  });

  test('projects Agent diagnostics efficiency into dimension projection', () => {
    const projected = projectAgentRunResult(
      makeRunResult({
        diagnostics: {
          degraded: false,
          fallbackUsed: false,
          warnings: [],
          timedOutStages: [],
          blockedTools: [],
          truncatedToolCalls: 0,
          emptyResponses: 0,
          aiErrorCount: 0,
          gateFailures: [],
          efficiency: {
            toolCalls: 3,
            duplicateToolCalls: 1,
            cacheHits: 1,
            cacheMisses: 2,
            tokenUsage: { input: 11, output: 13, reasoning: 5, cacheHit: 7 },
            maxCompactionLevel: 1,
            totalCompactedItems: 9,
            nudgeCount: 2,
            replanCount: 1,
            emptyRetries: 1,
            forcedSummary: true,
            cancelReason: 'user cancelled',
          },
        },
      })
    );

    expect(projected.efficiency).toMatchObject({
      toolCalls: 3,
      duplicateToolCalls: 1,
      cacheHits: 1,
      cacheMisses: 2,
      tokenUsage: { input: 11, output: 13, reasoning: 5, cacheHit: 7 },
      maxCompactionLevel: 1,
      totalCompactedItems: 9,
      nudgeCount: 2,
      replanCount: 1,
      emptyRetries: 1,
      forcedSummary: true,
      cancelReason: 'user cancelled',
    });
  });

  test('normalizes string and structured dimension findings', () => {
    expect(normalizeDimensionFindings(['  one  ', '', { finding: 'two', importance: 7 }])).toEqual([
      { finding: 'one' },
      { finding: 'two', importance: 7 },
    ]);
  });

  test('projects bootstrap session parent result coverage', () => {
    const projection = projectBootstrapSessionResult({
      parentRunResult: makeRunResult({
        profileId: 'bootstrap-session',
        status: 'aborted',
        phases: {
          dimensionResults: {
            overview: makeRunResult({ runId: 'overview:run', status: 'success' }),
            api: makeRunResult({ runId: 'api:run', status: 'error' }),
            ui: makeRunResult({ runId: 'ui:run', status: 'aborted' }),
            security: makeRunResult({ runId: 'security:run', status: 'timeout' }),
          },
        },
      }),
      activeDimIds: ['overview', 'api', 'ui', 'security', 'data', 'restored'],
      skippedDimIds: ['restored'],
    });

    expect(projection.completedDimensions).toBe(4);
    expect(projection.failedDimensionIds.sort()).toEqual(['api', 'security']);
    expect(projection.abortedDimensionIds).toEqual(['ui']);
    expect(projection.missingDimensionIds).toEqual(['data']);
    expect(projection.parentStatus).toBe('aborted');
  });
});

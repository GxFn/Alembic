import { describe, expect, test } from 'vitest';
import {
  normalizeDimensionFindings,
  projectBootstrapDimensionAgentOutput,
} from '#workflows/bootstrap/projections/BootstrapDimensionProjection.js';
import { projectBootstrapSessionResult } from '#workflows/bootstrap/projections/BootstrapSessionProjection.js';
import type { AgentRunResult } from '../../lib/agent/service/index.js';

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
            tool: 'read_file',
            args: { filePath: 'src/a.ts' },
          },
          {
            tool: 'submit_knowledge',
            result: { status: 'accepted' },
          },
          {
            tool: 'submit_with_check',
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
        toolCallCount: 3,
        tokenUsage: { input: 10, output: 20 },
        artifactVersion: 2,
      },
    });
    expect(projection.producerResult).toMatchObject({
      candidateCount: 1,
      rejectedCount: 1,
      reply: 'producer reply',
      tokenUsage: { input: 10, output: 20 },
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

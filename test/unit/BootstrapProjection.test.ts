import type { AgentRunResult } from '@alembic/agent/service';
import { describe, expect, test } from 'vitest';
import {
  isRecoverableProducerTimeoutIssue,
  normalizeDimensionFindings,
  projectAgentRunResult,
  projectBootstrapDimensionAgentOutput,
  projectBootstrapSessionResult,
  resolveBootstrapDimensionRunIssue,
} from '../../lib/workflows/capabilities/execution/internal-agent/BootstrapProjections.js';

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
          produce: {
            reply: 'producer reply',
            toolCalls: [
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
            args: { action: 'submit', params: { title: 'Analyzer should not count' } },
            result: { status: 'accepted' },
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
      toolCalls: [
        expect.objectContaining({
          args: { action: 'submit', params: { title: 'Accepted candidate' } },
        }),
        expect.objectContaining({
          args: { action: 'submit', params: { title: 'Rejected candidate' } },
        }),
      ],
    });
    expect(projection.submitCalls).toHaveLength(2);
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

  test('recovers only producer timeout after a successful candidate submit', () => {
    const issue = resolveBootstrapDimensionRunIssue(
      makeRunResult({
        status: 'success',
        reply: '[run stopped: stage_timeout]',
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
      })
    );

    expect(
      isRecoverableProducerTimeoutIssue({
        issue,
        needsCandidates: true,
        produceResult: { reply: '[run stopped: stage_timeout]' },
        successCount: 1,
      })
    ).toBe(true);
    expect(
      isRecoverableProducerTimeoutIssue({
        issue: {
          status: 'timeout',
          reason: 'analysis timed out',
          diagnostics: {
            degraded: false,
            fallbackUsed: false,
            warnings: [],
            timedOutStages: ['analyze'],
            blockedTools: [],
            truncatedToolCalls: 0,
            emptyResponses: 0,
            aiErrorCount: 0,
            gateFailures: [],
          },
        },
        needsCandidates: true,
        produceResult: { reply: '[run stopped: stage_timeout]' },
        successCount: 1,
      })
    ).toBe(false);
  });

  test('classifies retry budget exhaustion as a failed dimension issue', () => {
    expect(
      resolveBootstrapDimensionRunIssue(
        makeRunResult({
          status: 'success',
          diagnostics: {
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
                stage: 'quality_gate',
                action: 'degraded_budget_exhausted',
                reason: 'Analysis retry suppressed because session input budget is exhausted.',
              },
            ],
          },
        })
      )
    ).toMatchObject({
      status: 'degraded_budget_exhausted',
      reason: 'Analysis retry suppressed because session input budget is exhausted.',
    });
  });

  test('classifies unresolved quality gate without producer as a failed dimension issue', () => {
    expect(
      resolveBootstrapDimensionRunIssue(
        makeRunResult({
          status: 'success',
          phases: {
            analyze: {
              reply:
                'Coding standards analysis returned natural language but did not record findings.',
            },
            quality_gate: {
              pass: false,
              action: 'analysis_retry',
              reason: 'Required note_finding calls are missing',
            },
          },
        })
      )
    ).toMatchObject({
      status: 'quality_gate_failed',
      reason: 'Required note_finding calls are missing',
    });
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
            evidence: makeRunResult({
              runId: 'evidence:run',
              status: 'success',
              reply: 'l4_compaction_failed_budget_exhausted',
              diagnostics: {
                degraded: true,
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
                  duplicateToolCalls: 0,
                  cacheHits: 0,
                  cacheMisses: 0,
                  tokenUsage: { input: 10, output: 2, reasoning: 0, cacheHit: 0 },
                  maxCompactionLevel: 4,
                  totalCompactedItems: 0,
                  nudgeCount: 0,
                  replanCount: 0,
                  emptyRetries: 0,
                  forcedSummary: false,
                  cancelReason: 'l4_compaction_failed_budget_exhausted',
                },
              },
            }),
            budget: makeRunResult({
              runId: 'budget:run',
              status: 'success',
              diagnostics: {
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
                    stage: 'quality_gate',
                    action: 'degraded_budget_exhausted',
                    reason: 'Analysis retry suppressed because session input budget is exhausted.',
                  },
                ],
              },
            }),
            gate: makeRunResult({
              runId: 'gate:run',
              status: 'success',
              phases: {
                quality_gate: {
                  pass: false,
                  action: 'analysis_retry',
                  reason: 'Required note_finding calls are missing',
                },
              },
            }),
            producer: makeRunResult({
              runId: 'producer:run',
              status: 'success',
              reply: '[run stopped: stage_timeout]',
              phases: {
                quality_gate: {
                  artifact: {
                    analysisText: 'analysis with enough evidence',
                    referencedFiles: ['src/a.ts'],
                    findings: ['finding'],
                  },
                },
                produce: { reply: '[run stopped: stage_timeout]' },
              },
              toolCalls: [
                {
                  tool: 'knowledge',
                  args: {
                    action: 'submit',
                    params: { title: 'Accepted candidate' },
                  },
                  result: { status: 'created' },
                },
              ],
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
            }),
          },
        },
      }),
      activeDimIds: [
        'overview',
        'api',
        'ui',
        'security',
        'evidence',
        'budget',
        'gate',
        'producer',
        'data',
        'restored',
      ],
      skippedDimIds: ['restored'],
    });

    expect(projection.completedDimensions).toBe(8);
    expect(projection.failedDimensionIds.sort()).toEqual([
      'api',
      'budget',
      'evidence',
      'gate',
      'security',
    ]);
    expect(projection.abortedDimensionIds).toEqual(['ui']);
    expect(projection.missingDimensionIds).toEqual(['data']);
    expect(projection.parentStatus).toBe('aborted');
  });
});

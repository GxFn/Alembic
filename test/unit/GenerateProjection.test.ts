import {
  projectToolResultOrdinaryOutput,
  type ToolResultEnvelope,
  type ToolResultStatus,
} from '@alembic/agent';
import {
  type AgentInterfaceContractBranch,
  type AgentInterfaceContractBranchFixture,
  ALEMBIC_AGENT_INTERFACE_CONTRACT,
  validateAgentInterfaceContract,
} from '@alembic/agent/runtime';
import type { AgentRunResult } from '@alembic/agent/service';
import { describe, expect, test } from 'vitest';
import {
  type GenerateDimensionRunIssueStatus,
  isRecoverableProducerTimeoutIssue,
  normalizeDimensionFindings,
  projectAgentRunResult,
  projectGenerateDimensionAgentOutput,
  projectGenerateSessionResult,
  resolveGenerateDimensionRunIssue,
} from '../../lib/recipe-pipeline/generate/execution/AgentRunProjections.js';

function makeRunResult(partial: Partial<AgentRunResult>): AgentRunResult {
  return {
    runId: 'run-1',
    profileId: 'generate-dimension',
    reply: '',
    status: 'success',
    phases: {},
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0, iterations: 0, durationMs: 0 },
    diagnostics: null,
    ...partial,
  };
}

type D24ReplayFailureOwner =
  | 'none'
  | 'agent-fixture-producer'
  | 'alembic-consumer'
  | 'contract-registry';

type D24ReplayExpectation = {
  agentRunStatus: AgentRunResult['status'];
  issueStatus: GenerateDimensionRunIssueStatus | null;
  toolEnvelopeReplay: boolean;
};

type D24ReplayResult = {
  branch: AgentInterfaceContractBranch;
  failureOwner: D24ReplayFailureOwner;
  issueStatus: GenerateDimensionRunIssueStatus | null;
  reason: string;
  toolStatus: ToolResultStatus | null;
};

const D24_BRANCH_EXPECTATIONS = {
  success: { agentRunStatus: 'success', issueStatus: null, toolEnvelopeReplay: true },
  failure: { agentRunStatus: 'error', issueStatus: 'error', toolEnvelopeReplay: true },
  cancellation: { agentRunStatus: 'aborted', issueStatus: 'aborted', toolEnvelopeReplay: true },
  timeout: { agentRunStatus: 'timeout', issueStatus: 'timeout', toolEnvelopeReplay: true },
  'permission-denial': {
    agentRunStatus: 'blocked',
    issueStatus: 'blocked',
    toolEnvelopeReplay: true,
  },
  'needs-confirmation': {
    agentRunStatus: 'blocked',
    issueStatus: 'blocked',
    toolEnvelopeReplay: true,
  },
  'partial-result': {
    agentRunStatus: 'success',
    issueStatus: null,
    toolEnvelopeReplay: true,
  },
  'provider-error': { agentRunStatus: 'error', issueStatus: 'error', toolEnvelopeReplay: true },
  'host-failure': { agentRunStatus: 'error', issueStatus: 'error', toolEnvelopeReplay: true },
  'host-adapter': { agentRunStatus: 'error', issueStatus: 'error', toolEnvelopeReplay: false },
} satisfies Record<AgentInterfaceContractBranch, D24ReplayExpectation>;

function replayAgentBranchFixture(
  fixture: AgentInterfaceContractBranchFixture,
  options: {
    expectation?: D24ReplayExpectation;
    registryFailures?: string[];
  } = {}
): D24ReplayResult {
  const registryFailures = options.registryFailures ?? validateAgentInterfaceContract();
  if (registryFailures.length > 0) {
    return {
      branch: fixture.branch,
      failureOwner: 'contract-registry',
      issueStatus: null,
      reason: registryFailures.join('; '),
      toolStatus: fixture.toolStatus,
    };
  }

  const publicFixtureFields = new Set([
    ...fixture.providerPublicFields,
    ...fixture.observabilityKeys,
  ]);
  const forbiddenPublicFields =
    ALEMBIC_AGENT_INTERFACE_CONTRACT.forbiddenOrdinaryOutputFields.filter((field) =>
      publicFixtureFields.has(field)
    );
  const hiddenPublicFields = fixture.hiddenProviderFields.filter((field) =>
    publicFixtureFields.has(field)
  );
  if (forbiddenPublicFields.length > 0 || hiddenPublicFields.length > 0) {
    return {
      branch: fixture.branch,
      failureOwner: 'agent-fixture-producer',
      issueStatus: null,
      reason: [...forbiddenPublicFields, ...hiddenPublicFields].join(', '),
      toolStatus: fixture.toolStatus,
    };
  }

  const expectation = options.expectation ?? D24_BRANCH_EXPECTATIONS[fixture.branch];
  const runResult = makeRunResult({
    diagnostics: diagnosticsForBranch(fixture),
    profileId: 'd24-agent-branch-replay',
    reply: `agent-branch:${fixture.branch}:${fixture.errorKind}`,
    runId: `d24:${fixture.branch}`,
    status: expectation.agentRunStatus,
    toolCalls: fixture.toolStatus ? [toolCallForBranch(fixture, fixture.toolStatus)] : [],
  });
  const projectedRun = projectAgentRunResult(runResult);
  const issue = resolveGenerateDimensionRunIssue(projectedRun);
  const issueStatus = issue?.status ?? null;
  const dimensionProjection = projectGenerateDimensionAgentOutput({
    dimId: `d24-${fixture.branch}`,
    needsCandidates: false,
    runResult: projectedRun,
  });
  const ordinaryToolResults = (projectedRun.toolCalls || []).map((toolCall) => ({
    result: toolCall.result,
    tool: toolCall.tool || toolCall.name,
  }));
  const projectedKeys = collectObjectKeys({
    analysisReport: dimensionProjection.analysisReport,
    issue: issue ? { reason: issue.reason, status: issue.status } : null,
    producerResult: {
      ...dimensionProjection.producerResult,
      toolCalls: ordinaryToolResults,
    },
    toolCalls: ordinaryToolResults,
  });
  const leakedForbiddenFields =
    ALEMBIC_AGENT_INTERFACE_CONTRACT.forbiddenOrdinaryOutputFields.filter((field) =>
      projectedKeys.has(field)
    );

  if (
    issueStatus !== expectation.issueStatus ||
    leakedForbiddenFields.length > 0 ||
    (expectation.toolEnvelopeReplay && projectedRun.toolCalls?.length === 0)
  ) {
    return {
      branch: fixture.branch,
      failureOwner: 'alembic-consumer',
      issueStatus,
      reason:
        leakedForbiddenFields.length > 0
          ? `forbidden fields leaked: ${leakedForbiddenFields.join(', ')}`
          : `expected issue ${expectation.issueStatus ?? 'none'}, got ${issueStatus ?? 'none'}`,
      toolStatus: fixture.toolStatus,
    };
  }

  return {
    branch: fixture.branch,
    failureOwner: 'none',
    issueStatus,
    reason: issue?.reason ?? 'ok',
    toolStatus: fixture.toolStatus,
  };
}

function toolCallForBranch(
  fixture: AgentInterfaceContractBranchFixture,
  status: ToolResultStatus
): AgentRunResult['toolCalls'][number] {
  const envelope = toolEnvelopeForBranch(fixture, status);
  const ordinaryOutput = projectToolResultOrdinaryOutput(envelope, {
    forbiddenFields: ALEMBIC_AGENT_INTERFACE_CONTRACT.forbiddenOrdinaryOutputFields,
  });
  return {
    args: { branch: fixture.branch, registryRows: [...fixture.registryRows] },
    durationMs: envelope.durationMs,
    envelope,
    result: ordinaryOutput,
    tool: `agent-branch.${fixture.branch}`,
  };
}

function toolEnvelopeForBranch(
  fixture: AgentInterfaceContractBranchFixture,
  status: ToolResultStatus
): ToolResultEnvelope<Record<string, unknown>> {
  return {
    callId: `call-${fixture.branch}`,
    diagnostics: diagnosticsForBranch(fixture),
    durationMs: 17,
    ok: fixture.ok,
    startedAt: '2026-06-10T00:00:00.000Z',
    status,
    structuredContent: ordinaryContentForBranch(fixture),
    text: fixture.title,
    toolId: `agent-branch.${fixture.branch}`,
    trust: {
      containsSecrets: false,
      containsUntrustedText: false,
      sanitized: true,
      source: 'internal',
    },
  };
}

function ordinaryContentForBranch(
  fixture: AgentInterfaceContractBranchFixture
): Record<string, unknown> {
  const publicFields = Object.fromEntries(
    fixture.providerPublicFields.map((field) => [field, `${fixture.branch}:${field}`])
  );
  const observability = Object.fromEntries(
    fixture.observabilityKeys.map((field) => [field, `${fixture.branch}:${field}`])
  );
  return {
    branch: fixture.branch,
    consumerScenario: `agent-branch:${fixture.branch}`,
    data: { result: 'legacy nested result must be redacted' },
    errorCode: 'legacy-error-code',
    hiddenReasoning: 'provider-private reasoning',
    hostCredential: 'host-private-credential',
    legacyCompatibility: true,
    message: 'legacy message field',
    observability,
    publicFields,
    rawProviderRequest: { prompt: 'private request' },
    rawProviderResponse: { body: 'private response' },
    reasoning_content: 'provider-native reasoning',
    reasoningContent: 'provider reasoning',
    success: fixture.ok,
    threadId: 'thread-private',
    thoughtSignature: 'provider-private-signature',
  };
}

function diagnosticsForBranch(
  fixture: AgentInterfaceContractBranchFixture
): NonNullable<AgentRunResult['diagnostics']> {
  return {
    aiErrorCount: fixture.errorKind === 'internal-provider-error' ? 1 : 0,
    blockedTools:
      fixture.toolStatus === 'blocked' || fixture.toolStatus === 'needs-confirmation'
        ? [{ reason: fixture.errorKind, tool: `agent-branch.${fixture.branch}` }]
        : [],
    degraded: fixture.branch === 'partial-result',
    emptyResponses: 0,
    fallbackUsed: fixture.branch === 'host-adapter',
    gateFailures:
      fixture.branch === 'needs-confirmation' || fixture.branch === 'host-adapter'
        ? [
            {
              action: fixture.branch,
              reason: fixture.errorKind,
              stage: fixture.hostAdapterPath ?? fixture.boundaryArea,
            },
          ]
        : [],
    timedOutStages: fixture.errorKind === 'timeout' ? ['produce'] : [],
    truncatedToolCalls: 0,
    warnings: [{ code: `d24-${fixture.branch}`, message: fixture.title, stage: 'd24-replay' }],
  };
}

function collectObjectKeys(value: unknown): Set<string> {
  const keys = new Set<string>();
  const visit = (node: unknown, path: string[]) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, path);
      }
      return;
    }
    if (!node || typeof node !== 'object') {
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      const childPath = [...path, key];
      keys.add(key);
      keys.add(childPath.join('.'));
      visit(child, childPath);
    }
  };
  visit(value, []);
  return keys;
}

describe('bootstrap projections', () => {
  test('replays AlembicAgent D23 branch fixtures through Alembic AgentRun consumers', () => {
    const replayResults = ALEMBIC_AGENT_INTERFACE_CONTRACT.branches.map((fixture) =>
      replayAgentBranchFixture(fixture)
    );

    expect(replayResults.map((result) => result.branch)).toEqual(
      ALEMBIC_AGENT_INTERFACE_CONTRACT.branches.map((fixture) => fixture.branch)
    );
    expect(replayResults.map((result) => [result.branch, result.issueStatus])).toEqual([
      ['success', null],
      ['failure', 'error'],
      ['cancellation', 'aborted'],
      ['timeout', 'timeout'],
      ['permission-denial', 'blocked'],
      ['needs-confirmation', 'blocked'],
      ['partial-result', null],
      ['provider-error', 'error'],
      ['host-failure', 'error'],
      ['host-adapter', 'error'],
    ]);
    expect(replayResults.filter((result) => result.failureOwner !== 'none')).toEqual([]);

    const partial = replayResults.find((result) => result.branch === 'partial-result');
    const confirmation = replayResults.find((result) => result.branch === 'needs-confirmation');
    const hostAdapter = replayResults.find((result) => result.branch === 'host-adapter');
    expect(partial).toMatchObject({ issueStatus: null, toolStatus: 'partial' });
    expect(confirmation).toMatchObject({
      issueStatus: 'blocked',
      toolStatus: 'needs-confirmation',
    });
    expect(hostAdapter).toMatchObject({ issueStatus: 'error', toolStatus: null });
  });

  test('classifies D24 replay failures by producer, consumer, or registry owner', () => {
    const successFixture = ALEMBIC_AGENT_INTERFACE_CONTRACT.branches.find(
      (fixture) => fixture.branch === 'success'
    );
    expect(successFixture).toBeDefined();
    if (!successFixture) {
      return;
    }

    expect(
      replayAgentBranchFixture({
        ...successFixture,
        providerPublicFields: [...successFixture.providerPublicFields, 'rawProviderResponse'],
      }).failureOwner
    ).toBe('agent-fixture-producer');
    expect(
      replayAgentBranchFixture(successFixture, {
        registryFailures: ['missing required branch: timeout'],
      }).failureOwner
    ).toBe('contract-registry');
    expect(
      replayAgentBranchFixture(successFixture, {
        expectation: {
          ...D24_BRANCH_EXPECTATIONS.success,
          issueStatus: 'error',
        },
      }).failureOwner
    ).toBe('alembic-consumer');
  });

  test('projects dimension agent output into analysis and producer summaries', () => {
    const projection = projectGenerateDimensionAgentOutput({
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
    const issue = resolveGenerateDimensionRunIssue(
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
      resolveGenerateDimensionRunIssue(
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
      resolveGenerateDimensionRunIssue(
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
    const projection = projectGenerateSessionResult({
      parentRunResult: makeRunResult({
        profileId: 'generate-session',
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

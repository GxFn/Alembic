import {
  createAlembicProjectSkillDeliveryReceipt,
  type WorkflowReport,
} from '@alembic/core/host-agent-workflows';
import { describe, expect, test } from 'vitest';
import {
  augmentInternalDimensionWorkflowReport,
  augmentWorkflowReportWithEfficiency,
  augmentWorkflowReportWithPcvNodeLocalBaseline,
  augmentWorkflowReportWithSkillDeliveryReceipts,
  buildInternalDimensionFinalizerStepMap,
  buildInternalDimensionPersistenceInput,
  cleanupInternalDimensionRuntimeCaches,
  clearInternalDimensionSessionDedupCache,
  createInternalDimensionAbortGuard,
  runInternalDimensionCompletionStep,
} from '../../lib/workflows/capabilities/execution/internal-agent/InternalDimensionFillFinalizer.js';
import type { InternalDimensionFillPreparation } from '../../lib/workflows/capabilities/execution/internal-agent/InternalDimensionFillPreparation.js';
import type { InternalDimensionFillSessionResult } from '../../lib/workflows/capabilities/execution/internal-agent/InternalDimensionFillSessionRunner.js';

describe('internal dimension fill finalizer efficiency report augmentation', () => {
  test('exposes explicit finalizer step map for side-effect attribution', () => {
    expect(buildInternalDimensionFinalizerStepMap()).toEqual({
      cacheWarmupCleanup: 'clearInternalDimensionSessionDedupCache',
      skillConsumption: 'consumeInternalDimensionSkillsStep',
      candidateRelations: 'consumeInternalDimensionCandidateRelationsStep',
      completion: 'runInternalDimensionCompletionStep',
      persistence: 'buildInternalDimensionPersistenceInput',
      reportAugmentation: 'augmentInternalDimensionWorkflowReport',
      historyRewrite: 'persistEfficiencyAugmentedWorkflowReport',
      runtimeCacheCleanup: 'cleanupInternalDimensionRuntimeCaches',
    });
  });

  test('builds persistence input as an isolated finalizer step', () => {
    const preparation = makePreparation();
    const runtime = makeRuntime();
    const sessionResult = makeSessionResult();
    const skillResults = { created: 1, failed: 0, skills: ['project-api'], errors: [] };
    const completionSummary = {
      mode: 'rescan' as const,
      isolation: 'pipeline-isolation' as const,
      reason: 'rescan skips delivery/wiki/semantic memory to avoid rebuilding downstream artifacts',
      delivery: { status: 'skipped' as const, verification: null },
      wiki: { status: 'skipped' as const },
      semanticMemory: { status: 'skipped' as const, result: null },
    };

    const input = buildInternalDimensionPersistenceInput({
      completionSummary,
      consolidationResult: null,
      preparation,
      runtime,
      sessionResult,
      skillResults,
      startedAtMs: 123,
    }) as Record<string, unknown>;

    expect(input).toMatchObject({
      dataRoot: '/tmp/alembic-data',
      projectRoot: '/tmp/alembic-project',
      sessionId: 'session-1',
      completionSummary,
      enableParallel: true,
      concurrency: 2,
      startedAtMs: 123,
    });
    expect(input.skillResults).toBe(skillResults);
    expect(input.dimensionStats).toBe(sessionResult.dimensionStats);
    expect(input.sessionStore).toBe(runtime.sessionStore);
  });

  test('summarizes rescan completion without opening delivery or memory surfaces', async () => {
    const result = await runInternalDimensionCompletionStep({
      preparation: makePreparation({ mode: 'rescan' }),
      runtime: makeRuntime(),
      shouldAbort: () => false,
    });

    expect(result.consolidationResult).toBeNull();
    expect(result.workflowCompletion).toEqual({
      deliveryVerification: null,
      semanticMemoryResult: null,
    });
    expect(result.completionSummary).toMatchObject({
      mode: 'rescan',
      isolation: 'pipeline-isolation',
      delivery: { status: 'skipped' },
      wiki: { status: 'skipped' },
      semanticMemory: { status: 'skipped' },
    });
  });

  test('isolates finalizer cache cleanup decisions', () => {
    const sessionResult = makeSessionResult();
    sessionResult.bootstrapDedup.add('api');
    expect(sessionResult.bootstrapDedup.size).toBe(1);

    expect(clearInternalDimensionSessionDedupCache(sessionResult)).toEqual({
      bootstrapDedupCleared: true,
    });
    expect(sessionResult.bootstrapDedup.size).toBe(0);

    const preparation = makePreparation();
    preparation.ctx.container.singletons._fileCache = { stale: true };
    expect(cleanupInternalDimensionRuntimeCaches(preparation)).toEqual({ fileCacheCleared: true });
    expect(preparation.ctx.container.singletons._fileCache).toBeNull();
  });

  test('keeps abort checks local to the finalizer steps', () => {
    const taskManager = {
      isSessionValid: () => false,
      isUserCancelled: () => false,
    };
    const shouldAbort = createInternalDimensionAbortGuard(makePreparation({ taskManager }));

    expect(shouldAbort()).toBe(true);
  });

  test('reports which workflow report augmentation branches changed', () => {
    const report = {
      version: '2.7.0',
      timestamp: '2026-05-30T00:00:00.000Z',
      project: { name: 'Alembic', files: 1, lang: 'ts' },
      duration: { totalMs: 100, totalSec: 0 },
      dimensions: { api: {} },
      totals: {},
      checkpoints: { restored: [] },
      incremental: null,
      semanticMemory: null,
      session: { id: 'session-1' },
    } as WorkflowReport;
    const receipt = createAlembicProjectSkillDeliveryReceipt({
      asset: {
        contentHash: 'sha256:abc123',
        dimensionId: 'api',
        path: '/tmp/project/Alembic/skills/project-api/SKILL.md',
      },
      authorization: {
        codexSkillRoot: '/tmp/project/.agents/skills',
        projectScopeId: 'project:test',
        status: 'pending',
      },
      codexSkillRoot: '/tmp/project/.agents/skills',
      createdAt: '2026-05-24T12:00:00Z',
      dimensionId: 'api',
      id: 'receipt-api',
      managedMarker: {
        generatedSkillId: 'alembic:project:test:project-api',
        markerPath: '/tmp/project/.agents/skills/project-api/.alembic-managed.json',
      },
      projectId: 'test',
      projectRoot: '/tmp/project',
      projectScopeId: 'project:test',
      runtimeExport: {
        codexSkillRoot: '/tmp/project/.agents/skills',
        projectScopeId: 'project:test',
        status: 'pending',
      },
      skillName: 'project-api',
    });

    const result = augmentInternalDimensionWorkflowReport({
      report,
      skillResults: {
        created: 1,
        failed: 0,
        skills: ['project-api'],
        errors: [],
        deliveryReceipts: [receipt],
      },
      dimensionStats: {
        api: {
          candidateCount: 0,
          durationMs: 10,
          efficiency: {
            cacheHits: 1,
            cacheMisses: 0,
            duplicateToolCalls: 0,
            emptyRetries: 0,
            forcedSummary: false,
            maxCompactionLevel: 0,
            nudgeCount: 0,
            replanCount: 0,
            tokenUsage: { cacheHit: 0, input: 1, output: 2, reasoning: 0 },
            toolCalls: 1,
            totalCompactedItems: 0,
          },
          pcvNodeEvidenceEnvelope: {
            contract: 'PcvNodeEvidenceEnvelope',
            contractVersion: 1,
            dimensionId: 'api',
            evidenceScope: 'unit',
            source: 'bootstrap-dimension-consumer',
            evidence: {
              n12: {
                acceptedCandidateTitles: [],
                chainNodeId: 'pcvm:cold-start:n12',
                contract: 'PCVColdStartNodeLocalBaseline',
                contractVersion: 1,
                dimensionId: 'api',
                evidenceKind: 'consumer-persistence',
                failureDetailsPersisted: true,
                findableCandidateTitles: [],
                missingLinkReasons: [],
                nodeId: 'N12-consumers-persistence',
                persistedFailureReason: null,
                sessionStoreSnapshotAvailable: true,
                sourceRefs: [],
                status: 'linked',
                summary: 'n12 linked',
              },
            },
          },
        },
      },
    });

    expect(result).toEqual({
      changed: true,
      efficiency: true,
      historyRewrite: false,
      pcvNodeLocal: true,
      skillDelivery: true,
      warningOnly: false,
    });
    expect(report).toMatchObject({
      efficiency: { toolCalls: 1 },
      projectSkillDelivery: { receiptCount: 1 },
      pcvScorecard: { summary: { dimensionCount: 1, linkedNodes: 1 } },
    });
  });

  test('writes aggregate and per-dimension efficiency into workflow reports', () => {
    const report = {
      version: '2.7.0',
      timestamp: '2026-05-20T00:00:00.000Z',
      project: { name: 'Alembic', files: 1, lang: 'ts' },
      duration: { totalMs: 100, totalSec: 0 },
      dimensions: { api: { toolCallCount: 3 }, ui: { toolCallCount: 2 } },
      totals: { toolCalls: 5 },
      checkpoints: { restored: [] },
      incremental: null,
      semanticMemory: null,
      session: { id: 'session-1' },
    } as WorkflowReport;

    const changed = augmentWorkflowReportWithEfficiency(report, {
      api: {
        candidateCount: 1,
        durationMs: 10,
        efficiency: {
          toolCalls: 3,
          duplicateToolCalls: 1,
          cacheHits: 2,
          cacheMisses: 1,
          tokenUsage: { input: 10, output: 4, reasoning: 2, cacheHit: 3 },
          maxCompactionLevel: 1,
          totalCompactedItems: 2,
          nudgeCount: 1,
          replanCount: 0,
          emptyRetries: 1,
          forcedSummary: false,
        },
      },
      ui: {
        candidateCount: 0,
        durationMs: 10,
        efficiency: {
          toolCalls: 2,
          duplicateToolCalls: 0,
          cacheHits: 1,
          cacheMisses: 1,
          tokenUsage: { input: 8, output: 3, reasoning: 1, cacheHit: 2 },
          maxCompactionLevel: 2,
          totalCompactedItems: 3,
          nudgeCount: 0,
          replanCount: 1,
          emptyRetries: 0,
          forcedSummary: true,
        },
      },
    });

    expect(changed).toBe(true);
    expect(report.efficiency).toMatchObject({
      toolCalls: 5,
      duplicateToolCalls: 1,
      cacheHits: 3,
      tokenUsage: { input: 18, output: 7, reasoning: 3, cacheHit: 5 },
      maxCompactionLevel: 2,
      forcedSummary: true,
    });
    expect(report.dimensions.api).toMatchObject({
      efficiency: { duplicateToolCalls: 1, emptyRetries: 1 },
    });
    expect(report.totals).toMatchObject({
      efficiency: { cacheHits: 3, totalCompactedItems: 5 },
    });
  });

  test('exposes project skill delivery receipts in workflow reports', () => {
    const report = {
      version: '2.7.0',
      timestamp: '2026-05-24T00:00:00.000Z',
      project: { name: 'Alembic', files: 1, lang: 'ts' },
      duration: { totalMs: 100, totalSec: 0 },
      dimensions: { api: {} },
      totals: { skills: 1 },
      checkpoints: { restored: [] },
      incremental: null,
      semanticMemory: null,
      session: { id: 'session-1' },
    } as WorkflowReport;
    const receipt = createAlembicProjectSkillDeliveryReceipt({
      asset: {
        contentHash: 'sha256:abc123',
        dimensionId: 'api',
        path: '/tmp/project/Alembic/skills/project-api/SKILL.md',
      },
      authorization: {
        codexSkillRoot: '/tmp/project/.agents/skills',
        projectScopeId: 'project:test',
        status: 'pending',
      },
      codexSkillRoot: '/tmp/project/.agents/skills',
      createdAt: '2026-05-24T12:00:00Z',
      dimensionId: 'api',
      id: 'receipt-api',
      managedMarker: {
        generatedSkillId: 'alembic:project:test:project-api',
        markerPath: '/tmp/project/.agents/skills/project-api/.alembic-managed.json',
      },
      projectId: 'test',
      projectRoot: '/tmp/project',
      projectScopeId: 'project:test',
      runtimeExport: {
        codexSkillRoot: '/tmp/project/.agents/skills',
        projectScopeId: 'project:test',
        status: 'pending',
      },
      skillName: 'project-api',
    });

    const changed = augmentWorkflowReportWithSkillDeliveryReceipts(report, {
      created: 1,
      failed: 0,
      skills: ['project-api'],
      errors: [],
      deliveryReceipts: [receipt],
      deliveryReceiptSummaries: ['Project Skill project-api generated by Alembic'],
    });

    expect(changed).toBe(true);
    expect(report.projectSkillDelivery).toMatchObject({
      contract: 'ProjectSkillDeliveryReceipt',
      receiptCount: 1,
      route: 'alembic',
    });
    expect(report.totals).toMatchObject({ projectSkillDeliveryReceipts: 1 });
    expect(report.dimensions.api).toMatchObject({
      projectSkillDelivery: {
        receiptId: 'receipt-api',
        runtimeExportStatus: 'pending',
        skillName: 'project-api',
      },
    });
  });

  test('exposes PCV node-local baseline evidence in workflow reports', () => {
    const report = {
      version: '2.7.0',
      timestamp: '2026-05-28T00:00:00.000Z',
      project: { name: 'Alembic', files: 1, lang: 'ts' },
      duration: { totalMs: 100, totalSec: 0 },
      dimensions: { api: {} },
      totals: {},
      checkpoints: { restored: [] },
      incremental: null,
      semanticMemory: null,
      session: { id: 'session-1' },
    } as WorkflowReport;

    const changed = augmentWorkflowReportWithPcvNodeLocalBaseline(report, {
      api: {
        candidateCount: 1,
        durationMs: 10,
        pcvNodeEvidence: {
          n8: {
            chainNodeId: 'N8-stage-factory-tool-policy',
            contract: 'PCVColdStartNodeLocalBaseline',
            contractVersion: 1,
            dimensionId: 'api',
            evidenceKind: 'stage-factory-tool-policy',
            missingLinkReasons: [],
            nodeId: 'N8-stage-factory-tool-policy',
            producerToolRestriction: {
              gapLimit: null,
              noTerminalProof: true,
              producerStagePresent: true,
              requiredSubmitTool: 'knowledge',
              terminalToolIds: [],
            },
            sourceRefs: [],
            stageOrder: ['analyze', 'quality_gate', 'produce', 'rejection_gate'],
            stageToolPolicies: [],
            status: 'linked',
            summary: 'n8 linked',
            terminalCapabilityHints: {
              terminalCapability: {
                enabled: true,
                modes: ['run'],
                scriptAllowed: false,
                toolset: 'terminal-run',
              },
              constraints: [],
            },
          },
          groundingLedger: {
            burnCount: 3,
            chainNodeId: 'pcvm:cold-start:n9',
            classifications: {
              'deterministic-evidence-consumed': 1,
              'evidence-produced': 1,
              'invalid-no-evidence': 1,
              'planning-only': 0,
              'record-only': 0,
              'summary-only': 0,
              'verification-only': 0,
            },
            contract: 'PCVColdStartNodeLocalBaseline',
            contractVersion: 1,
            deepseekV4NoForcedToolChoiceCount: 1,
            deterministicEvidenceConsumedCount: 1,
            dimensionId: 'api',
            evidenceKind: 'analyze-grounding-ledger',
            evidenceProducedCount: 1,
            invalidNoEvidenceCount: 1,
            missingLinkReasons: ['analyze_grounding_invalid_no_evidence'],
            nodeId: 'pcvm:n9:analyze',
            planningOnlyCount: 0,
            recordOnlyCount: 0,
            sourceRefs: [],
            status: 'partial-evidence',
            summary: 'api analyze grounding ledger recorded 3 burns',
            summaryOnlyCount: 0,
            toolSchemasVisibleCount: 2,
            verificationOnlyCount: 0,
          },
          n9QualityGate: {
            action: 'pass',
            chainNodeId: 'pcvm:cold-start:n9:quality',
            contract: 'PCVColdStartNodeLocalBaseline',
            contractVersion: 1,
            dimensionId: 'api',
            evidenceKind: 'n9-stage-projection',
            missingLinkReasons: [],
            nodeId: 'pcvm:n9:quality_gate',
            pass: true,
            phasePresent: true,
            projectionSource: 'phase',
            sourceRefs: [],
            stageId: 'quality_gate',
            status: 'linked',
            summary: 'api quality gate stage projected',
            timedOut: false,
          },
          n9RecordRepair: {
            action: 'record_repair_incomplete',
            chainNodeId: 'pcvm:cold-start:n9:repair',
            contract: 'PCVColdStartNodeLocalBaseline',
            contractVersion: 1,
            dimensionId: 'api',
            evidenceKind: 'n9-stage-projection',
            missingLinkReasons: [],
            nodeId: 'pcvm:n9:record_repair',
            pass: null,
            phasePresent: true,
            projectionSource: 'phase',
            sourceRefs: [],
            stageId: 'record_repair',
            status: 'linked',
            summary: 'api record repair stage projected',
            timedOut: false,
          },
          n11: {
            acceptedCount: 1,
            chainNodeId: 'pcvm:cold-start:n11',
            contract: 'PCVColdStartNodeLocalBaseline',
            contractVersion: 1,
            dimensionId: 'api',
            evidenceKind: 'producer-cut',
            gapLimit: null,
            invalidSourceRefCount: 1,
            invalidSourceRefRatio: 0.5,
            invalidSourceRefs: [
              {
                normalizedPath: 'src/missing.ts',
                reason: 'file-not-found',
                ref: 'src/missing.ts',
              },
            ],
            missingLinkReasons: ['producer_source_refs_invalid'],
            noTerminalProof: true,
            nodeId: 'pcvm:n11:produce',
            producerOnlyCut: true,
            producerToolCalls: [{ action: 'submit', status: 'created', tool: 'knowledge' }],
            rejectedCount: 0,
            sourceRefs: ['src/api.ts', 'src/missing.ts'],
            sourceRefValidity: {
              checked: true,
              invalidSourceRefCount: 1,
              invalidSourceRefRatio: 0.5,
              invalidSourceRefs: [
                {
                  normalizedPath: 'src/missing.ts',
                  reason: 'file-not-found',
                  ref: 'src/missing.ts',
                },
              ],
              status: 'invalid',
              totalSourceRefCount: 2,
              uncheckedReason: null,
              validSourceRefCount: 1,
            },
            sourceRefValidityStatus: 'invalid',
            status: 'blocked-by-observability-gap',
            submittedCount: 1,
            summary: 'n11 invalid source refs surfaced',
            terminalToolCallCount: 0,
            totalSourceRefCount: 2,
            validSourceRefCount: 1,
          },
        },
      },
    });

    expect(changed).toBe(true);
    expect(report.pcvScorecard).toMatchObject({
      contract: 'PCVColdStartNodeLocalBaseline',
      scope: 'alembic-cold-start-bootstrap-node-local',
      nodes: {
        n9QualityGate: {
          chainNodeIds: ['pcvm:cold-start:n9:quality'],
          nodeIds: ['pcvm:n9:quality_gate'],
        },
        n9RecordRepair: {
          chainNodeIds: ['pcvm:cold-start:n9:repair'],
          nodeIds: ['pcvm:n9:record_repair'],
        },
        n11: {
          chainNodeIds: ['pcvm:cold-start:n11'],
          nodeIds: ['pcvm:n11:produce'],
          sourceRefValidity: {
            invalidSourceRefCount: 1,
            invalidSourceRefRatio: 0.5,
            statuses: { invalid: 1 },
            totalSourceRefCount: 2,
            validSourceRefCount: 1,
          },
        },
      },
      summary: { blockedNodes: 1, dimensionCount: 1, linkedNodes: 3, nodeCount: 4 },
    });
    expect(report.pcvScorecard).toMatchObject({
      processMetrics: {
        analyzeGrounding: {
          burnCount: 3,
          chainNodeIds: ['pcvm:cold-start:n9'],
          deepseekV4NoForcedToolChoiceCount: 1,
          dimensionsWithEvidence: 1,
          evidenceProducedCount: 1,
          invalidNoEvidenceCount: 1,
          nodeIds: ['pcvm:n9:analyze'],
          toolSchemasVisibleCount: 2,
        },
      },
    });
    expect(JSON.stringify(report.pcvScorecard)).toContain('pcvm:n9:analyze');
    expect(JSON.stringify(report.pcvScorecard)).toContain('pcvm:n9:quality_gate');
    expect(JSON.stringify(report.pcvScorecard)).toContain('pcvm:n9:record_repair');
    expect(JSON.stringify(report.pcvScorecard)).toContain('pcvm:n11:produce');
    expect(JSON.stringify(report.pcvScorecard)).not.toContain('analyze-evidence-grounding-ledger');
    expect(JSON.stringify(report.pcvScorecard)).not.toContain('N11-produce');
    expect(report.dimensions.api).toMatchObject({
      pcvNodeEvidence: {
        groundingLedger: {
          burnCount: 3,
          invalidNoEvidenceCount: 1,
        },
        n8: { status: 'linked' },
        n9QualityGate: { nodeId: 'pcvm:n9:quality_gate', status: 'linked' },
        n9RecordRepair: { nodeId: 'pcvm:n9:record_repair', status: 'linked' },
        n11: { acceptedCount: 1, status: 'blocked-by-observability-gap' },
      },
    });
    expect(report.totals).toMatchObject({
      pcvNodeLocalBlockedNodes: 1,
      pcvNodeLocalEvidenceDimensions: 1,
      pcvNodeLocalEvidenceNodes: 4,
      pcvNodeLocalLinkedNodes: 3,
      pcvAnalyzeGroundingBurns: 3,
      pcvAnalyzeGroundingInvalidNoEvidence: 1,
    });
  });

  test('accepts PCV node evidence envelopes as the report-facing contract', () => {
    const report = {
      version: '2.7.0',
      timestamp: '2026-05-30T00:00:00.000Z',
      project: { name: 'Alembic', files: 1, lang: 'ts' },
      duration: { totalMs: 100, totalSec: 0 },
      dimensions: { api: {} },
      totals: {},
      checkpoints: { restored: [] },
      incremental: null,
      semanticMemory: null,
      session: { id: 'session-1' },
    } as WorkflowReport;

    const changed = augmentWorkflowReportWithPcvNodeLocalBaseline(report, {
      api: {
        candidateCount: 0,
        durationMs: 10,
        pcvNodeEvidenceEnvelope: {
          contract: 'PcvNodeEvidenceEnvelope',
          contractVersion: 1,
          dimensionId: 'api',
          evidenceScope: 'unit',
          source: 'bootstrap-dimension-consumer',
          evidence: {
            n12: {
              acceptedCandidateTitles: [],
              chainNodeId: 'pcvm:cold-start:n12',
              contract: 'PCVColdStartNodeLocalBaseline',
              contractVersion: 1,
              dimensionId: 'api',
              evidenceKind: 'consumer-persistence',
              failureDetailsPersisted: true,
              findableCandidateTitles: [],
              missingLinkReasons: [],
              nodeId: 'N12-consumers-persistence',
              persistedFailureReason: null,
              sessionStoreSnapshotAvailable: true,
              sourceRefs: [],
              status: 'linked',
              summary: 'n12 linked',
            },
          },
        },
      },
    });

    expect(changed).toBe(true);
    expect(report.pcvScorecard).toMatchObject({
      summary: { blockedNodes: 0, dimensionCount: 1, linkedNodes: 1, nodeCount: 1 },
    });
    expect(report.dimensions.api).toMatchObject({
      pcvNodeEvidence: {
        n12: {
          nodeId: 'N12-consumers-persistence',
          status: 'linked',
        },
      },
    });
  });
});

function makePreparation({
  mode = 'bootstrap',
  taskManager = null,
}: {
  mode?: 'bootstrap' | 'rescan';
  taskManager?: unknown;
} = {}): InternalDimensionFillPreparation {
  return {
    allFiles: [{ content: 'export {}', path: '/tmp/alembic-project/src/api.ts' }],
    ctx: {
      container: {
        get: () => undefined,
        singletons: {},
      },
    },
    dataRoot: '/tmp/alembic-data',
    dimensions: [{ id: 'api', label: 'API' }],
    emitter: { emitDimensionComplete: () => undefined },
    incrementalPlan: null,
    isIncremental: false,
    projectRoot: '/tmp/alembic-project',
    sessionId: 'session-1',
    skipTargetDelivery: false,
    taskManager,
    view: { mode },
  } as unknown as InternalDimensionFillPreparation;
}

function makeRuntime() {
  return {
    projectInfo: { fileCount: 1, lang: 'ts', name: 'Alembic' },
    sessionStore: {
      getCompletedDimensions: () => [],
      toJSON: () => ({}),
    },
  } as unknown as Parameters<typeof buildInternalDimensionPersistenceInput>[0]['runtime'];
}

function makeSessionResult(): InternalDimensionFillSessionResult {
  return {
    bootstrapDedup: new Set<string>(),
    candidateResults: { created: 1, failed: 0, errors: [] },
    concurrency: 2,
    dimensionCandidates: {},
    dimensionStats: {
      api: {
        candidateCount: 1,
        durationMs: 10,
      },
    },
    enableParallel: true,
    incrementalSkippedDims: [],
    skippedDims: [],
  } as unknown as InternalDimensionFillSessionResult;
}

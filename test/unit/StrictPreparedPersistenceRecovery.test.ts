import {
  type CreateRecipeItem,
  createRecipeCandidateFingerprintProjectionV1,
  createStrictAcceptedCorpusInspectionV1,
  createStrictAdmissionReceiptV1,
  createStrictG1ReceiptV1,
  createStrictG2ReceiptV1,
  createStrictRecipePersistedPayloadV1,
  prepareRecipePersistenceV1,
  RecipeProductionGateway,
  STRICT_G1_HARD_AXES_V1,
  STRICT_G2_HARD_AXES_V1,
} from '@alembic/core/knowledge';
import { describe, expect, it, vi } from 'vitest';

describe('strict prepared-id crash recovery', () => {
  it('recovers the exact prepared row after a post-create crash without allocating or creating again', async () => {
    const item: CreateRecipeItem = {
      title: 'Prepared persistence survives restart',
      description: 'Inspect the deterministic row before creating.',
      trigger: '@prepared-recovery',
      whenClause: 'After a crash between durable create and readback',
      kind: 'pattern',
      category: 'reliability',
      doClause: 'Inspect the deterministic row before creating.',
      dontClause: 'Do not allocate a replacement identifier.',
      coreCode: 'persistPreparedReviewedCandidate(item, prepared, context)',
      content: {
        markdown: 'Use the journal-bound prepared identifier for recovery.',
        pattern: '',
      },
      usageGuide: 'Apply after a crash between durable create and readback.',
      retrievalProfile: {
        intents: [{ text: 'recover prepared recipe', priority: 'primary' }],
        exclusions: [{ text: 'random replacement', reason: 'breaks lineage' }],
      },
      scope: 'main',
      moduleName: 'main',
      dimensionId: 'reliability',
      sourceRefs: ['E-prepared'],
    };
    const reviewed = createRecipeCandidateFingerprintProjectionV1({
      title: item.title ?? '',
      kind: item.kind ?? '',
      category: item.category ?? '',
      trigger: item.trigger ?? '',
      whenClause: item.whenClause ?? '',
      doText: item.doClause ?? '',
      dontText: item.dontClause ?? '',
      coreCode: item.coreCode ?? '',
      pattern: item.content?.pattern ?? '',
      markdown: item.content?.markdown ?? '',
      usageGuide: item.usageGuide ?? '',
      retrievalProfile: item.retrievalProfile,
      negativeIntents: ['random replacement'],
      scopeId: item.scope ?? '',
      moduleId: item.moduleName ?? '',
      dimensionId: item.dimensionId ?? '',
      evidenceRefs: item.sourceRefs ?? [],
      lineageHashes: ['sha256:lineage'],
      persistedPayload: createStrictRecipePersistedPayloadV1(item, 'alembic-agent'),
    });
    const g1Receipt = createStrictG1ReceiptV1({
      candidateFingerprint: reviewed.authoredFingerprint,
      retrievalReadinessHash: 'sha256:retrieval-ready',
      rows: STRICT_G1_HARD_AXES_V1.map((axis) => ({
        axis,
        verdict: 'pass' as const,
        reasonCode: 'verified',
        evidenceRefs: [`E-prepared:${axis}`],
      })),
    });
    const acceptedCorpus = createStrictAcceptedCorpusInspectionV1({
      runId: 'run-prepared-crash',
      analysisFixpointHash: 'sha256:fixpoint',
      privateCorpusRevision: 'revision-prepared',
      revisionRootManifestHash: `sha256:${'9'.repeat(64)}`,
      entries: [],
    });
    const admissionReceipt = createStrictAdmissionReceiptV1({
      g1Receipt,
      corpusInspection: acceptedCorpus,
      inputFingerprint: reviewed.authoredFingerprint,
      finalAdmittedFingerprint: reviewed.authoredFingerprint,
      exactMatches: [],
      semanticMatches: [],
      consolidation: {
        action: 'create',
        reasonCode: 'strict-test-novel-candidate',
        targetRecipeId: null,
        targetFingerprint: null,
      },
      algorithmVersion: 'gateway-admission-v1',
    });
    const g2Receipt = createStrictG2ReceiptV1({
      g1Receipt,
      admissionReceipt,
      reviewedFingerprint: reviewed.authoredFingerprint,
      producer: {
        identity: 'producer-model',
        method: 'recipe-expression-v1',
        modelHash: 'sha256:producer-model',
        promptHash: 'sha256:producer-prompt',
      },
      reviewer: {
        identity: 'independent-reviewer',
        method: 'value-gate-v1',
        modelHash: 'sha256:reviewer-model',
        promptHash: 'sha256:reviewer-prompt',
      },
      rows: STRICT_G2_HARD_AXES_V1.map((axis) => ({
        axis,
        axisVerdict: 'pass' as const,
        score: 2 as const,
        reasonCode: 'verified',
        evidenceRefs: [`E-prepared:${axis}`],
        repairable: false,
      })),
      novelty: {
        decision: 'novel-project-specific',
        reasonCode: 'project-specific-mechanism',
        evidenceRefs: ['E-prepared'],
      },
      duplicate: {
        decision: 'no-match',
        reasonCode: 'complete-corpus-no-match',
        evidenceRefs: ['E-prepared'],
        admissionAlgorithmVersion: admissionReceipt.algorithmVersion,
        comparedPrivateCorpusRevision: admissionReceipt.privateCorpusRevision,
        matchedRecipeIds: [],
        matchedFingerprints: [],
        targetRecipeId: null,
        consolidationFingerprint: null,
      },
      repairAttempt: 0,
      calibrationReceiptHash: 'sha256:calibration',
      ruleVersion: 'strict-g2-rule-v1',
      permittedRepairFields: [],
    });
    const prepared = prepareRecipePersistenceV1({
      runId: 'run-prepared-crash',
      analysisFixpointHash: 'sha256:fixpoint',
      privateCorpusRevision: 'revision-prepared',
      admissionId: admissionReceipt.admissionId,
      cellId: 'main::reliability',
      authoredFingerprint: reviewed.authoredFingerprint,
      causalParentIds: ['hypothesis-1'],
      expectedDbHash: 'sha256:db-row',
      expectedFileHash: 'sha256:file-row',
      journalStepHash: 'sha256:journal-step',
    });
    let stored: {
      id: string;
      title: string;
      lifecycle: string;
      privateCorpusRevision: string;
      preparedHash: string;
      admissionId: string;
      g1ReceiptHash: string;
      admissionReceiptHash: string;
      g2ReceiptHash: string;
      authoredFingerprint: string;
      dbHash: string;
      fileHash: string;
    } | null = null;
    let crashAfterCreate = true;
    const create = vi.fn(async (data: Record<string, unknown>) => {
      stored = {
        id: String(data.id),
        title: String(data.title),
        lifecycle: 'pending',
        privateCorpusRevision: prepared.privateCorpusRevision,
        preparedHash: prepared.preparedHash,
        admissionId: admissionReceipt.admissionId,
        g1ReceiptHash: g1Receipt.receiptHash,
        admissionReceiptHash: admissionReceipt.receiptHash,
        g2ReceiptHash: g2Receipt.receiptHash,
        authoredFingerprint: reviewed.authoredFingerprint,
        dbHash: prepared.expectedDbHash,
        fileHash: prepared.expectedFileHash,
      };
      return stored;
    });
    const gateway = new RecipeProductionGateway({
      projectRoot: '/strict-fixture',
      knowledgeService: {
        create,
        async update() {
          throw new Error('unexpected-update');
        },
        async updateQuality() {
          throw new Error('unexpected-quality-update');
        },
      },
      authorizePreparedRecipe: (journalToken, candidate) =>
        journalToken === prepared.journalStepHash &&
        candidate.preparedHash === prepared.preparedHash,
      async inspectPreparedRecipe() {
        if (!stored) {
          return null;
        }
        if (crashAfterCreate) {
          crashAfterCreate = false;
          throw new Error('SIMULATED_POST_CREATE_CRASH');
        }
        return stored;
      },
    });
    const context = {
      source: 'alembic-agent' as const,
      userId: 'strict-production',
      journalToken: prepared.journalStepHash,
      reviewedProjection: reviewed,
      g1Receipt,
      admissionReceipt,
      g2Receipt,
    };

    await expect(gateway.persistPreparedReviewedCandidate(item, prepared, context)).rejects.toThrow(
      'SIMULATED_POST_CREATE_CRASH'
    );
    const recovered = await gateway.persistPreparedReviewedCandidate(item, prepared, context);

    expect(recovered).toMatchObject({
      status: 'recovered',
      recipe: { id: prepared.preparedRecipeId },
      strictUuidAllocations: 0,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

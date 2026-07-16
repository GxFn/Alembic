import {
  type CreateRecipeItem,
  createRecipeCandidateFingerprintProjectionV1,
  prepareRecipePersistenceV1,
  RecipeProductionGateway,
} from '@alembic/core/knowledge';
import { describe, expect, it, vi } from 'vitest';

describe('strict prepared-id crash recovery', () => {
  it('recovers the exact prepared row after a post-create crash without allocating or creating again', async () => {
    const reviewed = createRecipeCandidateFingerprintProjectionV1({
      title: 'Prepared persistence survives restart',
      kind: 'pattern',
      doText: 'Inspect the deterministic row before creating.',
      dontText: 'Do not allocate a replacement identifier.',
      markdown: 'Use the journal-bound prepared identifier for recovery.',
      usageGuide: 'Apply after a crash between durable create and readback.',
      retrievalProfile: {
        intents: [{ text: 'recover prepared recipe', priority: 'primary' }],
        exclusions: [{ text: 'random replacement', reason: 'breaks lineage' }],
      },
      negativeIntents: ['random replacement'],
      scopeId: 'main',
      moduleId: 'main',
      dimensionId: 'reliability',
      evidenceRefs: ['E-prepared'],
      lineageHashes: ['sha256:lineage'],
    });
    const prepared = prepareRecipePersistenceV1({
      runId: 'run-prepared-crash',
      analysisFixpointHash: 'sha256:fixpoint',
      privateCorpusRevision: 'revision-prepared',
      cellId: 'main::reliability',
      authoredFingerprint: reviewed.authoredFingerprint,
      causalParentIds: ['hypothesis-1'],
      expectedDbHash: 'sha256:db-row',
      expectedFileHash: 'sha256:file-row',
      journalStepHash: 'sha256:journal-step',
    });
    const item: CreateRecipeItem = {
      title: reviewed.title,
      description: reviewed.doText,
      trigger: '@prepared-recovery',
      kind: reviewed.kind,
      doClause: reviewed.doText,
      dontClause: reviewed.dontText,
      content: { markdown: reviewed.markdown },
      usageGuide: reviewed.usageGuide,
      retrievalProfile: reviewed.retrievalProfile as CreateRecipeItem['retrievalProfile'],
      scope: reviewed.scopeId,
      moduleName: reviewed.moduleId,
      dimensionId: reviewed.dimensionId,
      sourceRefs: [...reviewed.evidenceRefs],
    };
    let stored: {
      id: string;
      title: string;
      lifecycle: string;
      privateCorpusRevision: string;
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

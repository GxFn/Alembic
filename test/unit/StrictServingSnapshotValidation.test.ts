import {
  createCandidateCoverageReceiptV1,
  createFinalCoverageBindingReceiptV1,
} from '@alembic/core/knowledge';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import { describe, expect, it } from 'vitest';
import { createServingSnapshotValidationReceiptV1 } from '../../lib/recipe-pipeline/generate/strict/StrictFinalizationRuntime.js';

describe('strict serving snapshot validation receipt', () => {
  it('canonically binds the exact tool-neutral serving snapshot before the Core manifest', () => {
    const receipt = createServingSnapshotValidationReceiptV1(fixture());

    expect(receipt).toMatchObject({
      schemaVersion: 1,
      runId: 'run-a',
      sessionId: 'run-a',
      snapshotId: expect.stringMatching(/^snapshot:/u),
      servingRecipeIds: ['recipe-a'],
      servingRecipeFingerprints: [sha('fingerprint-a')],
      coreManifestSchemaVersion: 1,
      coreRouteSchemaVersion: 1,
      verdict: 'pass',
      failedPredicate: null,
    });
    expect(receipt.receiptHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain('candidateOracle');
  });

  it('fails closed for final coverage, member, sparse, vector, lineage, and canonical-hash mismatch', () => {
    const cases: Array<[string, (input: ReturnType<typeof fixture>) => void]> = [
      [
        'final-coverage-conservation',
        (input) => {
          input.finalCoverage = {
            ...input.finalCoverage,
            cells: [{ ...input.finalCoverage.cells[0], finalRecipeIds: ['other'] }],
          };
        },
      ],
      [
        'ready-member-conservation',
        (input) => {
          input.readyMembers = [{ ...input.readyMembers[0], lifecycle: 'staging' as never }];
        },
      ],
      [
        'ready-member-conservation',
        (input) => {
          input.readyMembers = [{ ...input.readyMembers[0], lifecycle: 'pending' as never }];
        },
      ],
      [
        'ready-member-conservation',
        (input) => {
          input.readyMembers = [{ ...input.readyMembers[0], lifecycle: 'rejected' as never }];
        },
      ],
      [
        'ready-member-conservation',
        (input) => {
          input.readyMembers = [{ ...input.readyMembers[0], refReadbackHash: sha('other-ref') }];
        },
      ],
      [
        'sealed-corpus-conservation',
        (input) => {
          input.sealedCorpusVerification = {
            ...input.sealedCorpusVerification,
            sparseEvidenceHash: sha('other-sparse'),
          };
        },
      ],
      [
        'vector-generation-conservation',
        (input) => {
          input.vectorManifestHash = sha('other-vector');
        },
      ],
      [
        'lineage-conservation',
        (input) => {
          input.lineage.analysisFixpointHash = sha('other-fixpoint');
        },
      ],
      [
        'canonical-hash-policy',
        (input) => {
          input.lineage.compiledPlanHash = 'not-canonical';
        },
      ],
    ];

    for (const [predicate, mutate] of cases) {
      const input = fixture();
      mutate(input);
      expect(() => createServingSnapshotValidationReceiptV1(input), predicate).toThrow(
        `STRICT_SERVING_SNAPSHOT_VALIDATION_FAILED:${predicate}`
      );
    }
  });
});

function fixture() {
  const candidateCoverage = createCandidateCoverageReceiptV1({
    planBaselineHash: sha('baseline'),
    finalExpandedScheduleHash: sha('expanded'),
    analysisFixpointHash: sha('fixpoint'),
    evidenceLedgerHash: sha('evidence'),
    candidateDatabaseHash: sha('candidate-database'),
    candidateFilesHash: sha('candidate-files'),
    requiredCellIds: ['module-a::dimension-a'],
    cells: [
      {
        cellId: 'module-a::dimension-a',
        candidateDisposition: 'covered-by-content-ready-candidate',
        contentReadyRecipeIds: ['recipe-a'],
        contentReadyRecipeFingerprints: [sha('fingerprint-a')],
        productionBindingHashes: [sha('binding-a')],
        lensBindingIds: ['lens-a'],
        expressionSetReceiptIds: [sha('expression-set-a')],
      },
    ],
  });
  const g4ReceiptHash = sha('g4');
  const candidateDataManifestHash = sha('candidate-data');
  const finalCoverage = createFinalCoverageBindingReceiptV1({
    candidateCoverage,
    g4ReceiptHash,
    candidateDataManifestHash,
    cells: [
      {
        cellId: 'module-a::dimension-a',
        finalDisposition: 'covered-by-ready-recipe',
        finalRecipeIds: ['recipe-a'],
        finalRecipeFingerprints: [sha('fingerprint-a')],
      },
    ],
  });
  const readyMemberSemantic = {
    schemaVersion: 1 as const,
    recipeId: 'recipe-a',
    title: 'Recipe A',
    runId: 'run-a',
    privateCorpusRevision: 'revision-a',
    analysisFixpointHash: sha('fixpoint'),
    authoredFingerprint: sha('fingerprint-a'),
    bindingHash: sha('binding-a'),
    persistenceReceiptHash: sha('persistence-a'),
    databaseRowHash: sha('database-a'),
    databaseReadbackHash: sha('database-readback-a'),
    fileHash: sha('file-a'),
    fileReadbackHash: sha('file-readback-a'),
    refReconciliationReceiptHash: sha('refs-a'),
    refReadbackHash: sha('ref-readback-a'),
    lifecycle: 'active' as const,
  };
  const readyMembers = [
    { ...readyMemberSemantic, proofHash: hashCanonicalJson(readyMemberSemantic) },
  ];
  const sealedSemantic = {
    schemaVersion: 1 as const,
    activeRecipeIds: ['recipe-a'],
    readyMemberSetHash: hashCanonicalJson(readyMembers.map((member) => member.proofHash)),
    durableReadbackHash: hashCanonicalJson(
      readyMembers.map((member) => ({
        recipeId: member.recipeId,
        persistenceReceiptHash: member.persistenceReceiptHash,
        databaseRowHash: member.databaseRowHash,
        databaseReadbackHash: member.databaseReadbackHash,
        fileHash: member.fileHash,
        fileReadbackHash: member.fileReadbackHash,
      }))
    ),
    refReadbackHash: hashCanonicalJson(
      readyMembers.map((member) => ({
        recipeId: member.recipeId,
        refReconciliationReceiptHash: member.refReconciliationReceiptHash,
        refReadbackHash: member.refReadbackHash,
      }))
    ),
    sparseEvidenceHash: sha('sparse'),
    vectorGenerationId: 'generation-a',
    vectorManifestHash: sha('vector-manifest'),
    vectorInspectionHash: sha('vector-inspection'),
    verdict: 'pass' as const,
    failedPredicate: null,
  };
  return {
    runId: 'run-a',
    sessionId: 'run-a',
    snapshotId: `snapshot:${sha('candidate-data').slice(-32)}`,
    candidateDataManifestHash,
    candidateCoverage,
    g4ReceiptHash,
    finalCoverage,
    readyMembers,
    sealedCorpusVerification: {
      ...sealedSemantic,
      verificationHash: hashCanonicalJson(sealedSemantic),
    },
    vectorGenerationId: 'generation-a',
    vectorManifestHash: sha('vector-manifest'),
    lineage: {
      certifiedProjectFactsHash: sha('certified-facts'),
      sourceRevisionVectorHash: sha('source-vector'),
      planCognitionLineageHash: sha('plan-cognition'),
      compiledPlanHash: sha('compiled-plan'),
      factQueryCatalogHash: sha('fact-query'),
      requiredApplicabilityUniverseHash: sha('applicability'),
      baselineScheduleHash: sha('baseline'),
      expansionLedgerHeadHash: sha('expansion-ledger'),
      finalExpandedScheduleHash: sha('expanded'),
      analysisFixpointHash: sha('fixpoint'),
      hypothesisExpressionSetManifestHash: sha('expression-manifest'),
      finalCodeFactGenerationManifestHash: sha('fact-generation'),
    },
    coreManifestSchemaVersion: 1 as const,
    coreRouteSchemaVersion: 1 as const,
  };
}

function sha(value: string): `sha256:${string}` {
  return `sha256:${Buffer.from(value).toString('hex').padEnd(64, '0').slice(0, 64)}`;
}

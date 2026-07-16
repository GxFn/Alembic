import { InvestigatedEmptyReviewer, type ReviewerIdentityV1 } from '@alembic/agent/evaluation';
import type { StrictProducerExpressionSetV1 } from '@alembic/agent/production';
import {
  type CandidateCoverageReceiptV1,
  createCandidateCoverageReceiptV1,
  createFinalCoverageBindingReceiptV1,
  createServingSnapshotManifestV1,
  type FinalCoverageBindingReceiptV1,
  type PreparedPublicKnowledgeRouteV1,
  preparePublicKnowledgeRouteV1,
  type ServingSnapshotManifestV1,
} from '@alembic/core/knowledge';
import type { CompiledColdStartPlanV2 } from '@alembic/core/plans';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import type { StrictAnalysisExecutionResultV1 } from './StrictAnalysisRuntime.js';
import type {
  StrictPrivateCorpusContentResultV1,
  StrictPrivateCorpusResultV1,
  StrictReadyMemberProofV1,
  StrictSealedCorpusVerificationV1,
} from './StrictPrivateCorpusRuntime.js';

export type ServingSnapshotValidationPredicateV1 =
  | 'canonical-hash-policy'
  | 'identity-conservation'
  | 'candidate-coverage-conservation'
  | 'final-coverage-conservation'
  | 'ready-member-conservation'
  | 'sealed-corpus-conservation'
  | 'vector-generation-conservation'
  | 'lineage-conservation'
  | 'core-schema-conservation';

export interface ServingSnapshotValidationLineageV1 {
  readonly certifiedProjectFactsHash: string;
  readonly sourceRevisionVectorHash: string;
  readonly planCognitionLineageHash: string;
  readonly compiledPlanHash: string;
  readonly factQueryCatalogHash: string;
  readonly requiredApplicabilityUniverseHash: string;
  readonly baselineScheduleHash: string;
  readonly expansionLedgerHeadHash: string;
  readonly finalExpandedScheduleHash: string;
  readonly analysisFixpointHash: string;
  readonly hypothesisExpressionSetManifestHash: string;
  readonly finalCodeFactGenerationManifestHash: string;
}

export interface ServingSnapshotValidationReceiptV1 extends ServingSnapshotValidationLineageV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sessionId: string;
  readonly snapshotId: string;
  readonly candidateDataManifestHash: string;
  readonly candidateCoverageReceiptHash: string;
  readonly g3BindingSetHash: string;
  readonly g4ReceiptHash: string;
  readonly finalCoverageBindingHash: string;
  readonly servingRecipeIds: readonly string[];
  readonly servingRecipeFingerprints: readonly string[];
  readonly lifecycleConservationHash: string;
  readonly databaseConservationHash: string;
  readonly fileConservationHash: string;
  readonly refConservationHash: string;
  readonly coverageConservationHash: string;
  readonly sealedCorpusVerificationHash: string;
  readonly sparseEvidenceHash: string;
  readonly vectorGenerationId: string;
  readonly vectorManifestHash: string;
  readonly vectorInspectionHash: string;
  readonly coreManifestSchemaVersion: 1;
  readonly coreRouteSchemaVersion: 1;
  readonly verdict: 'pass';
  readonly failedPredicate: null;
  readonly receiptHash: string;
}

export interface ServingSnapshotValidationInputV1 {
  readonly runId: string;
  readonly sessionId: string;
  readonly snapshotId: string;
  readonly candidateDataManifestHash: string;
  readonly candidateCoverage: CandidateCoverageReceiptV1;
  readonly g4ReceiptHash: string;
  readonly finalCoverage: FinalCoverageBindingReceiptV1;
  readonly readyMembers: readonly StrictReadyMemberProofV1[];
  readonly sealedCorpusVerification: StrictSealedCorpusVerificationV1;
  readonly vectorGenerationId: string;
  readonly vectorManifestHash: string;
  readonly lineage: ServingSnapshotValidationLineageV1;
  readonly coreManifestSchemaVersion: 1;
  readonly coreRouteSchemaVersion: 1;
}

interface ServingRecipeIdentityV1 {
  readonly recipeId: string;
  readonly authoredFingerprint: string;
}

interface CandidateRecipeIdentityV1 extends ServingRecipeIdentityV1 {
  readonly bindingHash: string;
}

export interface StrictFinalizationResultV1 {
  readonly candidateCoverage: CandidateCoverageReceiptV1;
  readonly candidateDataManifestHash: string;
  readonly finalCoverage: FinalCoverageBindingReceiptV1;
  readonly g4ReceiptHash: string;
  readonly preparedPublicRoute: PreparedPublicKnowledgeRouteV1;
  readonly servingSnapshotValidation: ServingSnapshotValidationReceiptV1;
  readonly servingManifest: ServingSnapshotManifestV1;
}

export function finalizeStrictCandidate(input: {
  readonly analysis: StrictAnalysisExecutionResultV1;
  readonly certifiedProjectFactsHash: string;
  readonly committedAt: string;
  readonly compiledPlan: CompiledColdStartPlanV2;
  readonly expressionSets: readonly StrictProducerExpressionSetV1[];
  readonly planCognitionHash: string;
  readonly privateCorpus: StrictPrivateCorpusResultV1;
  readonly candidateCoverage: CandidateCoverageReceiptV1;
  readonly runId: string;
}): StrictFinalizationResultV1 {
  const candidateCoverage = input.candidateCoverage;
  const candidateDataManifestHash = hashCanonicalJson({
    rootManifestHash: input.privateCorpus.rootManifestHash,
    vectorGenerationId: input.privateCorpus.vectorGenerationId,
    vectorManifestHash: input.privateCorpus.vectorManifestHash,
    activeRecipeIds: input.privateCorpus.activeRecipeIds,
    readyRecipes: input.privateCorpus.readyMembers.map((member) => ({
      recipeId: member.recipeId,
      authoredFingerprint: member.authoredFingerprint,
      proofHash: member.proofHash,
    })),
    sealedCorpusVerificationHash: input.privateCorpus.sealedCorpusVerification.verificationHash,
  });
  const g4ReceiptHash = hashCanonicalJson({
    gate: 'G4',
    verdict: 'pass',
    candidateCoverageHash: candidateCoverage.receiptHash,
    candidateDataManifestHash,
    vectorManifestHash: input.privateCorpus.vectorManifestHash,
    servingReconciliation: 'exact-candidate-root',
    sealedCorpusVerificationHash: input.privateCorpus.sealedCorpusVerification.verificationHash,
  });
  const finalCoverage = createFinalCoverageBindingReceiptV1({
    candidateCoverage,
    g4ReceiptHash,
    candidateDataManifestHash,
    cells: candidateCoverage.cells.map((cell) => ({
      cellId: cell.cellId,
      finalDisposition:
        cell.candidateDisposition === 'covered-by-content-ready-candidate'
          ? ('covered-by-ready-recipe' as const)
          : ('investigated-empty' as const),
      finalRecipeIds: cell.contentReadyRecipeIds,
      finalRecipeFingerprints: cell.contentReadyRecipeFingerprints,
    })),
  });
  const snapshotId = `snapshot:${candidateDataManifestHash.slice(-32)}`;
  const expansionLedgerHeadHash = hashCanonicalJson([]);
  const hypothesisExpressionSetManifestHash = hashCanonicalJson(
    input.expressionSets.map((set) => set.setHash)
  );
  const finalCodeFactGenerationManifestHash = hashCanonicalJson(
    input.analysis.facts.map((fact) => fact.factId)
  );
  const lineage: ServingSnapshotValidationLineageV1 = {
    certifiedProjectFactsHash: input.certifiedProjectFactsHash,
    sourceRevisionVectorHash: input.compiledPlan.execution.sourceRevisionVectorHash,
    planCognitionLineageHash: input.planCognitionHash,
    compiledPlanHash: input.compiledPlan.canonicalPlanHash,
    factQueryCatalogHash: input.compiledPlan.factQueryCatalog.catalogHash,
    requiredApplicabilityUniverseHash: input.compiledPlan.requiredFactApplicability.universeHash,
    baselineScheduleHash: input.compiledPlan.schedule.baselineScheduleHash,
    expansionLedgerHeadHash,
    finalExpandedScheduleHash: input.analysis.fixpoint.finalExpandedScheduleHash,
    analysisFixpointHash: input.analysis.fixpoint.fixpointHash,
    hypothesisExpressionSetManifestHash,
    finalCodeFactGenerationManifestHash,
  };
  const servingSnapshotValidation = createServingSnapshotValidationReceiptV1({
    runId: input.runId,
    sessionId: input.runId,
    snapshotId,
    candidateDataManifestHash,
    candidateCoverage,
    g4ReceiptHash,
    finalCoverage,
    readyMembers: input.privateCorpus.readyMembers,
    sealedCorpusVerification: input.privateCorpus.sealedCorpusVerification,
    vectorGenerationId: input.privateCorpus.vectorGenerationId,
    vectorManifestHash: input.privateCorpus.vectorManifestHash,
    lineage,
    coreManifestSchemaVersion: 1,
    coreRouteSchemaVersion: 1,
  });
  const servingManifest = createServingSnapshotManifestV1({
    sessionId: input.runId,
    snapshotId,
    candidateDataManifestHash,
    finalCoverageBindingHash: finalCoverage.receiptHash,
    servingSnapshotValidationHash: servingSnapshotValidation.receiptHash,
    vectorGenerationId: input.privateCorpus.vectorGenerationId,
    vectorManifestHash: input.privateCorpus.vectorManifestHash,
    certifiedProjectFactsHash: input.certifiedProjectFactsHash,
    sourceRevisionVectorHash: input.compiledPlan.execution.sourceRevisionVectorHash,
    analysisFixpointHash: input.analysis.fixpoint.fixpointHash,
  });
  if (
    servingManifest.schemaVersion !== servingSnapshotValidation.coreManifestSchemaVersion ||
    servingManifest.servingSnapshotValidationHash !== servingSnapshotValidation.receiptHash
  ) {
    failServingSnapshotValidation('core-schema-conservation');
  }
  const preparedPublicRoute = preparePublicKnowledgeRouteV1({
    schemaVersion: 1,
    sessionId: input.runId,
    snapshotId,
    servingSnapshotManifestHash: servingManifest.manifestHash,
    vectorGenerationId: input.privateCorpus.vectorGenerationId,
    vectorManifestHash: input.privateCorpus.vectorManifestHash,
    ...lineage,
    committedAt: input.committedAt,
  });
  if (
    preparedPublicRoute.route.schemaVersion !== servingSnapshotValidation.coreRouteSchemaVersion
  ) {
    failServingSnapshotValidation('core-schema-conservation');
  }
  return Object.freeze({
    candidateCoverage,
    candidateDataManifestHash,
    finalCoverage,
    g4ReceiptHash,
    preparedPublicRoute,
    servingSnapshotValidation,
    servingManifest,
  });
}

export function createServingSnapshotValidationReceiptV1(
  input: ServingSnapshotValidationInputV1
): ServingSnapshotValidationReceiptV1 {
  const readyMembers = [...input.readyMembers].sort((left, right) =>
    left.recipeId.localeCompare(right.recipeId)
  );
  assertCanonicalValidationHashes(input, readyMembers);
  assertValidationIdentity(input);
  assertCandidateCoverage(input);
  assertFinalCoverage(input);
  const servingRecipes = collectServingRecipes(input);
  const candidateRecipes = collectCandidateRecipes(input);
  const memberRecipes = readyMembers.map((member) => ({
    recipeId: member.recipeId,
    authoredFingerprint: member.authoredFingerprint,
  }));
  assertReadyMemberConservation(
    input,
    readyMembers,
    memberRecipes,
    servingRecipes,
    candidateRecipes
  );
  assertSealedCorpusConservation(input, readyMembers);
  assertVectorGenerationConservation(input);
  assertLineageConservation(input, readyMembers);
  assertCoreSchemaConservation(input);
  const semantic = buildServingSnapshotValidationSemantic(
    input,
    readyMembers,
    memberRecipes,
    servingRecipes,
    candidateRecipes
  );
  return freezeDeep({ ...semantic, receiptHash: hashCanonicalJson(semantic) });
}

function assertCanonicalValidationHashes(
  input: ServingSnapshotValidationInputV1,
  readyMembers: readonly StrictReadyMemberProofV1[]
): void {
  const hashEntries: Array<readonly [string, unknown]> = [
    ['candidateDataManifestHash', input.candidateDataManifestHash],
    ['candidateCoverageReceiptHash', input.candidateCoverage.receiptHash],
    ['g4ReceiptHash', input.g4ReceiptHash],
    ['finalCoverageReceiptHash', input.finalCoverage.receiptHash],
    ['sealedCorpusVerificationHash', input.sealedCorpusVerification.verificationHash],
    ['sparseEvidenceHash', input.sealedCorpusVerification.sparseEvidenceHash],
    ['vectorInspectionHash', input.sealedCorpusVerification.vectorInspectionHash],
    ...Object.entries(input.lineage),
    ...readyMembers.flatMap((member, index) =>
      [
        ['analysisFixpointHash', member.analysisFixpointHash],
        ['authoredFingerprint', member.authoredFingerprint],
        ['bindingHash', member.bindingHash],
        ['persistenceReceiptHash', member.persistenceReceiptHash],
        ['databaseRowHash', member.databaseRowHash],
        ['databaseReadbackHash', member.databaseReadbackHash],
        ['fileHash', member.fileHash],
        ['fileReadbackHash', member.fileReadbackHash],
        ['refReconciliationReceiptHash', member.refReconciliationReceiptHash],
        ['refReadbackHash', member.refReadbackHash],
        ['proofHash', member.proofHash],
      ].map(([name, value]) => [`readyMembers[${index}].${name}`, value] as const)
    ),
  ];
  const invalidHash = hashEntries.find(([, value]) => !isCanonicalSha(value));
  if (invalidHash) {
    throw new Error(
      `STRICT_SERVING_SNAPSHOT_VALIDATION_FAILED:canonical-hash-policy:${invalidHash[0]}`
    );
  }
}

function assertValidationIdentity(input: ServingSnapshotValidationInputV1): void {
  if (
    !input.runId ||
    input.sessionId !== input.runId ||
    input.snapshotId !== `snapshot:${input.candidateDataManifestHash.slice(-32)}`
  ) {
    failServingSnapshotValidation('identity-conservation');
  }
}

function assertCandidateCoverage(input: ServingSnapshotValidationInputV1): void {
  if (
    input.candidateCoverage.receiptHash !== hashReceipt(input.candidateCoverage) ||
    input.candidateCoverage.cells.some(
      (cell) => cell.candidateDisposition === 'failed' || cell.candidateDisposition === 'unknown'
    )
  ) {
    failServingSnapshotValidation('candidate-coverage-conservation');
  }
}

function assertFinalCoverage(input: ServingSnapshotValidationInputV1): void {
  if (
    input.finalCoverage.receiptHash !== hashReceipt(input.finalCoverage) ||
    input.finalCoverage.candidateCoverageReceiptHash !== input.candidateCoverage.receiptHash ||
    input.finalCoverage.g4ReceiptHash !== input.g4ReceiptHash ||
    input.finalCoverage.candidateDataManifestHash !== input.candidateDataManifestHash ||
    input.finalCoverage.cells.some(
      (cell) => cell.finalDisposition === 'failed' || cell.finalDisposition === 'unknown'
    )
  ) {
    failServingSnapshotValidation('final-coverage-conservation');
  }
}

function collectServingRecipes(input: ServingSnapshotValidationInputV1): ServingRecipeIdentityV1[] {
  return input.finalCoverage.cells
    .flatMap((cell) =>
      cell.finalRecipeIds.map((recipeId, index) => ({
        recipeId,
        authoredFingerprint: cell.finalRecipeFingerprints[index] ?? '',
      }))
    )
    .sort((left, right) => left.recipeId.localeCompare(right.recipeId));
}

function collectCandidateRecipes(
  input: ServingSnapshotValidationInputV1
): CandidateRecipeIdentityV1[] {
  return input.candidateCoverage.cells
    .flatMap((cell) =>
      cell.contentReadyRecipeIds.map((recipeId, index) => ({
        recipeId,
        authoredFingerprint: cell.contentReadyRecipeFingerprints[index] ?? '',
        bindingHash: cell.productionBindingHashes[index] ?? '',
      }))
    )
    .sort((left, right) => left.recipeId.localeCompare(right.recipeId));
}

function assertReadyMemberConservation(
  input: ServingSnapshotValidationInputV1,
  readyMembers: readonly StrictReadyMemberProofV1[],
  memberRecipes: readonly ServingRecipeIdentityV1[],
  servingRecipes: readonly ServingRecipeIdentityV1[],
  candidateRecipes: readonly CandidateRecipeIdentityV1[]
): void {
  if (
    readyMembers.some((member) => member.lifecycle !== 'active' || member.runId !== input.runId) ||
    readyMembers.some(
      (member) => member.proofHash !== hashCanonicalJson(withoutHash(member, 'proofHash'))
    ) ||
    new Set(readyMembers.map((member) => member.recipeId)).size !== readyMembers.length ||
    new Set(readyMembers.map((member) => member.privateCorpusRevision)).size > 1 ||
    hashCanonicalJson(memberRecipes) !== hashCanonicalJson(servingRecipes) ||
    hashCanonicalJson(
      readyMembers.map((member) => ({
        recipeId: member.recipeId,
        authoredFingerprint: member.authoredFingerprint,
        bindingHash: member.bindingHash,
      }))
    ) !== hashCanonicalJson(candidateRecipes)
  ) {
    failServingSnapshotValidation('ready-member-conservation');
  }
}

function assertSealedCorpusConservation(
  input: ServingSnapshotValidationInputV1,
  readyMembers: readonly StrictReadyMemberProofV1[]
): void {
  const sealedSemantic = withoutHash(input.sealedCorpusVerification, 'verificationHash');
  if (
    input.sealedCorpusVerification.verdict !== 'pass' ||
    input.sealedCorpusVerification.failedPredicate !== null ||
    input.sealedCorpusVerification.verificationHash !== hashCanonicalJson(sealedSemantic) ||
    hashCanonicalJson(input.sealedCorpusVerification.activeRecipeIds) !==
      hashCanonicalJson(readyMembers.map((member) => member.recipeId))
  ) {
    failServingSnapshotValidation('sealed-corpus-conservation');
  }
}

function assertVectorGenerationConservation(input: ServingSnapshotValidationInputV1): void {
  if (
    !input.vectorGenerationId ||
    input.vectorGenerationId.trim() !== input.vectorGenerationId ||
    !isCanonicalDigest(input.vectorManifestHash) ||
    input.vectorGenerationId !== input.sealedCorpusVerification.vectorGenerationId ||
    input.vectorManifestHash !== input.sealedCorpusVerification.vectorManifestHash
  ) {
    failServingSnapshotValidation('vector-generation-conservation');
  }
}

function assertLineageConservation(
  input: ServingSnapshotValidationInputV1,
  readyMembers: readonly StrictReadyMemberProofV1[]
): void {
  if (
    input.candidateCoverage.planBaselineHash !== input.lineage.baselineScheduleHash ||
    input.candidateCoverage.finalExpandedScheduleHash !== input.lineage.finalExpandedScheduleHash ||
    input.candidateCoverage.analysisFixpointHash !== input.lineage.analysisFixpointHash ||
    readyMembers.some(
      (member) => member.analysisFixpointHash !== input.lineage.analysisFixpointHash
    )
  ) {
    failServingSnapshotValidation('lineage-conservation');
  }
}

function assertCoreSchemaConservation(input: ServingSnapshotValidationInputV1): void {
  if (input.coreManifestSchemaVersion !== 1 || input.coreRouteSchemaVersion !== 1) {
    failServingSnapshotValidation('core-schema-conservation');
  }
}

function buildServingSnapshotValidationSemantic(
  input: ServingSnapshotValidationInputV1,
  readyMembers: readonly StrictReadyMemberProofV1[],
  memberRecipes: readonly ServingRecipeIdentityV1[],
  servingRecipes: readonly ServingRecipeIdentityV1[],
  candidateRecipes: readonly CandidateRecipeIdentityV1[]
): Omit<ServingSnapshotValidationReceiptV1, 'receiptHash'> {
  return {
    schemaVersion: 1 as const,
    runId: input.runId,
    sessionId: input.sessionId,
    snapshotId: input.snapshotId,
    candidateDataManifestHash: input.candidateDataManifestHash,
    candidateCoverageReceiptHash: input.candidateCoverage.receiptHash,
    g3BindingSetHash: hashCanonicalJson(readyMembers.map((member) => member.bindingHash)),
    g4ReceiptHash: input.g4ReceiptHash,
    finalCoverageBindingHash: input.finalCoverage.receiptHash,
    servingRecipeIds: memberRecipes.map((member) => member.recipeId),
    servingRecipeFingerprints: memberRecipes.map((member) => member.authoredFingerprint),
    lifecycleConservationHash: hashCanonicalJson(
      readyMembers.map((member) => ({ recipeId: member.recipeId, lifecycle: member.lifecycle }))
    ),
    databaseConservationHash: hashCanonicalJson(
      readyMembers.map((member) => ({
        recipeId: member.recipeId,
        databaseRowHash: member.databaseRowHash,
        databaseReadbackHash: member.databaseReadbackHash,
      }))
    ),
    fileConservationHash: hashCanonicalJson(
      readyMembers.map((member) => ({
        recipeId: member.recipeId,
        fileHash: member.fileHash,
        fileReadbackHash: member.fileReadbackHash,
      }))
    ),
    refConservationHash: hashCanonicalJson(
      readyMembers.map((member) => ({
        recipeId: member.recipeId,
        refReconciliationReceiptHash: member.refReconciliationReceiptHash,
        refReadbackHash: member.refReadbackHash,
      }))
    ),
    coverageConservationHash: hashCanonicalJson({ candidateRecipes, servingRecipes }),
    sealedCorpusVerificationHash: input.sealedCorpusVerification.verificationHash,
    sparseEvidenceHash: input.sealedCorpusVerification.sparseEvidenceHash,
    vectorGenerationId: input.vectorGenerationId,
    vectorManifestHash: input.vectorManifestHash,
    vectorInspectionHash: input.sealedCorpusVerification.vectorInspectionHash,
    ...input.lineage,
    coreManifestSchemaVersion: input.coreManifestSchemaVersion,
    coreRouteSchemaVersion: input.coreRouteSchemaVersion,
    verdict: 'pass' as const,
    failedPredicate: null,
  };
}

function hashReceipt(value: { readonly receiptHash: string }): string {
  return hashCanonicalJson(withoutHash(value, 'receiptHash'));
}

function withoutHash<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const { [key]: _ignored, ...semantic } = value;
  return semantic;
}

function isCanonicalSha(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isCanonicalDigest(value: unknown): value is string {
  return typeof value === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/u.test(value);
}

function failServingSnapshotValidation(predicate: ServingSnapshotValidationPredicateV1): never {
  throw new Error(`STRICT_SERVING_SNAPSHOT_VALIDATION_FAILED:${predicate}`);
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeDeep(child);
    }
  }
  return value;
}

export function buildStrictCandidateCoverage(input: {
  readonly analysis: StrictAnalysisExecutionResultV1;
  readonly compiledPlan: CompiledColdStartPlanV2;
  readonly expressionSets: readonly StrictProducerExpressionSetV1[];
  readonly privateCorpus: StrictPrivateCorpusContentResultV1;
  readonly reviewerIdentity: ReviewerIdentityV1;
}): CandidateCoverageReceiptV1 {
  const bindingByCell = groupBy(input.privateCorpus.bindings, (binding) => binding.cellId);
  const setsByCell = expressionSetsByCell(input.expressionSets);
  const requiredCells = input.compiledPlan.universe.cells
    .filter((cell) => cell.status === 'eligible')
    .sort((left, right) => left.cellId.localeCompare(right.cellId));
  const reviewer = new InvestigatedEmptyReviewer({ identity: input.reviewerIdentity });
  return createCandidateCoverageReceiptV1({
    planBaselineHash: input.compiledPlan.schedule.baselineScheduleHash,
    finalExpandedScheduleHash: input.analysis.fixpoint.finalExpandedScheduleHash,
    analysisFixpointHash: input.analysis.fixpoint.fixpointHash,
    evidenceLedgerHash: hashCanonicalJson(
      input.analysis.facts.map((fact) => ({ factId: fact.factId, witnessIds: fact.witnessIds }))
    ),
    candidateDatabaseHash: input.privateCorpus.rootManifestHash,
    candidateFilesHash: hashCanonicalJson(
      input.privateCorpus.bindings.map((binding) => binding.bindingHash)
    ),
    requiredCellIds: requiredCells.map((cell) => cell.cellId),
    cells: requiredCells.map((cell) => {
      const cellId = cell.cellId;
      const bindings = bindingByCell.get(cellId) ?? [];
      const sets = setsByCell.get(cellId) ?? [];
      const lensBindingIds = input.compiledPlan.schedule.lensBindings
        .filter((binding) => binding.cellId === cellId)
        .map((binding) => binding.bindingId);
      if (bindings.length === 0) {
        const familyIds = new Set(
          input.compiledPlan.schedule.lensBindings
            .filter((binding) => binding.cellId === cellId)
            .flatMap((binding) => binding.factFamilyIds)
        );
        const obligations = input.compiledPlan.schedule.factHarvestObligations.filter(
          (obligation) =>
            obligation.canonicalSubjectRef === cell.scopeId &&
            familyIds.has(obligation.factFamilyId)
        );
        const obligationIds = obligations.map((obligation) => obligation.obligationId);
        const terminal = input.analysis.fixpoint.terminalObligations.filter((row) =>
          obligationIds.includes(row.obligationId)
        );
        const emptyDecision = reviewer.review({
          sourceRevisionVectorHash: input.compiledPlan.execution.sourceRevisionVectorHash,
          finalExpandedScheduleHash: input.analysis.fixpoint.finalExpandedScheduleHash,
          expectedObligationIds: obligationIds,
          terminalObligations: terminal.map((row) => ({
            obligationId: row.obligationId,
            disposition: row.disposition === 'matched' ? 'matched' : 'inspected-no-pattern',
            terminalReceiptId: row.terminalReceiptId,
          })),
          unresolvedHypothesisIds: [],
          suppressedExpressionIds: [],
          evidenceEntryIds: input.analysis.facts.flatMap((fact) => fact.witnessIds),
        });
        if (emptyDecision.verdict !== 'pass') {
          throw new Error(
            `STRICT_INVESTIGATED_EMPTY_REJECTED:${cellId}:${emptyDecision.reasonCode}`
          );
        }
        return {
          cellId,
          candidateDisposition: 'investigated-empty' as const,
          contentReadyRecipeIds: [],
          contentReadyRecipeFingerprints: [],
          productionBindingHashes: [],
          lensBindingIds,
          expressionSetReceiptIds: [],
          investigatedEmptyDecisionHash: emptyDecision.decisionHash,
        };
      }
      return {
        cellId,
        candidateDisposition: 'covered-by-content-ready-candidate' as const,
        contentReadyRecipeIds: bindings.map((binding) => binding.recipeId),
        contentReadyRecipeFingerprints: bindings.map((binding) => binding.authoredFingerprint),
        productionBindingHashes: bindings.map((binding) => binding.bindingHash),
        lensBindingIds,
        expressionSetReceiptIds: sets.map((set) => set.setId),
      };
    }),
  });
}

function groupBy<T, K>(values: readonly T[], key: (value: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const value of values) {
    const group = result.get(key(value)) ?? [];
    group.push(value);
    result.set(key(value), group);
  }
  return result;
}

function expressionSetsByCell(sets: readonly StrictProducerExpressionSetV1[]) {
  const result = new Map<string, StrictProducerExpressionSetV1[]>();
  for (const set of sets) {
    for (const proposal of set.proposals) {
      for (const moduleId of proposal.authored.scope.moduleIds) {
        for (const dimensionId of proposal.authored.scope.dimensionIds) {
          const cellId = `${moduleId}::${dimensionId}`;
          const rows = result.get(cellId) ?? [];
          if (!rows.includes(set)) {
            rows.push(set);
          }
          result.set(cellId, rows);
        }
      }
    }
  }
  return result;
}

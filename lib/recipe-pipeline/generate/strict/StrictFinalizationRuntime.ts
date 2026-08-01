import { createHash, randomUUID } from 'node:crypto';
import fsp, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { InvestigatedEmptyReviewer, type ReviewerIdentityV1 } from '@alembic/agent/evaluation';
import type { StrictProducerExpressionSetV1 } from '@alembic/agent/production';
import {
  type CandidateCoverageReceiptV1,
  createCandidateCoverageReceiptV1,
  createFinalCoverageBindingReceiptV1,
  createServingSnapshotManifestV1,
  createStrictPublicationMarkerV1,
  createStrictPublicationSnapshotIdV1,
  type FinalCoverageBindingReceiptV1,
  type PreparedPublicKnowledgeRouteV1,
  parseKnowledgeMarkdown,
  preparePublicKnowledgeRouteV1,
  type ServingSnapshotManifestV1,
  type StrictPublicationMarkerV1,
} from '@alembic/core/knowledge';
import type { CompiledColdStartPlanV2 } from '@alembic/core/plans';
import {
  createAgentSemanticDispositionReviewRequestV1,
  createProductionActorIdentityV1,
  hashKnowledgeDispositionProposalV1,
} from '@alembic/core/production';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import { createLocalVectorStore } from '@alembic/core/vector';
import {
  type PrivateCorpusRevisionExpectedContextV1,
  type PrivateCorpusRevisionInitReceiptV1,
  rehydratePrivateCorpusRevisionV1,
  type WorkspaceResolver,
} from '@alembic/core/workspace';
import {
  copyAndCheckpointStrictPublicDatabase,
  verifyStrictPublicDatabaseServingSet,
} from '../../../infrastructure/database/StrictResetDatabaseAdapter.js';
import type { StrictSemanticReviewSessionV1 } from '../../../service/semantic-review/StrictSemanticReviewRuntimeFactory.js';
import {
  resolveStrictAnalysisPublicLineageV1,
  type StrictAnalysisExecutionResultV1,
} from './StrictAnalysisRuntime.js';
import {
  assertNoSymlinkTraversal,
  confinedPath,
  STRICT_PUBLICATION_ACTIVE_FILE,
  STRICT_PUBLICATION_MARKER_FILE,
  STRICT_PUBLICATION_ROOT_RELATIVE_PATH,
} from './StrictAuthorization.js';
import {
  createStrictSemanticReviewEvidenceV1,
  executeStrictDispositionReviewV5,
  type StrictSemanticReviewCheckpointPortV1,
} from './StrictDispositionReviewRuntime.js';
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

/**
 * strict-test 只消费到私有 serving 校验为止。这里有意不包含 PreparedPublicKnowledgeRouteV1，
 * 避免测试 profile 即使在调用方失误时也获得 public route 的构造能力。
 */
export interface StrictPrivateFinalizationResultV1 {
  readonly candidateCoverage: CandidateCoverageReceiptV1;
  readonly candidateDataManifestHash: string;
  readonly finalCoverage: FinalCoverageBindingReceiptV1;
  readonly g4ReceiptHash: string;
  readonly servingSnapshotValidation: ServingSnapshotValidationReceiptV1;
  readonly servingManifest: ServingSnapshotManifestV1;
}

export interface StrictPublicDataFileV1 {
  readonly relativePath: string;
  readonly byteHash: string;
  readonly size: number;
}

export interface StrictPublicCandidateDataManifestV1 {
  readonly schemaVersion: 1;
  readonly sourceRevisionInitReceiptHash: string;
  readonly sourceRootManifestHash: string;
  readonly candidateCoverageReceiptHash: string;
  readonly activeRecipeIds: readonly string[];
  readonly readyMemberSetHash: string;
  readonly vectorGenerationId: string;
  readonly vectorManifestHash: string;
  readonly databaseIntegrity: 'ok';
  readonly foreignKeyViolationCount: 0;
  readonly files: readonly StrictPublicDataFileV1[];
  readonly manifestHash: string;
}

export interface StrictPublicServingDataReceiptV1 {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly candidateDataManifestHash: string;
  readonly candidateDataManifestFileHash: string;
  readonly dataFileCount: number;
  readonly receiptHash: string;
}

export interface StrictPublicServingBundleReceiptV1 {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly candidateDataManifestHash: string;
  readonly finalCoverageBindingHash: string;
  readonly servingSnapshotValidationHash: string;
  readonly servingSnapshotManifestHash: string;
  readonly metadataFilesHash: string;
  readonly receiptHash: string;
}

const PUBLIC_SNAPSHOTS_DIRECTORY = 'snapshots';
const PUBLIC_OPERATION_LOCK_FILE = 'operation.lock';
const CANDIDATE_DATA_MANIFEST_FILE = 'candidate-data-manifest.json';
const SERVING_COVERAGE_DATA_FILE = 'serving-coverage.json';
const FINAL_COVERAGE_FILE = 'final-coverage.json';
const SERVING_VALIDATION_FILE = 'serving-snapshot-validation.json';
const CANDIDATE_COVERAGE_FILE = 'candidate-coverage.json';
const G4_RECEIPT_FILE = 'g4-receipt.json';
const LINEAGE_FILE = 'lineage.json';
const SERVING_MANIFEST_FILE = 'manifest.json';

export function strictPublicationPaths(dataRoot: string, snapshotId?: string) {
  const publicationRoot = confinedPath(dataRoot, STRICT_PUBLICATION_ROOT_RELATIVE_PATH);
  const snapshotsRoot = path.join(publicationRoot, PUBLIC_SNAPSHOTS_DIRECTORY);
  const snapshotRoot = snapshotId ? path.join(snapshotsRoot, assertSnapshotId(snapshotId)) : null;
  return Object.freeze({
    activePath: path.join(publicationRoot, STRICT_PUBLICATION_ACTIVE_FILE),
    markerPath: path.join(publicationRoot, STRICT_PUBLICATION_MARKER_FILE),
    publicationRoot,
    snapshotsRoot,
    snapshotRoot,
  });
}

interface StrictPublicationOperationLockRecordV1 {
  readonly schemaVersion: 1;
  readonly ownerId: string;
  readonly ownerPid: number;
  readonly nonce: string;
  readonly runId: string;
  readonly acquiredAt: number;
}

export async function acquireStrictPublicationOperationLock(input: {
  readonly dataRoot: string;
  readonly ownerId: string;
  readonly runId: string;
}): Promise<{ close(): Promise<void> }> {
  const paths = strictPublicationPaths(input.dataRoot);
  await ensurePublicationDirectory(input.dataRoot, paths.publicationRoot);
  const lockPath = path.join(paths.publicationRoot, PUBLIC_OPERATION_LOCK_FILE);
  let handle: FileHandle | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await fsp.open(lockPath, 'wx', 0o600);
      break;
    } catch (error: unknown) {
      if (readCode(error) !== 'EEXIST') {
        throw error;
      }
      if (!(await reclaimDeadPublicationOperationLock(lockPath))) {
        throw new Error('STRICT_PUBLICATION_OPERATION_ACTIVE');
      }
    }
  }
  if (!handle) {
    throw new Error('STRICT_PUBLICATION_OPERATION_ACTIVE');
  }
  const record: StrictPublicationOperationLockRecordV1 = {
    schemaVersion: 1,
    ownerId: input.ownerId,
    ownerPid: process.pid,
    nonce: randomUUID(),
    runId: input.runId,
    acquiredAt: Date.now(),
  };
  const bytes = serializeJson(record);
  try {
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await fsp.rm(lockPath, { force: true }).catch(() => {});
    throw error;
  }
  let closed = false;
  return Object.freeze({
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await handle.close();
      try {
        if ((await fsp.readFile(lockPath, 'utf8')) === bytes) {
          await fsp.rm(lockPath);
          await syncDirectory(paths.publicationRoot);
        }
      } catch (error: unknown) {
        if (readCode(error) !== 'ENOENT') {
          throw error;
        }
      }
    },
  });
}

export async function preflightStrictPublicationMarker(input: {
  readonly allowMissingForPristineOperation: boolean;
  readonly dataRoot: string;
  readonly projectIdentityHash: string;
  readonly migrationBundleHash: string;
}): Promise<'present' | 'pristine-missing'> {
  const paths = strictPublicationPaths(input.dataRoot);
  await ensurePublicationDirectory(input.dataRoot, paths.publicationRoot);
  try {
    await verifyStrictPublicationMarker(input);
    return 'present';
  } catch (error: unknown) {
    if (!(error instanceof Error) || error.message !== 'STRICT_PUBLICATION_MARKER_MISSING') {
      throw error;
    }
  }
  const namespaceEntries = (await fsp.readdir(paths.publicationRoot)).filter(
    (entry) => entry !== PUBLIC_OPERATION_LOCK_FILE
  );
  if (!input.allowMissingForPristineOperation || namespaceEntries.length > 0) {
    throw new Error('STRICT_PUBLICATION_MARKER_MISSING');
  }
  return 'pristine-missing';
}

function requiredSnapshotRoot(dataRoot: string, snapshotId: string): string {
  const snapshotRoot = strictPublicationPaths(dataRoot, snapshotId).snapshotRoot;
  if (!snapshotRoot) {
    throw new Error('STRICT_PUBLICATION_SNAPSHOT_ROOT_MISSING');
  }
  return snapshotRoot;
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
  readonly candidateDataManifestHash: string;
  readonly snapshotId: string;
  readonly runId: string;
}): StrictFinalizationResultV1 {
  const privateFinalization = finalizeStrictPrivateCandidate(input);
  const lineage = servingValidationLineage(privateFinalization.servingSnapshotValidation);
  const preparedPublicRoute = preparePublicKnowledgeRouteV1({
    schemaVersion: 1,
    sessionId: input.runId,
    snapshotId: privateFinalization.servingSnapshotValidation.snapshotId,
    servingSnapshotManifestHash: privateFinalization.servingManifest.manifestHash,
    vectorGenerationId: input.privateCorpus.vectorGenerationId,
    vectorManifestHash: input.privateCorpus.vectorManifestHash,
    ...lineage,
    committedAt: input.committedAt,
  });
  if (
    preparedPublicRoute.route.schemaVersion !==
    privateFinalization.servingSnapshotValidation.coreRouteSchemaVersion
  ) {
    failServingSnapshotValidation('core-schema-conservation');
  }
  return Object.freeze({ ...privateFinalization, preparedPublicRoute });
}

export function finalizeStrictPrivateCandidate(input: {
  readonly analysis: StrictAnalysisExecutionResultV1;
  readonly certifiedProjectFactsHash: string;
  readonly compiledPlan: CompiledColdStartPlanV2;
  readonly planCognitionHash: string;
  readonly privateCorpus: StrictPrivateCorpusResultV1;
  readonly candidateCoverage: CandidateCoverageReceiptV1;
  readonly candidateDataManifestHash: string;
  readonly snapshotId: string;
  readonly runId: string;
}): StrictPrivateFinalizationResultV1 {
  const candidateCoverage = input.candidateCoverage;
  const candidateDataManifestHash = requireSha(input.candidateDataManifestHash);
  const snapshotId = assertSnapshotId(input.snapshotId);
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
  const hypothesisExpressionSetManifestHash = hashCanonicalJson(
    input.privateCorpus.hypothesisExpressionSetReceipts.map((receipt) => receipt.receiptHash)
  );
  const analysisLineage = resolveStrictAnalysisPublicLineageV1({
    analysis: input.analysis,
    baselineScheduleHash: input.compiledPlan.schedule.baselineScheduleHash,
  });
  const lineage: ServingSnapshotValidationLineageV1 = {
    certifiedProjectFactsHash: input.certifiedProjectFactsHash,
    sourceRevisionVectorHash: input.compiledPlan.execution.sourceRevisionVectorHash,
    planCognitionLineageHash: input.planCognitionHash,
    compiledPlanHash: input.compiledPlan.canonicalPlanHash,
    factQueryCatalogHash: input.compiledPlan.factQueryCatalog.catalogHash,
    requiredApplicabilityUniverseHash: input.compiledPlan.requiredFactApplicability.universeHash,
    baselineScheduleHash: input.compiledPlan.schedule.baselineScheduleHash,
    expansionLedgerHeadHash: analysisLineage.expansionLedgerHeadHash,
    finalExpandedScheduleHash: analysisLineage.finalExpandedScheduleHash,
    analysisFixpointHash: input.analysis.fixpoint.fixpointHash,
    hypothesisExpressionSetManifestHash,
    finalCodeFactGenerationManifestHash: analysisLineage.finalCodeFactGenerationManifestHash,
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
  return Object.freeze({
    candidateCoverage,
    candidateDataManifestHash,
    finalCoverage,
    g4ReceiptHash,
    servingSnapshotValidation,
    servingManifest,
  });
}

function servingValidationLineage(
  validation: ServingSnapshotValidationReceiptV1
): ServingSnapshotValidationLineageV1 {
  return {
    certifiedProjectFactsHash: validation.certifiedProjectFactsHash,
    sourceRevisionVectorHash: validation.sourceRevisionVectorHash,
    planCognitionLineageHash: validation.planCognitionLineageHash,
    compiledPlanHash: validation.compiledPlanHash,
    factQueryCatalogHash: validation.factQueryCatalogHash,
    requiredApplicabilityUniverseHash: validation.requiredApplicabilityUniverseHash,
    baselineScheduleHash: validation.baselineScheduleHash,
    expansionLedgerHeadHash: validation.expansionLedgerHeadHash,
    finalExpandedScheduleHash: validation.finalExpandedScheduleHash,
    analysisFixpointHash: validation.analysisFixpointHash,
    hypothesisExpressionSetManifestHash: validation.hypothesisExpressionSetManifestHash,
    finalCodeFactGenerationManifestHash: validation.finalCodeFactGenerationManifestHash,
  };
}

export async function installAndVerifyStrictPublicationMarker(input: {
  readonly dataRoot: string;
  readonly projectIdentityHash: string;
  readonly migrationBundleHash: string;
}): Promise<StrictPublicationMarkerV1> {
  const paths = strictPublicationPaths(input.dataRoot);
  await ensurePublicationDirectory(input.dataRoot, paths.publicationRoot);
  const marker = createStrictPublicationMarkerV1({
    mode: 'strict-v1',
    routeSchemaVersion: 1,
    projectIdentityHash: requireSha(input.projectIdentityHash),
    migrationBundleHash: requireSha(input.migrationBundleHash),
  });
  await writeStrictPublicationMarker(paths.markerPath, marker);
  await verifyStrictPublicationMarker(input);
  return marker;
}

export async function verifyStrictPublicationMarker(input: {
  readonly dataRoot: string;
  readonly projectIdentityHash: string;
  readonly migrationBundleHash: string;
}): Promise<StrictPublicationMarkerV1> {
  const paths = strictPublicationPaths(input.dataRoot);
  await assertNoSymlinkTraversal(input.dataRoot, paths.markerPath);
  const expected = createStrictPublicationMarkerV1({
    mode: 'strict-v1',
    routeSchemaVersion: 1,
    projectIdentityHash: requireSha(input.projectIdentityHash),
    migrationBundleHash: requireSha(input.migrationBundleHash),
  });
  let readback: Awaited<ReturnType<typeof readExactJson>>;
  try {
    await assertRegularFile(paths.markerPath, 'STRICT_PUBLICATION_MARKER_INVALID');
    readback = await readExactJson(paths.markerPath);
  } catch (error: unknown) {
    if (readCode(error) === 'ENOENT') {
      throw new Error('STRICT_PUBLICATION_MARKER_MISSING');
    }
    if (error instanceof SyntaxError) {
      throw new Error('STRICT_PUBLICATION_MARKER_CORRUPT');
    }
    throw error;
  }
  if (readback.bytes !== serializeJson(expected)) {
    throw new Error('STRICT_PUBLICATION_MARKER_BINDING_MISMATCH');
  }
  return expected;
}

export async function materializeStrictPublicServingData(input: {
  readonly baseResolver: WorkspaceResolver;
  readonly candidateCoverage: CandidateCoverageReceiptV1;
  readonly dataRoot: string;
  readonly excludedSnapshotId?: string;
  readonly privateCorpus: StrictPrivateCorpusResultV1;
  readonly revisionInitReceipt: PrivateCorpusRevisionInitReceiptV1;
  readonly expectedCurrentContext: PrivateCorpusRevisionExpectedContextV1;
  readonly projectIdentityHash: string;
  readonly migrationBundleHash: string;
  readonly servingConfig: {
    readonly loadHash: string;
    readonly sourceArtifactHash: string;
    readonly strictColdStart: Readonly<Record<string, number>>;
  };
}): Promise<StrictPublicServingDataReceiptV1> {
  await verifyStrictPublicationMarker(input);
  const paths = strictPublicationPaths(input.dataRoot);
  await ensurePublicationDirectory(input.dataRoot, paths.publicationRoot);
  await ensurePublicationDirectory(input.dataRoot, paths.snapshotsRoot);
  const stagingRoot = path.join(paths.publicationRoot, `.staging-${randomUUID()}`);
  const stagingDataRoot = path.join(stagingRoot, 'data');
  await fsp.mkdir(stagingDataRoot, { recursive: true, mode: 0o700 });
  try {
    const source = await resolveStrictPublicSource(
      input.baseResolver,
      input.revisionInitReceipt,
      input.expectedCurrentContext
    );
    await assembleStrictPublicData({
      candidateCoverage: input.candidateCoverage,
      source,
      stagingDataRoot,
      vectorGenerationId: input.privateCorpus.vectorGenerationId,
      vectorManifestHash: input.privateCorpus.vectorManifestHash,
      servingConfig: input.servingConfig,
    });
    const files = await collectRegularFiles(stagingDataRoot);
    const semantic = {
      schemaVersion: 1 as const,
      sourceRevisionInitReceiptHash: input.revisionInitReceipt.initReceiptHash,
      sourceRootManifestHash: input.privateCorpus.rootManifestHash,
      candidateCoverageReceiptHash: input.candidateCoverage.receiptHash,
      activeRecipeIds: [...input.privateCorpus.activeRecipeIds].sort(),
      readyMemberSetHash: hashCanonicalJson(
        input.privateCorpus.readyMembers.map((member) => member.proofHash).sort()
      ),
      vectorGenerationId: input.privateCorpus.vectorGenerationId,
      vectorManifestHash: input.privateCorpus.vectorManifestHash,
      databaseIntegrity: 'ok' as const,
      foreignKeyViolationCount: 0 as const,
      files,
    };
    const manifest: StrictPublicCandidateDataManifestV1 = Object.freeze({
      ...semantic,
      manifestHash: hashCanonicalJson(semantic),
    });
    await writeAppendOnlyJson(path.join(stagingDataRoot, CANDIDATE_DATA_MANIFEST_FILE), manifest);
    await sealDataTree(stagingDataRoot);
    const snapshotId = await publishSealedDataDirectory({
      candidateDataManifestHash: manifest.manifestHash,
      dataRoot: input.dataRoot,
      excludedSnapshotId: input.excludedSnapshotId,
      manifest,
      paths,
      stagingRoot,
    });
    const manifestPath = path.join(
      requiredSnapshotRoot(input.dataRoot, snapshotId),
      'data',
      CANDIDATE_DATA_MANIFEST_FILE
    );
    const receiptSemantic = {
      schemaVersion: 1 as const,
      snapshotId,
      candidateDataManifestHash: manifest.manifestHash,
      candidateDataManifestFileHash: await hashFile(manifestPath),
      dataFileCount: manifest.files.length,
    };
    const receipt = Object.freeze({
      ...receiptSemantic,
      receiptHash: hashCanonicalJson(receiptSemantic),
    });
    await verifyStrictPublicServingData({
      candidateCoverage: input.candidateCoverage,
      dataRoot: input.dataRoot,
      privateCorpus: input.privateCorpus,
      receipt,
    });
    return receipt;
  } catch (error: unknown) {
    await fsp.rm(stagingRoot, { force: true, recursive: true });
    throw error;
  }
}

export async function verifyStrictPublicServingData(input: {
  readonly candidateCoverage: CandidateCoverageReceiptV1;
  readonly dataRoot: string;
  readonly privateCorpus: StrictPrivateCorpusResultV1;
  readonly receipt: StrictPublicServingDataReceiptV1;
}): Promise<StrictPublicCandidateDataManifestV1> {
  assertSnapshotId(input.receipt.snapshotId);
  const receiptSemantic = {
    schemaVersion: 1 as const,
    snapshotId: input.receipt.snapshotId,
    candidateDataManifestHash: input.receipt.candidateDataManifestHash,
    candidateDataManifestFileHash: input.receipt.candidateDataManifestFileHash,
    dataFileCount: input.receipt.dataFileCount,
  };
  if (hashCanonicalJson(receiptSemantic) !== input.receipt.receiptHash) {
    throw new Error('STRICT_PUBLIC_DATA_RECEIPT_HASH_MISMATCH');
  }
  const snapshotRoot = requiredSnapshotRoot(input.dataRoot, input.receipt.snapshotId);
  await assertNoSymlinkTraversal(input.dataRoot, snapshotRoot);
  const dataRoot = path.join(snapshotRoot, 'data');
  const manifestPath = path.join(dataRoot, CANDIDATE_DATA_MANIFEST_FILE);
  let manifestReadback: Awaited<ReturnType<typeof readExactJson>>;
  try {
    manifestReadback = await readExactJson(manifestPath);
  } catch (error: unknown) {
    if (readCode(error) === 'ENOENT') {
      throw new Error('STRICT_PUBLIC_DATA_MANIFEST_MISSING');
    }
    throw error;
  }
  const manifest = parseCandidateDataManifest(manifestReadback.value);
  if (
    manifest.sourceRevisionInitReceiptHash !==
      input.privateCorpus.revisionInitReceipt.initReceiptHash ||
    manifest.sourceRootManifestHash !== input.privateCorpus.rootManifestHash ||
    manifest.candidateCoverageReceiptHash !== input.candidateCoverage.receiptHash ||
    JSON.stringify(manifest.activeRecipeIds) !==
      JSON.stringify([...input.privateCorpus.activeRecipeIds].sort()) ||
    manifest.readyMemberSetHash !==
      hashCanonicalJson(
        input.privateCorpus.readyMembers.map((member) => member.proofHash).sort()
      ) ||
    manifest.vectorGenerationId !== input.privateCorpus.vectorGenerationId ||
    manifest.vectorManifestHash !== input.privateCorpus.vectorManifestHash
  ) {
    throw new Error('STRICT_PUBLIC_DATA_PRIVATE_SOURCE_BINDING_MISMATCH');
  }
  const coverageReadback = await readExactJson(path.join(dataRoot, SERVING_COVERAGE_DATA_FILE));
  if (coverageReadback.bytes !== serializeJson(input.candidateCoverage)) {
    throw new Error('STRICT_PUBLIC_DATA_COVERAGE_BINDING_MISMATCH');
  }
  if (
    manifest.manifestHash !== input.receipt.candidateDataManifestHash ||
    (await hashFile(manifestPath)) !== input.receipt.candidateDataManifestFileHash ||
    manifest.files.length !== input.receipt.dataFileCount
  ) {
    throw new Error('STRICT_PUBLIC_DATA_MANIFEST_BINDING_MISMATCH');
  }
  const actualFiles = await collectRegularFiles(dataRoot, CANDIDATE_DATA_MANIFEST_FILE);
  if (JSON.stringify(actualFiles) !== JSON.stringify(manifest.files)) {
    throw new Error('STRICT_PUBLIC_DATA_FILE_HASH_MISMATCH');
  }
  const databasePath = path.join(dataRoot, '.asd', 'alembic.db');
  await verifyStrictPublicPhysicalServingSet({
    activeRecipeIds: manifest.activeRecipeIds,
    dataRoot,
    databasePath,
    vectorGenerationId: manifest.vectorGenerationId,
    vectorManifestHash: manifest.vectorManifestHash,
  });
  return manifest;
}

export async function persistAndVerifyStrictPublicServingBundle(input: {
  readonly dataRoot: string;
  readonly dataReceipt: StrictPublicServingDataReceiptV1;
  readonly finalization: StrictFinalizationResultV1;
  readonly privateCorpus: StrictPrivateCorpusResultV1;
}): Promise<StrictPublicServingBundleReceiptV1> {
  await verifyStrictPublicServingData({
    candidateCoverage: input.finalization.candidateCoverage,
    dataRoot: input.dataRoot,
    privateCorpus: input.privateCorpus,
    receipt: input.dataReceipt,
  });
  if (
    input.finalization.candidateDataManifestHash !== input.dataReceipt.candidateDataManifestHash ||
    input.finalization.servingManifest.snapshotId !== input.dataReceipt.snapshotId
  ) {
    throw new Error('STRICT_PUBLIC_BUNDLE_FINALIZATION_BINDING_MISMATCH');
  }
  const snapshotRoot = requiredSnapshotRoot(input.dataRoot, input.dataReceipt.snapshotId);
  const metadata = buildStrictPublicMetadata(input.finalization, input.privateCorpus);
  for (const [fileName, value] of metadata) {
    await writeAppendOnlyJson(path.join(snapshotRoot, fileName), value);
  }
  const verified = await verifyMetadataFiles(snapshotRoot, metadata);
  const semantic = {
    schemaVersion: 1 as const,
    snapshotId: input.dataReceipt.snapshotId,
    candidateDataManifestHash: input.dataReceipt.candidateDataManifestHash,
    finalCoverageBindingHash: input.finalization.finalCoverage.receiptHash,
    servingSnapshotValidationHash: input.finalization.servingSnapshotValidation.receiptHash,
    servingSnapshotManifestHash: input.finalization.servingManifest.manifestHash,
    metadataFilesHash: hashCanonicalJson(verified),
  };
  const receipt = Object.freeze({ ...semantic, receiptHash: hashCanonicalJson(semantic) });
  await sealMetadataFiles(snapshotRoot, metadata);
  await fsp.chmod(snapshotRoot, 0o555);
  await verifyStrictPublicServingBundle({
    dataRoot: input.dataRoot,
    dataReceipt: input.dataReceipt,
    finalization: input.finalization,
    privateCorpus: input.privateCorpus,
    receipt,
  });
  return receipt;
}

export async function verifyStrictPublicServingBundle(input: {
  readonly dataRoot: string;
  readonly dataReceipt: StrictPublicServingDataReceiptV1;
  readonly finalization: StrictFinalizationResultV1;
  readonly privateCorpus: StrictPrivateCorpusResultV1;
  readonly receipt: StrictPublicServingBundleReceiptV1;
}): Promise<void> {
  await verifyStrictPublicServingData({
    candidateCoverage: input.finalization.candidateCoverage,
    dataRoot: input.dataRoot,
    privateCorpus: input.privateCorpus,
    receipt: input.dataReceipt,
  });
  const semantic = {
    schemaVersion: 1 as const,
    snapshotId: input.receipt.snapshotId,
    candidateDataManifestHash: input.receipt.candidateDataManifestHash,
    finalCoverageBindingHash: input.receipt.finalCoverageBindingHash,
    servingSnapshotValidationHash: input.receipt.servingSnapshotValidationHash,
    servingSnapshotManifestHash: input.receipt.servingSnapshotManifestHash,
    metadataFilesHash: input.receipt.metadataFilesHash,
  };
  if (
    hashCanonicalJson(semantic) !== input.receipt.receiptHash ||
    input.receipt.snapshotId !== input.dataReceipt.snapshotId ||
    input.receipt.candidateDataManifestHash !== input.dataReceipt.candidateDataManifestHash ||
    input.receipt.finalCoverageBindingHash !== input.finalization.finalCoverage.receiptHash ||
    input.receipt.servingSnapshotValidationHash !==
      input.finalization.servingSnapshotValidation.receiptHash ||
    input.receipt.servingSnapshotManifestHash !== input.finalization.servingManifest.manifestHash
  ) {
    throw new Error('STRICT_PUBLIC_BUNDLE_RECEIPT_BINDING_MISMATCH');
  }
  const snapshotRoot = requiredSnapshotRoot(input.dataRoot, input.receipt.snapshotId);
  const verified = await verifyMetadataFiles(
    snapshotRoot,
    buildStrictPublicMetadata(input.finalization, input.privateCorpus)
  );
  if (hashCanonicalJson(verified) !== input.receipt.metadataFilesHash) {
    throw new Error('STRICT_PUBLIC_BUNDLE_METADATA_HASH_MISMATCH');
  }
}

async function resolveStrictPublicSource(
  baseResolver: WorkspaceResolver,
  receipt: PrivateCorpusRevisionInitReceiptV1,
  expectedCurrentContext: PrivateCorpusRevisionExpectedContextV1
) {
  const rehydrated = await rehydratePrivateCorpusRevisionV1(
    baseResolver,
    receipt,
    expectedCurrentContext
  );
  try {
    return Object.freeze({
      databasePath: rehydrated.handle.resolver.databasePath,
      dataRoot: rehydrated.handle.resolver.dataRoot,
      recipesDir: rehydrated.handle.resolver.recipesDir,
    });
  } finally {
    rehydrated.runtime.close();
  }
}

async function assembleStrictPublicData(input: {
  readonly candidateCoverage: CandidateCoverageReceiptV1;
  readonly source: {
    readonly databasePath: string;
    readonly dataRoot: string;
    readonly recipesDir: string;
  };
  readonly stagingDataRoot: string;
  readonly vectorGenerationId: string;
  readonly vectorManifestHash: string;
  readonly servingConfig: {
    readonly loadHash: string;
    readonly sourceArtifactHash: string;
    readonly strictColdStart: Readonly<Record<string, number>>;
  };
}): Promise<void> {
  const targetDatabase = path.join(input.stagingDataRoot, '.asd', 'alembic.db');
  await fsp.mkdir(path.dirname(targetDatabase), { recursive: true });
  await copyAndCheckpointStrictPublicDatabase({
    sourcePath: input.source.databasePath,
    targetPath: targetDatabase,
  });
  await copyRegularTree(
    input.source.recipesDir,
    path.join(input.stagingDataRoot, 'Alembic', 'recipes')
  );
  const sourceContext = path.join(input.source.dataRoot, '.asd', 'context');
  const activePath = path.join(sourceContext, 'recipe-vector-active.json');
  const active = (await readExactJson(activePath)).value as {
    generationId?: unknown;
    manifestHash?: unknown;
  };
  if (
    active.generationId !== input.vectorGenerationId ||
    active.manifestHash !== input.vectorManifestHash
  ) {
    throw new Error('STRICT_PUBLIC_VECTOR_ACTIVE_BINDING_MISMATCH');
  }
  const sourceGeneration = path.join(
    sourceContext,
    'recipe-vector-generations',
    safeSegment(input.vectorGenerationId)
  );
  const targetContext = path.join(input.stagingDataRoot, '.asd', 'context');
  await copyRegularTree(
    sourceGeneration,
    path.join(targetContext, 'recipe-vector-generations', input.vectorGenerationId)
  );
  await copyRegularFile(activePath, path.join(targetContext, 'recipe-vector-active.json'));
  const copiedManifest = (
    await readExactJson(
      path.join(
        targetContext,
        'recipe-vector-generations',
        input.vectorGenerationId,
        'manifest.json'
      )
    )
  ).value as { manifestHash?: unknown };
  if (copiedManifest.manifestHash !== input.vectorManifestHash) {
    throw new Error('STRICT_PUBLIC_VECTOR_MANIFEST_BINDING_MISMATCH');
  }
  const servingConfig = Object.freeze({
    schemaVersion: 1 as const,
    kind: 'strict-public-serving-config' as const,
    sourceArtifactHash: requireSha(input.servingConfig.sourceArtifactHash),
    loadHash: requireSha(input.servingConfig.loadHash),
    strictColdStart: input.servingConfig.strictColdStart,
  });
  await writeAppendOnlyJson(path.join(input.stagingDataRoot, '.asd', 'config.json'), servingConfig);
  await writeAppendOnlyJson(
    path.join(input.stagingDataRoot, SERVING_COVERAGE_DATA_FILE),
    input.candidateCoverage
  );
}

async function verifyStrictPublicPhysicalServingSet(input: {
  readonly activeRecipeIds: readonly string[];
  readonly dataRoot: string;
  readonly databasePath: string;
  readonly vectorGenerationId: string;
  readonly vectorManifestHash: string;
}): Promise<void> {
  const expectedRecipeIds = [...input.activeRecipeIds].sort();
  verifyStrictPublicDatabaseServingSet({
    activeRecipeIds: expectedRecipeIds,
    databasePath: input.databasePath,
  });
  await verifyStrictPublicRecipeFileSet(input.dataRoot, expectedRecipeIds);
  await verifyStrictPublicVectorSet(input, expectedRecipeIds);
}

async function verifyStrictPublicRecipeFileSet(
  dataRoot: string,
  expectedRecipeIds: readonly string[]
): Promise<void> {
  const recipesRoot = path.join(dataRoot, 'Alembic', 'recipes');
  const recipeFiles = await collectRegularFiles(recipesRoot);
  const parsedRecipeIds: string[] = [];
  for (const file of recipeFiles) {
    if (!file.relativePath.endsWith('.md')) {
      throw new Error('STRICT_PUBLIC_RECIPE_FILE_SET_MISMATCH');
    }
    const parsed = parseKnowledgeMarkdown(
      await fsp.readFile(path.join(recipesRoot, file.relativePath), 'utf8')
    );
    if (parsed.lifecycle !== 'active' || typeof parsed.id !== 'string') {
      throw new Error('STRICT_PUBLIC_RECIPE_FILE_SET_MISMATCH');
    }
    parsedRecipeIds.push(parsed.id);
  }
  if (JSON.stringify(parsedRecipeIds.sort()) !== JSON.stringify(expectedRecipeIds)) {
    throw new Error('STRICT_PUBLIC_RECIPE_FILE_SET_MISMATCH');
  }
}

async function verifyStrictPublicVectorSet(
  input: {
    readonly dataRoot: string;
    readonly vectorGenerationId: string;
    readonly vectorManifestHash: string;
  },
  expectedRecipeIds: readonly string[]
): Promise<void> {
  const generationRoot = path.join(
    input.dataRoot,
    '.asd',
    'context',
    'recipe-vector-generations',
    safeSegment(input.vectorGenerationId)
  );
  const manifestValue = (await readExactJson(path.join(generationRoot, 'manifest.json'))).value;
  if (!isRecord(manifestValue)) {
    throw new Error('STRICT_PUBLIC_VECTOR_MANIFEST_INVALID');
  }
  const expectedIdsByRecipe = manifestValue.expectedIdsByRecipe;
  const expectedVectorIds = manifestValue.expectedIds;
  if (
    manifestValue.generationId !== input.vectorGenerationId ||
    manifestValue.manifestHash !== input.vectorManifestHash ||
    manifestValue.status !== 'ready' ||
    manifestValue.recipeCount !== expectedRecipeIds.length ||
    !Array.isArray(expectedVectorIds) ||
    !expectedVectorIds.every((id) => typeof id === 'string') ||
    !isRecord(expectedIdsByRecipe) ||
    JSON.stringify(Object.keys(expectedIdsByRecipe).sort()) !== JSON.stringify(expectedRecipeIds) ||
    Object.values(expectedIdsByRecipe).some(
      (ids) => !Array.isArray(ids) || !ids.every((id) => typeof id === 'string')
    ) ||
    Number(manifestValue.documentCount) !== expectedVectorIds.length
  ) {
    throw new Error('STRICT_PUBLIC_VECTOR_MANIFEST_BINDING_MISMATCH');
  }
  const vectorStore = await createLocalVectorStore(path.join(generationRoot, 'store'), {
    kind: 'json',
  });
  const listedVectorIds = (await vectorStore.listIds()).sort();
  if (JSON.stringify(listedVectorIds) !== JSON.stringify([...expectedVectorIds].sort())) {
    throw new Error('STRICT_PUBLIC_VECTOR_STORE_SET_MISMATCH');
  }
  const activeRecipeIds = new Set(expectedRecipeIds);
  for (const vectorId of listedVectorIds) {
    const item = await vectorStore.getById(vectorId);
    if (
      !item ||
      !isRecord(item.metadata) ||
      typeof item.metadata.recipeId !== 'string' ||
      !activeRecipeIds.has(item.metadata.recipeId)
    ) {
      throw new Error('STRICT_PUBLIC_VECTOR_STORE_SET_MISMATCH');
    }
  }
}

async function publishSealedDataDirectory(input: {
  readonly candidateDataManifestHash: string;
  readonly dataRoot: string;
  readonly excludedSnapshotId?: string;
  readonly manifest: StrictPublicCandidateDataManifestV1;
  readonly paths: ReturnType<typeof strictPublicationPaths>;
  readonly stagingRoot: string;
}): Promise<string> {
  let snapshotId = assertSnapshotId(
    createStrictPublicationSnapshotIdV1(input.candidateDataManifestHash)
  );
  let snapshotRoot = requiredSnapshotRoot(input.dataRoot, snapshotId);
  if (await pathExists(snapshotRoot)) {
    if (
      snapshotId !== input.excludedSnapshotId &&
      (await existingDataMatches(snapshotRoot, input.manifest))
    ) {
      await fsp.rm(input.stagingRoot, { force: true, recursive: true });
      return snapshotId;
    }
    snapshotId = assertSnapshotId(
      createStrictPublicationSnapshotIdV1(input.candidateDataManifestHash, randomUUID())
    );
    snapshotRoot = requiredSnapshotRoot(input.dataRoot, snapshotId);
  }
  try {
    await fsp.rename(input.stagingRoot, snapshotRoot);
  } catch (error: unknown) {
    if (!['EEXIST', 'ENOTEMPTY'].includes(readCode(error) ?? '')) {
      throw error;
    }
    if (await existingDataMatches(snapshotRoot, input.manifest)) {
      await fsp.rm(input.stagingRoot, { force: true, recursive: true });
      return snapshotId;
    }
    snapshotId = assertSnapshotId(
      createStrictPublicationSnapshotIdV1(input.candidateDataManifestHash, randomUUID())
    );
    snapshotRoot = requiredSnapshotRoot(input.dataRoot, snapshotId);
    await fsp.rename(input.stagingRoot, snapshotRoot);
  }
  await syncDirectory(input.paths.snapshotsRoot);
  return snapshotId;
}

async function existingDataMatches(
  snapshotRoot: string,
  expected: StrictPublicCandidateDataManifestV1
): Promise<boolean> {
  try {
    const readback = await readExactJson(
      path.join(snapshotRoot, 'data', CANDIDATE_DATA_MANIFEST_FILE)
    );
    return (
      readback.bytes === serializeJson(expected) &&
      JSON.stringify(
        await collectRegularFiles(path.join(snapshotRoot, 'data'), CANDIDATE_DATA_MANIFEST_FILE)
      ) === JSON.stringify(expected.files)
    );
  } catch {
    return false;
  }
}

function buildStrictPublicMetadata(
  finalization: StrictFinalizationResultV1,
  privateCorpus: StrictPrivateCorpusResultV1
): ReadonlyArray<readonly [string, unknown]> {
  const lineage = Object.freeze({
    schemaVersion: 1 as const,
    sourceRevisionInitReceiptHash: privateCorpus.revisionInitReceipt.initReceiptHash,
    sourceRootManifestHash: privateCorpus.rootManifestHash,
    sealedCorpusVerificationHash: privateCorpus.sealedCorpusVerification.verificationHash,
    readyMemberSetHash: hashCanonicalJson(
      privateCorpus.readyMembers.map((row) => row.proofHash).sort()
    ),
    vectorGenerationId: privateCorpus.vectorGenerationId,
    vectorManifestHash: privateCorpus.vectorManifestHash,
    expansionLedgerHeadHash: finalization.servingSnapshotValidation.expansionLedgerHeadHash,
    finalExpandedScheduleHash: finalization.servingSnapshotValidation.finalExpandedScheduleHash,
    hypothesisExpressionSetManifestHash:
      finalization.servingSnapshotValidation.hypothesisExpressionSetManifestHash,
    finalCodeFactGenerationManifestHash:
      finalization.servingSnapshotValidation.finalCodeFactGenerationManifestHash,
  });
  return Object.freeze([
    [CANDIDATE_COVERAGE_FILE, finalization.candidateCoverage],
    [
      G4_RECEIPT_FILE,
      Object.freeze({
        schemaVersion: 1 as const,
        gate: 'G4' as const,
        verdict: 'pass' as const,
        candidateDataManifestHash: finalization.candidateDataManifestHash,
        g4ReceiptHash: finalization.g4ReceiptHash,
      }),
    ],
    [FINAL_COVERAGE_FILE, finalization.finalCoverage],
    [SERVING_VALIDATION_FILE, finalization.servingSnapshotValidation],
    [LINEAGE_FILE, lineage],
    [SERVING_MANIFEST_FILE, finalization.servingManifest],
  ] as const);
}

async function verifyMetadataFiles(
  snapshotRoot: string,
  metadata: ReadonlyArray<readonly [string, unknown]>
): Promise<readonly { readonly relativePath: string; readonly byteHash: string }[]> {
  const verified: Array<{ relativePath: string; byteHash: string }> = [];
  for (const [fileName, expected] of metadata) {
    const filePath = path.join(snapshotRoot, fileName);
    await assertRegularFile(filePath, `STRICT_PUBLIC_BUNDLE_METADATA_INVALID:${fileName}`);
    const readback = await readExactJson(filePath);
    if (readback.bytes !== serializeJson(expected)) {
      throw new Error(`STRICT_PUBLIC_BUNDLE_METADATA_DIVERGENCE:${fileName}`);
    }
    verified.push({ relativePath: fileName, byteHash: await hashFile(filePath) });
  }
  return Object.freeze(verified);
}

async function sealMetadataFiles(
  snapshotRoot: string,
  metadata: ReadonlyArray<readonly [string, unknown]>
): Promise<void> {
  for (const [fileName] of metadata) {
    await fsp.chmod(path.join(snapshotRoot, fileName), 0o444);
  }
  await syncDirectory(snapshotRoot);
}

function parseCandidateDataManifest(value: unknown): StrictPublicCandidateDataManifestV1 {
  if (!isRecord(value) || !Array.isArray(value.files)) {
    throw new Error('STRICT_PUBLIC_DATA_MANIFEST_INVALID');
  }
  const { manifestHash, ...semantic } = value;
  if (
    value.schemaVersion !== 1 ||
    !isSha(manifestHash) ||
    !isSha(value.sourceRevisionInitReceiptHash) ||
    !isSha(value.sourceRootManifestHash) ||
    !isSha(value.candidateCoverageReceiptHash) ||
    !Array.isArray(value.activeRecipeIds) ||
    !value.activeRecipeIds.every((recipeId) => typeof recipeId === 'string') ||
    !isSha(value.readyMemberSetHash) ||
    typeof value.vectorGenerationId !== 'string' ||
    !isCanonicalDigest(value.vectorManifestHash) ||
    value.databaseIntegrity !== 'ok' ||
    value.foreignKeyViolationCount !== 0 ||
    hashCanonicalJson(semantic) !== manifestHash ||
    !value.files.every(isStrictPublicDataFile)
  ) {
    throw new Error('STRICT_PUBLIC_DATA_MANIFEST_INVALID');
  }
  return value as unknown as StrictPublicCandidateDataManifestV1;
}

function isStrictPublicDataFile(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.relativePath === 'string' &&
    isSha(value.byteHash) &&
    Number.isSafeInteger(value.size) &&
    Number(value.size) >= 0
  );
}

async function collectRegularFiles(
  root: string,
  excludedRelativePath?: string
): Promise<StrictPublicDataFileV1[]> {
  const files: StrictPublicDataFileV1[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(directory, entry.name);
      const relativePath = path.relative(root, target).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        throw new Error('STRICT_PUBLIC_BUNDLE_SYMLINK_FORBIDDEN');
      }
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile()) {
        if (relativePath !== excludedRelativePath) {
          const stat = await fsp.stat(target);
          files.push({ relativePath, byteHash: await hashFile(target), size: stat.size });
        }
      } else {
        throw new Error('STRICT_PUBLIC_BUNDLE_SPECIAL_FILE_FORBIDDEN');
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function copyRegularTree(source: string, target: string): Promise<void> {
  const stat = await fsp.lstat(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('STRICT_PUBLIC_SOURCE_DIRECTORY_INVALID');
  }
  await fsp.mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of await fsp.readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error('STRICT_PUBLIC_SOURCE_SYMLINK_FORBIDDEN');
    }
    if (entry.isDirectory()) {
      await copyRegularTree(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await copyRegularFile(sourcePath, targetPath);
    } else {
      throw new Error('STRICT_PUBLIC_SOURCE_SPECIAL_FILE_FORBIDDEN');
    }
  }
}

async function copyRegularFile(source: string, target: string): Promise<void> {
  const stat = await fsp.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('STRICT_PUBLIC_SOURCE_FILE_INVALID');
  }
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const handle = await fsp.open(target, 'wx', 0o600);
  try {
    await handle.writeFile(await fsp.readFile(source));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function sealDataTree(root: string): Promise<void> {
  const directories: string[] = [];
  async function visit(directory: string): Promise<void> {
    directories.push(directory);
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error('STRICT_PUBLIC_BUNDLE_SYMLINK_FORBIDDEN');
      }
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile()) {
        await fsp.chmod(target, 0o444);
      } else {
        throw new Error('STRICT_PUBLIC_BUNDLE_SPECIAL_FILE_FORBIDDEN');
      }
    }
  }
  await visit(root);
  for (const directory of directories.reverse()) {
    await syncDirectory(directory);
    await fsp.chmod(directory, 0o555);
  }
}

async function writeAppendOnlyJson(filePath: string, value: unknown): Promise<void> {
  const bytes = serializeJson(value);
  try {
    await assertRegularFile(filePath, 'STRICT_PUBLICATION_APPEND_ONLY_INVALID');
    if ((await fsp.readFile(filePath, 'utf8')) === bytes) {
      return;
    }
    throw new Error('STRICT_PUBLICATION_APPEND_ONLY_CONFLICT');
  } catch (error: unknown) {
    if (readCode(error) !== 'ENOENT') {
      throw error;
    }
  }
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${randomUUID()}`;
  const handle = await fsp.open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fsp.link(tempPath, filePath);
  } catch (error: unknown) {
    if (readCode(error) !== 'EEXIST' || (await fsp.readFile(filePath, 'utf8')) !== bytes) {
      throw new Error('STRICT_PUBLICATION_APPEND_ONLY_CONFLICT');
    }
  } finally {
    await fsp.rm(tempPath, { force: true });
  }
  await syncDirectory(path.dirname(filePath));
  if ((await fsp.readFile(filePath, 'utf8')) !== bytes) {
    throw new Error('STRICT_PUBLICATION_READBACK_DIVERGENCE');
  }
}

async function writeStrictPublicationMarker(filePath: string, value: unknown): Promise<void> {
  const bytes = serializeJson(value);
  try {
    await assertRegularFile(filePath, 'STRICT_PUBLICATION_MARKER_INVALID');
    if ((await fsp.readFile(filePath, 'utf8')) === bytes) {
      return;
    }
    throw new Error('STRICT_PUBLICATION_MARKER_BINDING_MISMATCH');
  } catch (error: unknown) {
    if (readCode(error) !== 'ENOENT') {
      throw error;
    }
  }
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${randomUUID()}`;
  const handle = await fsp.open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fsp.rename(tempPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await fsp.rm(tempPath, { force: true });
  }
  await assertRegularFile(filePath, 'STRICT_PUBLICATION_MARKER_INVALID');
  if ((await fsp.readFile(filePath, 'utf8')) !== bytes) {
    throw new Error('STRICT_PUBLICATION_READBACK_DIVERGENCE');
  }
  await fsp.chmod(filePath, 0o444);
  const durableMarker = await fsp.open(filePath, 'r');
  try {
    await durableMarker.sync();
  } finally {
    await durableMarker.close();
  }
  await syncDirectory(path.dirname(filePath));
}

async function ensurePublicationDirectory(dataRoot: string, directory: string): Promise<void> {
  await assertNoSymlinkTraversal(dataRoot, directory);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await assertNoSymlinkTraversal(dataRoot, directory);
  const [rootReal, directoryReal] = await Promise.all([
    fsp.realpath(dataRoot),
    fsp.realpath(directory),
  ]);
  if (directoryReal !== rootReal && !directoryReal.startsWith(`${rootReal}${path.sep}`)) {
    throw new Error('STRICT_PUBLICATION_REALPATH_ESCAPE');
  }
}

async function readExactJson(
  filePath: string
): Promise<{ readonly bytes: string; readonly value: unknown }> {
  await assertRegularFile(filePath, 'STRICT_PUBLICATION_FILE_INVALID');
  const bytes = await fsp.readFile(filePath, 'utf8');
  return { bytes, value: JSON.parse(bytes) as unknown };
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function hashFile(filePath: string): Promise<string> {
  await assertRegularFile(filePath, 'STRICT_PUBLICATION_FILE_INVALID');
  return `sha256:${createHash('sha256')
    .update(await fsp.readFile(filePath))
    .digest('hex')}`;
}

async function assertRegularFile(filePath: string, errorCode: string): Promise<void> {
  const stat = await fsp.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(errorCode);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fsp.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertSnapshotId(value: string): string {
  if (!/^snapshot-[a-f0-9]{64}(?:-[a-f0-9-]{36})?$/u.test(value)) {
    throw new Error('STRICT_PUBLICATION_SNAPSHOT_ID_INVALID');
  }
  return value;
}

function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value)) {
    throw new Error('STRICT_PUBLICATION_SEGMENT_INVALID');
  }
  return value;
}

function requireSha(value: string): string {
  if (!isSha(value)) {
    throw new Error('STRICT_PUBLICATION_HASH_INVALID');
  }
  return value;
}

function isSha(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function reclaimDeadPublicationOperationLock(lockPath: string): Promise<boolean> {
  let raw: string;
  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    [raw, stat] = await Promise.all([fsp.readFile(lockPath, 'utf8'), fsp.stat(lockPath)]);
  } catch (error: unknown) {
    if (readCode(error) === 'ENOENT') {
      return true;
    }
    throw error;
  }
  const record = parsePublicationOperationLock(raw);
  if (!record || isProcessAlive(record.ownerPid)) {
    return false;
  }
  try {
    const [latestRaw, latestStat] = await Promise.all([
      fsp.readFile(lockPath, 'utf8'),
      fsp.stat(lockPath),
    ]);
    if (latestRaw !== raw || latestStat.ino !== stat.ino || latestStat.mtimeMs !== stat.mtimeMs) {
      return false;
    }
    await fsp.rm(lockPath);
    return true;
  } catch (error: unknown) {
    if (readCode(error) === 'ENOENT') {
      return true;
    }
    throw error;
  }
}

function parsePublicationOperationLock(raw: string): StrictPublicationOperationLockRecordV1 | null {
  try {
    const value = JSON.parse(raw) as Partial<StrictPublicationOperationLockRecordV1>;
    return value.schemaVersion === 1 &&
      typeof value.ownerId === 'string' &&
      Number.isSafeInteger(value.ownerPid) &&
      Number(value.ownerPid) > 0 &&
      typeof value.nonce === 'string' &&
      typeof value.runId === 'string' &&
      Number.isFinite(value.acquiredAt)
      ? (value as StrictPublicationOperationLockRecordV1)
      : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return readCode(error) === 'EPERM';
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.lstat(target);
    return true;
  } catch (error: unknown) {
    if (readCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
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
    !input.snapshotId.startsWith(
      `snapshot-${input.candidateDataManifestHash.slice('sha256:'.length)}`
    ) ||
    !/^snapshot-[a-f0-9]{64}(?:-[a-f0-9-]{36})?$/u.test(input.snapshotId)
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
  return uniqueRecipeIdentities(
    input.finalCoverage.cells.flatMap((cell) =>
      cell.finalRecipeIds.map((recipeId, index) => ({
        recipeId,
        authoredFingerprint: cell.finalRecipeFingerprints[index] ?? '',
      }))
    )
  );
}

function collectCandidateRecipes(
  input: ServingSnapshotValidationInputV1
): CandidateRecipeIdentityV1[] {
  return uniqueRecipeIdentities(
    input.candidateCoverage.cells.flatMap((cell) =>
      cell.contentReadyRecipeIds.map((recipeId, index) => ({
        recipeId,
        authoredFingerprint: cell.contentReadyRecipeFingerprints[index] ?? '',
        bindingHash: cell.productionBindingHashes[index] ?? '',
      }))
    )
  );
}

function uniqueRecipeIdentities<
  T extends { readonly recipeId: string; readonly authoredFingerprint: string },
>(rows: readonly T[]): T[] {
  const byRecipe = new Map<string, T>();
  for (const row of rows) {
    const existing = byRecipe.get(row.recipeId);
    if (existing && hashCanonicalJson(existing) !== hashCanonicalJson(row)) {
      failServingSnapshotValidation('ready-member-conservation');
    }
    byRecipe.set(row.recipeId, row);
  }
  return [...byRecipe.values()].sort((left, right) => left.recipeId.localeCompare(right.recipeId));
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

interface StrictCandidateCoverageInputV1 {
  readonly analysis: StrictAnalysisExecutionResultV1;
  readonly compiledPlan: CompiledColdStartPlanV2;
  readonly expressionSets: readonly StrictProducerExpressionSetV1[];
  readonly privateCorpus: StrictPrivateCorpusContentResultV1;
  readonly producerModelHash: string;
  readonly reviewerIdentity: ReviewerIdentityV1;
  readonly runId: string;
  readonly semanticReviewCheckpoint: StrictSemanticReviewCheckpointPortV1;
  readonly semanticReviewSession: StrictSemanticReviewSessionV1;
  /** 省略时保持 production V1 全 eligible cell 行为；strict-test 必须传 projection 精确集合。 */
  readonly executionCellIds?: readonly string[];
}

interface StrictG3ResidueV1 {
  readonly unresolvedHypothesisIds: readonly string[];
  readonly suppressedExpressionIds: readonly string[];
}

interface StrictCandidateCoverageBuildContextV1 extends StrictG3ResidueV1 {
  readonly bindingByCell: ReadonlyMap<
    string,
    StrictPrivateCorpusContentResultV1['bindings'][number][]
  >;
  readonly bindingByRecipe: ReadonlyMap<
    string,
    StrictPrivateCorpusContentResultV1['bindings'][number]
  >;
  readonly reviewer: InvestigatedEmptyReviewer;
  readonly setsByCell: ReadonlyMap<string, StrictProducerExpressionSetV1[]>;
  readonly terminalByExpression: ReadonlyMap<
    string,
    StrictPrivateCorpusContentResultV1['expressionTerminalRows'][number]
  >;
}

export async function buildStrictCandidateCoverage(
  input: StrictCandidateCoverageInputV1
): Promise<CandidateCoverageReceiptV1> {
  const bindingByCell = groupBy(input.privateCorpus.bindings, (binding) => binding.cellId);
  const bindingByRecipe = new Map(
    input.privateCorpus.bindings.map((binding) => [binding.recipeId, binding])
  );
  const terminalByExpression = new Map(
    input.privateCorpus.expressionTerminalRows.map((row) => [row.expressionId, row])
  );
  const setsByCell = expressionSetsByCell(input.expressionSets);
  assertStrictG3TerminalConservation(input, terminalByExpression);
  const residue = resolveStrictG3Residue(input, terminalByExpression);
  const requiredCells = resolveStrictCoverageCells(input);
  const reviewer = new InvestigatedEmptyReviewer({ identity: input.reviewerIdentity });
  const buildContext: StrictCandidateCoverageBuildContextV1 = {
    bindingByCell,
    bindingByRecipe,
    reviewer,
    setsByCell,
    terminalByExpression,
    ...residue,
  };
  const cells: CandidateCoverageReceiptV1['cells'][number][] = [];
  for (const cell of requiredCells) {
    cells.push(await buildStrictCandidateCoverageCell(input, buildContext, cell));
  }
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
    cells,
  });
}

function resolveStrictCoverageCells(
  input: StrictCandidateCoverageInputV1
): CompiledColdStartPlanV2['universe']['cells'] {
  const eligible = input.compiledPlan.universe.cells.filter((cell) => cell.status === 'eligible');
  if (!input.executionCellIds) {
    return eligible.sort((left, right) => left.cellId.localeCompare(right.cellId));
  }
  const requested = [...input.executionCellIds];
  if (requested.length === 0 || new Set(requested).size !== requested.length) {
    throw new Error('STRICT_CANDIDATE_COVERAGE_EXECUTION_CELL_SET_INVALID');
  }
  const eligibleById = new Map(eligible.map((cell) => [cell.cellId, cell] as const));
  const selected = requested.map((cellId) => eligibleById.get(cellId));
  if (selected.some((cell) => !cell)) {
    throw new Error('STRICT_CANDIDATE_COVERAGE_EXECUTION_CELL_SET_INVALID');
  }
  return selected as CompiledColdStartPlanV2['universe']['cells'];
}

function resolveStrictG3Residue(
  input: StrictCandidateCoverageInputV1,
  terminalByExpression: StrictCandidateCoverageBuildContextV1['terminalByExpression']
): StrictG3ResidueV1 {
  const unresolvedHypothesisIds = [
    ...new Set(
      input.analysis.epochs.flatMap((epoch) =>
        epoch.hypothesisDispositions
          .filter((row) => row.status === 'unknown')
          .map((row) => row.hypothesisId)
      )
    ),
  ].sort();
  const suppressedExpressionIds = input.expressionSets
    .flatMap((set) => set.proposals)
    .map((proposal) => proposal.expressionId)
    .filter((expressionId) => {
      const fate = terminalByExpression.get(expressionId)?.terminalFate;
      return (
        !fate ||
        fate === 'g1-rejected' ||
        fate === 'admission-rejected' ||
        fate === 'g2-rejected' ||
        fate === 'repair-superseded' ||
        fate === 'failed' ||
        fate === 'unknown'
      );
    })
    .sort();
  if (unresolvedHypothesisIds.length > 0 || suppressedExpressionIds.length > 0) {
    throw new Error(
      `STRICT_G3_RESIDUE_REJECTED:${JSON.stringify({
        unresolvedHypothesisIds,
        suppressedExpressionIds,
      })}`
    );
  }
  return { unresolvedHypothesisIds, suppressedExpressionIds };
}

async function buildStrictCandidateCoverageCell(
  input: StrictCandidateCoverageInputV1,
  context: StrictCandidateCoverageBuildContextV1,
  cell: CompiledColdStartPlanV2['universe']['cells'][number]
): Promise<CandidateCoverageReceiptV1['cells'][number]> {
  const cellId = cell.cellId;
  const sets = context.setsByCell.get(cellId) ?? [];
  const representativeBindings = sets
    .flatMap((set) => set.proposals)
    .map((proposal) => context.terminalByExpression.get(proposal.expressionId))
    .filter(
      (
        row
      ): row is StrictPrivateCorpusContentResultV1['expressionTerminalRows'][number] & {
        readonly recipeId: string;
      } =>
        Boolean(
          row?.recipeId &&
            (row.terminalFate === 'reviewed-merge' || row.terminalFate === 'reviewed-duplicate')
        )
    )
    .flatMap((row) => {
      const binding = context.bindingByRecipe.get(row.recipeId);
      return binding ? [binding] : [];
    });
  const bindings = [
    ...new Map(
      [...(context.bindingByCell.get(cellId) ?? []), ...representativeBindings].map((binding) => [
        binding.recipeId,
        binding,
      ])
    ).values(),
  ];
  const lensBindingIds = input.compiledPlan.schedule.lensBindings
    .filter((binding) => binding.cellId === cellId)
    .map((binding) => binding.bindingId);
  if (bindings.length > 0) {
    return {
      cellId,
      candidateDisposition: 'covered-by-content-ready-candidate',
      contentReadyRecipeIds: bindings.map((binding) => binding.recipeId),
      contentReadyRecipeFingerprints: bindings.map((binding) => binding.authoredFingerprint),
      productionBindingHashes: bindings.map((binding) => binding.bindingHash),
      lensBindingIds,
      expressionSetReceiptIds: sets.map((set) => `expression-set:${set.setId}`),
    };
  }
  return await buildStrictInvestigatedEmptyCoverageCell(
    input,
    context,
    cellId,
    sets,
    lensBindingIds
  );
}

async function buildStrictInvestigatedEmptyCoverageCell(
  input: StrictCandidateCoverageInputV1,
  context: StrictCandidateCoverageBuildContextV1,
  cellId: string,
  sets: readonly StrictProducerExpressionSetV1[],
  lensBindingIds: readonly string[]
): Promise<CandidateCoverageReceiptV1['cells'][number]> {
  // Core 的 investigated-empty 是整个 sealed schedule 的裁决；不能把单 cell 子集伪装成
  // final schedule。cell 只决定 coverage 归属，执行分母始终使用 Main 已封存的全量 receipts。
  const executionReceipts = [...input.analysis.factExecutionReceipts].sort((left, right) =>
    left.obligationId.localeCompare(right.obligationId)
  );
  const obligationIds = [...input.analysis.finalExpandedSchedule.obligationIds];
  const evidenceEntryIds = input.analysis.evidence.entries.map((entry) => entry.evidenceEntryId);
  const dispositionProposal = {
    reviewKind: 'investigated-empty',
    populationHash: input.analysis.epoch.population.populationHash,
    sourceRevisionVectorHash: input.compiledPlan.execution.sourceRevisionVectorHash,
    finalExpandedScheduleHash: input.analysis.finalExpandedSchedule.finalExpandedScheduleHash,
    currentAnalysisFixpointHash: input.analysis.fixpoint.fixpointHash,
    expectedObligationIds: obligationIds,
    executionBindings: executionReceipts.map((receipt) => ({
      obligationId: receipt.obligationId,
      executionReceiptHash: receipt.receiptHash,
      executionOutputHash: receipt.outputHash,
      denominatorHash: receipt.denominatorHash,
      disposition: receipt.disposition,
      terminalReceiptId: receipt.terminalReceiptId,
    })),
    evidenceEntryIds,
  } as const;
  const proposedDispositionHash = hashKnowledgeDispositionProposalV1(dispositionProposal);
  const producer = createProductionActorIdentityV1({
    providerId: 'alembic-agent',
    modelId: input.producerModelHash,
    modelVersion: 'strict-production-v1',
    promptHash: hashCanonicalJson({
      kind: 'investigated-empty-producer-prompt-v1',
      cellId,
      analysisFixpointHash: input.analysis.fixpoint.fixpointHash,
    }),
    runId: input.runId,
    invocationId: `investigated-empty-producer:${input.analysis.agentRunId}:${cellId}`,
    loadReceiptHash: input.producerModelHash,
    outputHash: proposedDispositionHash,
  });
  const semanticRequest = createAgentSemanticDispositionReviewRequestV1({
    strictWorkflowRunId: input.runId,
    sourceRevisionVectorHash: input.analysis.evidence.sourceRevisionVectorHash,
    currentAnalysisFixpointHash: input.analysis.fixpoint.fixpointHash,
    populationHash: input.analysis.epoch.population.populationHash,
    proposedDispositionHash,
    finalExpandedSchedule: input.analysis.finalExpandedSchedule,
    executionReceipts,
    evidence: createStrictSemanticReviewEvidenceV1({
      evidenceEntryIds,
      executionReceipts,
      session: input.semanticReviewSession,
      sourceRevisionVectorHash: input.analysis.evidence.sourceRevisionVectorHash,
      semanticRole: 'investigated-empty-complete-denominator',
    }),
    calibration: input.semanticReviewSession.calibration('investigated-empty'),
    producer,
    context: {
      reviewKind: 'investigated-empty',
      analysisFixpoint: input.analysis.fixpoint,
      population: input.analysis.epoch.population,
      proposal: dispositionProposal,
      negativeEvidenceSufficiency: {
        claim: 'The sealed strict denominator has no content-ready candidate for this cell.',
        requiredAbsencePredicates: [
          'no-content-ready-binding',
          'no-unresolved-hypothesis-or-suppressed-expression',
        ],
        inspectedEvidenceEntryIds: evidenceEntryIds,
        reasonCode: 'COMPLETE_STRICT_DENOMINATOR_INSPECTED',
      },
    },
  });
  const { dispositionReview } = await executeStrictDispositionReviewV5({
    checkpoint: input.semanticReviewCheckpoint,
    semanticRequest,
    session: input.semanticReviewSession,
  });
  const emptyDecision = context.reviewer.review({
    sourceRevisionVectorHash: input.compiledPlan.execution.sourceRevisionVectorHash,
    finalExpandedScheduleHash: input.analysis.fixpoint.finalExpandedScheduleHash,
    currentAnalysisFixpointHash: input.analysis.fixpoint.fixpointHash,
    expectedObligationIds: obligationIds,
    executionReceipts,
    dispositionReview,
    evidenceEntryIds,
  });
  if (emptyDecision.verdict !== 'pass') {
    throw new Error(`STRICT_INVESTIGATED_EMPTY_REJECTED:${cellId}:${emptyDecision.reasonCode}`);
  }
  return {
    cellId,
    candidateDisposition: 'investigated-empty',
    contentReadyRecipeIds: [],
    contentReadyRecipeFingerprints: [],
    productionBindingHashes: [],
    lensBindingIds,
    expressionSetReceiptIds: sets.map((set) => `expression-set:${set.setId}`),
    investigatedEmptyDecisionHash: emptyDecision.decisionHash,
  };
}

function assertStrictG3TerminalConservation(
  input: StrictCandidateCoverageInputV1,
  terminalByExpression: ReadonlyMap<
    string,
    StrictPrivateCorpusContentResultV1['expressionTerminalRows'][number]
  >
): void {
  const expectedIds = input.expressionSets.flatMap((set) => [
    ...set.proposals.map((proposal) => proposal.expressionId),
    ...(set.zeroDisposition ? [`zero:${set.setId}`] : []),
  ]);
  if (
    new Set(expectedIds).size !== expectedIds.length ||
    terminalByExpression.size !== input.privateCorpus.expressionTerminalRows.length ||
    expectedIds.some((expressionId) => !terminalByExpression.has(expressionId)) ||
    [...terminalByExpression.keys()].some((expressionId) => !expectedIds.includes(expressionId))
  ) {
    throw new Error('STRICT_G3_TERMINAL_LEDGER_DIVERGENCE');
  }
  const readyIds = new Set(input.privateCorpus.readyMembers.map((member) => member.recipeId));
  for (const terminal of terminalByExpression.values()) {
    if (
      terminal.terminalFate === 'content-ready' &&
      (!terminal.recipeId || !readyIds.has(terminal.recipeId))
    ) {
      throw new Error(`STRICT_G3_CONTENT_TARGET_NOT_READY:${terminal.expressionId}`);
    }
    if (
      (terminal.terminalFate === 'reviewed-merge' ||
        terminal.terminalFate === 'reviewed-duplicate') &&
      (!terminal.recipeId || !readyIds.has(terminal.recipeId))
    ) {
      throw new Error(`STRICT_G3_DISPOSITION_TARGET_NOT_READY:${terminal.expressionId}`);
    }
  }
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
    const authoredRows = [
      ...set.proposals.map((proposal) => proposal.authored),
      ...(set.zeroDisposition ? [set.zeroDisposition.authored] : []),
    ];
    for (const authored of authoredRows) {
      for (const moduleId of authored.scope.moduleIds) {
        for (const dimensionId of authored.scope.dimensionIds) {
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

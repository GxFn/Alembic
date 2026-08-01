import { createHash, randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  type FrozenEvidenceProjectionV1,
  type IndependentReviewDecisionV1,
  IndependentValueReviewer,
  type ReviewerIdentityV1,
} from '@alembic/agent/evaluation';
import {
  createStrictHypothesisExpressionSetReceiptV1,
  createStrictProducerExpressionSetV1,
  type StrictProducerExpressionSetV1,
} from '@alembic/agent/production';
import type { AgentService } from '@alembic/agent/service';
import { WriteZone } from '@alembic/core/io';
import {
  type CreateRecipeItem,
  createRecipeCandidateFingerprintProjectionV1,
  createRecipeProductionBindingV1,
  createRefReconciliationReceiptV1,
  createStrictAcceptedCorpusInspectionV1,
  createStrictAdmissionReceiptV1,
  createStrictG1ReceiptV1,
  createStrictG2ReceiptV1,
  createStrictPersistenceReceiptV1,
  createStrictRecipePersistedPayloadV1,
  KnowledgeFileWriter,
  KnowledgeGraphService,
  KnowledgeService,
  parseKnowledgeMarkdown,
  prepareRecipePersistenceV1,
  type RecipeProductionBindingV1,
  RecipeProductionGateway,
  type RefReconciliationReceiptV1,
  STRICT_G1_HARD_AXES_V1,
  type StrictAcceptedCorpusEntryV1,
  type StrictAdmissionReceiptV1,
  type StrictG1ReceiptV1,
  type StrictG2ReceiptV1,
  type StrictPersistenceReceiptV1,
} from '@alembic/core/knowledge';
import {
  createAgentSemanticDispositionReviewRequestV1,
  createProductionActorIdentityV1,
  type FactQueryExecutionReceiptV1,
  type FinalExpandedMiningScheduleReceiptV1,
  type HypothesisExpressionSetReceiptV1,
  hashKnowledgeDispositionProposalV1,
  type KnowledgeDispositionReviewV1,
} from '@alembic/core/production';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import { createAlembicRepositories } from '@alembic/core/repositories';
import { ConsolidationAdvisor } from '@alembic/core/sustain';
import {
  createLocalVectorStore,
  createLocalVectorStoreSync,
  type RecipeVectorGenerationInspection,
  RecipeVectorGenerationManager,
  type RecipeVectorGenerationManifest,
} from '@alembic/core/vector';
import {
  createPrivateCorpusRevisionCheckpointV1,
  initializePrivateCorpusRevisionV1,
  type PrivateCorpusRevisionCheckpointReceiptV1,
  type PrivateCorpusRevisionExpectedContextV1,
  type PrivateCorpusRevisionInitReceiptV1,
  rehydratePrivateCorpusRevisionV1,
  validatePrivateCorpusRevisionCheckpointV1,
  type WorkspaceResolver,
} from '@alembic/core/workspace';
import type { StrictSemanticReviewSessionV1 } from '../../../service/semantic-review/StrictSemanticReviewRuntimeFactory.js';
import {
  FileRecipeVectorGenerationStorage,
  RecipeVectorGenerationRuntime,
} from '../../../service/vector/RecipeVectorGenerationRuntime.js';
import type { StrictAnalysisExecutionResultV1 } from './StrictAnalysisRuntime.js';
import {
  createStrictSemanticReviewEvidenceV1,
  executeStrictDispositionReviewV5,
  type StrictSemanticReviewCheckpointPortV1,
} from './StrictDispositionReviewRuntime.js';
import type { StrictProductionJournal } from './StrictProductionJournal.js';

export interface StrictPrivateCorpusContentResultV1 {
  readonly revisionInitReceipt: PrivateCorpusRevisionInitReceiptV1;
  readonly revisionCheckpointReceipt: PrivateCorpusRevisionCheckpointReceiptV1;
  readonly revisionId: string;
  readonly rootManifestHash: string;
  readonly g1Receipts: readonly StrictG1ReceiptV1[];
  readonly hypothesisExpressionSetReceipts: readonly HypothesisExpressionSetReceiptV1[];
  readonly bindings: readonly RecipeProductionBindingV1[];
  readonly expressionTerminalRows: readonly {
    readonly expressionId: string;
    readonly recipeId: string | null;
    readonly terminalFate:
      | 'content-ready'
      | 'reviewed-merge'
      | 'reviewed-duplicate'
      | 'reviewed-zero'
      | 'g1-rejected'
      | 'admission-rejected'
      | 'g2-rejected'
      | 'repair-superseded'
      | 'failed'
      | 'unknown';
    readonly terminalReceiptId: string;
    readonly terminalReceiptHash: string;
    readonly dispositionReview?: KnowledgeDispositionReviewV1;
    readonly matchingRepresentativeId?: string;
    readonly matchingContentReadyRecipeId?: string;
  }[];
  readonly activeRecipes: readonly {
    readonly id: string;
    readonly title: string;
    readonly lifecycle: 'active';
  }[];
  readonly readyMembers: readonly StrictReadyMemberProofV1[];
}

export interface StrictReadyMemberProofV1 {
  readonly schemaVersion: 1;
  readonly recipeId: string;
  readonly title: string;
  readonly runId: string;
  readonly privateCorpusRevision: string;
  readonly analysisFixpointHash: string;
  readonly authoredFingerprint: string;
  readonly bindingHash: string;
  readonly persistenceReceiptHash: string;
  readonly databaseRowHash: string;
  readonly databaseReadbackHash: string;
  readonly fileHash: string;
  readonly fileReadbackHash: string;
  readonly refReconciliationReceiptHash: string;
  readonly refReadbackHash: string;
  readonly lifecycle: 'active';
  readonly proofHash: string;
}

export interface StrictSealedCorpusVerificationV1 {
  readonly schemaVersion: 1;
  readonly activeRecipeIds: readonly string[];
  readonly readyMemberSetHash: string;
  readonly durableReadbackHash: string;
  readonly refReadbackHash: string;
  readonly sparseEvidenceHash: string;
  readonly vectorGenerationId: string;
  readonly vectorManifestHash: string;
  readonly vectorInspectionHash: string;
  readonly verdict: 'pass';
  readonly failedPredicate: null;
  readonly verificationHash: string;
}

export interface StrictPrivateCorpusResultV1 extends StrictPrivateCorpusContentResultV1 {
  readonly freshProcessRehydrateHash: string;
  readonly activeRecipeIds: readonly string[];
  readonly vectorGenerationId: string;
  readonly vectorManifestHash: string;
  readonly sealedCorpusVerification: StrictSealedCorpusVerificationV1;
}

interface StrictPreparedRowCheckpointV1 {
  readonly schemaVersion: 1;
  readonly preparedHash: string;
  readonly g1ReceiptHash: string;
  readonly admissionReceiptHash: string;
  readonly g2ReceiptHash: string;
  readonly persistence: StrictPersistenceReceiptV1;
  readonly refs: RefReconciliationReceiptV1;
  readonly binding: RecipeProductionBindingV1;
  readonly checkpointHash: string;
}

interface StrictPrivateCorpusPersistenceInput {
  readonly acceptedMigrationBundleSemanticHash: string;
  readonly agentService: Pick<AgentService, 'run'>;
  readonly analysis: StrictAnalysisExecutionResultV1;
  readonly analysisFixpointHash: string;
  readonly baseResolver: WorkspaceResolver;
  readonly configReceiptHash: string;
  readonly credentialLocationSymbol: string;
  readonly evidence: FrozenEvidenceProjectionV1;
  readonly executionReceipts: readonly FactQueryExecutionReceiptV1[];
  readonly expressionSets: readonly StrictProducerExpressionSetV1[];
  /** strict-test 传入 projection 的 exact selected cells；production 省略并保持原全量语义。 */
  readonly executionCellIds?: readonly string[];
  readonly finalExpandedSchedule: FinalExpandedMiningScheduleReceiptV1;
  readonly journal: StrictProductionJournal;
  readonly manifestHash: string;
  readonly planHash: string;
  readonly producerModelHash: string;
  readonly recoveryRoot: string;
  readonly runId: string;
  readonly runtimeReceiptHash: string;
  readonly terminalObligations: readonly {
    readonly obligationId: string;
    readonly disposition: 'matched' | 'inspected-no-pattern' | 'failed' | 'unknown';
    readonly terminalReceiptId: string;
  }[];
  readonly reviewer: {
    readonly calibrationReceiptHash: string;
    readonly identity: ReviewerIdentityV1;
  };
  readonly semanticReviewCheckpoint: StrictSemanticReviewCheckpointPortV1;
  readonly semanticReviewSession: StrictSemanticReviewSessionV1;
  readonly resumeInitReceipt?: PrivateCorpusRevisionInitReceiptV1;
  readonly onRevisionInitialized?: (
    receipt: PrivateCorpusRevisionInitReceiptV1
  ) => Promise<void> | void;
}

type StrictProposal = StrictProducerExpressionSetV1['proposals'][number];
type StrictReviewedProjection = ReturnType<typeof createRecipeCandidateFingerprintProjectionV1>;
type StrictRepositories = ReturnType<typeof createAlembicRepositories>;
type StrictPersistedCandidate = Awaited<
  ReturnType<RecipeProductionGateway['persistPreparedReviewedCandidate']>
>;

interface StrictPersistenceContext {
  readonly input: StrictPrivateCorpusPersistenceInput;
  readonly revisionId: string;
  readonly repositories: StrictRepositories;
  readonly gateway: RecipeProductionGateway;
  readonly fileWriter: KnowledgeFileWriter;
  readonly reviewedById: Map<string, StrictReviewedProjection>;
  readonly expectedById: Map<string, { dbHash: string; fileHash: string }>;
  readonly preparedAuthorities: Map<
    string,
    {
      readonly g1: StrictG1ReceiptV1;
      readonly admission: StrictAdmissionReceiptV1;
      readonly g2: StrictG2ReceiptV1;
    }
  >;
  readonly acceptedCorpus: StrictAcceptedCorpusEntryV1[];
}

interface StrictPersistenceAccumulators {
  readonly g1Receipts: StrictG1ReceiptV1[];
  readonly bindings: RecipeProductionBindingV1[];
  readonly expressionTerminalRows: StrictPrivateCorpusResultV1['expressionTerminalRows'][number][];
  readonly activeRecipes: Array<{ id: string; title: string; lifecycle: 'active' }>;
  readonly readyMembers: StrictReadyMemberProofV1[];
}

interface StrictResolvedPreparedBinding {
  readonly persistence: StrictPersistenceReceiptV1;
  readonly refs: RefReconciliationReceiptV1;
  readonly binding: RecipeProductionBindingV1;
}

interface StrictDraftPreparation {
  readonly item: CreateRecipeItem;
  readonly reviewed: StrictReviewedProjection;
  readonly g1: StrictG1ReceiptV1;
  readonly admission: StrictAdmissionReceiptV1;
  readonly g2: StrictG2ReceiptV1;
  readonly journalStepHash: string;
  readonly dbHash: string;
  readonly fileHash: string;
  readonly prepared: ReturnType<typeof prepareRecipePersistenceV1>;
  readonly rowCheckpointPath: string;
  readonly rowCheckpoint: StrictPreparedRowCheckpointV1 | null;
  readonly moduleId: string;
}

type StrictKnowledgeRepository = ReturnType<
  typeof createAlembicRepositories
>['knowledgeRepository'];
type StrictKnowledgeEntry = NonNullable<Awaited<ReturnType<StrictKnowledgeRepository['findById']>>>;

export async function persistStrictPrivateCorpusContent(
  input: StrictPrivateCorpusPersistenceInput
): Promise<StrictPrivateCorpusContentResultV1> {
  assertStrictPrivateCorpusExecutionCells(input);
  const revisionId = revisionIdForFixpoint(input.analysisFixpointHash);
  const expectedCurrentContext = strictPrivateCorpusExpectedContext(input, revisionId);
  const initialized = input.resumeInitReceipt
    ? await rehydratePrivateCorpusRevisionV1(
        input.baseResolver,
        input.resumeInitReceipt,
        expectedCurrentContext
      )
    : await initializePrivateCorpusRevisionV1(input.baseResolver, {
        runId: input.runId,
        revisionId,
        analysisFixpointHash: input.analysisFixpointHash,
        configReceiptHash: input.configReceiptHash,
        runtimeReceiptHash: input.runtimeReceiptHash,
        credentialLocationSymbol: input.credentialLocationSymbol,
        acceptedMigrationBundleSemanticHash: input.acceptedMigrationBundleSemanticHash,
      });
  const initReceipt = initialized.handle.initReceipt;
  await input.onRevisionInitialized?.(initReceipt);
  const repositories = createAlembicRepositories(initialized.runtime.connection);
  const graph = new KnowledgeGraphService(repositories.knowledgeEdgeRepository);
  const fileWriter = new KnowledgeFileWriter(
    initialized.handle.resolver.dataRoot,
    new WriteZone(initialized.handle.resolver)
  );
  const knowledgeService = createKnowledgeService(
    initialized.handle.resolver,
    repositories,
    fileWriter,
    graph
  );
  const reviewedById = new Map<
    string,
    ReturnType<typeof createRecipeCandidateFingerprintProjectionV1>
  >();
  const expectedById = new Map<string, { dbHash: string; fileHash: string }>();
  const preparedAuthorities = new Map<
    string,
    {
      readonly g1: StrictG1ReceiptV1;
      readonly admission: StrictAdmissionReceiptV1;
      readonly g2: StrictG2ReceiptV1;
    }
  >();
  const acceptedCorpus: StrictAcceptedCorpusEntryV1[] = [];
  const gateway = createStrictPrivateCorpusGateway({
    input,
    revisionId,
    repositories,
    knowledgeService,
    fileWriter,
    reviewedById,
    expectedById,
    preparedAuthorities,
    acceptedCorpus,
  });
  const g1Receipts: StrictG1ReceiptV1[] = [];
  const bindings: RecipeProductionBindingV1[] = [];
  const expressionTerminalRows: StrictPrivateCorpusResultV1['expressionTerminalRows'][number][] =
    [];
  const activeRecipes: Array<{ id: string; title: string; lifecycle: 'active' }> = [];
  const readyMembers: StrictReadyMemberProofV1[] = [];
  const authorizedExpressionSets = await persistStrictExpressionSets(
    {
      input,
      revisionId,
      repositories,
      gateway,
      fileWriter,
      reviewedById,
      expectedById,
      preparedAuthorities,
      acceptedCorpus,
    },
    { g1Receipts, bindings, expressionTerminalRows, activeRecipes, readyMembers }
  );
  const hypothesisExpressionSetReceipts = createStrictTerminalExpressionSetReceipts(
    authorizedExpressionSets,
    expressionTerminalRows,
    revisionId
  );
  const revisionCheckpointReceipt = validatePrivateCorpusRevisionCheckpointV1(
    createPrivateCorpusRevisionCheckpointV1(
      initialized.handle,
      initialized.runtime,
      expectedCurrentContext
    ),
    initReceipt,
    expectedCurrentContext
  );
  const rootManifestHash = hashCanonicalJson({
    analysisFixpointHash: input.analysisFixpointHash,
    bindings: bindings.map((binding) => binding.bindingHash),
    expressionTerminalRows,
    hypothesisExpressionSetReceiptHashes: hypothesisExpressionSetReceipts.map(
      (receipt) => receipt.receiptHash
    ),
    revisionId,
    revisionCheckpointHash: revisionCheckpointReceipt.checkpointHash,
    readyMemberProofs: readyMembers.map((member) => member.proofHash),
  });
  initialized.runtime.close();
  return Object.freeze({
    revisionInitReceipt: initReceipt,
    revisionCheckpointReceipt,
    revisionId,
    rootManifestHash,
    g1Receipts,
    hypothesisExpressionSetReceipts,
    bindings,
    expressionTerminalRows,
    activeRecipes: [...activeRecipes].sort((left, right) => left.id.localeCompare(right.id)),
    readyMembers: [...readyMembers].sort((left, right) =>
      left.recipeId.localeCompare(right.recipeId)
    ),
  });
}

function assertStrictPrivateCorpusExecutionCells(input: StrictPrivateCorpusPersistenceInput): void {
  if (!input.executionCellIds) {
    return;
  }
  const selected = new Set(input.executionCellIds);
  if (selected.size === 0 || selected.size !== input.executionCellIds.length) {
    throw new Error('STRICT_PRIVATE_CORPUS_EXECUTION_CELL_SET_INVALID');
  }
  for (const set of input.expressionSets) {
    const authoredRows = [
      ...set.proposals.map((proposal) => proposal.authored),
      ...(set.zeroDisposition ? [set.zeroDisposition.authored] : []),
    ];
    for (const authored of authoredRows) {
      if (
        authored.scope.moduleIds.length !== 1 ||
        authored.scope.dimensionIds.length !== 1 ||
        !selected.has(`${authored.scope.moduleIds[0]}::${authored.scope.dimensionIds[0]}`)
      ) {
        throw new Error('STRICT_PRIVATE_CORPUS_EXECUTION_CELL_SET_INVALID');
      }
    }
  }
}

function strictPrivateCorpusExpectedContext(
  input: Pick<
    StrictPrivateCorpusPersistenceInput,
    'analysisFixpointHash' | 'configReceiptHash' | 'runId' | 'runtimeReceiptHash'
  >,
  revisionId: string
): PrivateCorpusRevisionExpectedContextV1 {
  return Object.freeze({
    runId: input.runId,
    revisionId,
    analysisFixpointHash: input.analysisFixpointHash,
    configReceiptHash: input.configReceiptHash,
    runtimeReceiptHash: input.runtimeReceiptHash,
  });
}

function createStrictPrivateCorpusGateway(options: {
  readonly input: StrictPrivateCorpusPersistenceInput;
  readonly revisionId: string;
  readonly repositories: StrictRepositories;
  readonly knowledgeService: KnowledgeService;
  readonly fileWriter: KnowledgeFileWriter;
  readonly reviewedById: StrictPersistenceContext['reviewedById'];
  readonly expectedById: StrictPersistenceContext['expectedById'];
  readonly preparedAuthorities: StrictPersistenceContext['preparedAuthorities'];
  readonly acceptedCorpus: StrictAcceptedCorpusEntryV1[];
}): RecipeProductionGateway {
  return new RecipeProductionGateway({
    knowledgeService: options.knowledgeService as unknown as ConstructorParameters<
      typeof RecipeProductionGateway
    >[0]['knowledgeService'],
    projectRoot: options.input.baseResolver.projectRoot,
    consolidationAdvisor: new ConsolidationAdvisor(
      options.repositories.knowledgeRepository
    ) as unknown as ConstructorParameters<
      typeof RecipeProductionGateway
    >[0]['consolidationAdvisor'],
    inspectAcceptedRecipeCorpus: async (coordinates) =>
      createStrictAcceptedCorpusInspectionV1({
        ...coordinates,
        entries: options.acceptedCorpus,
      }),
    authorizePreparedRecipe(journalToken, prepared, reviewedProjection) {
      return (
        journalToken === options.input.journal.entries.at(-1)?.entryHash &&
        prepared.journalStepHash === journalToken &&
        reviewedProjection.authoredFingerprint === prepared.authoredFingerprint
      );
    },
    async inspectPreparedRecipe(prepared) {
      const entry = await options.repositories.knowledgeRepository.findById(
        prepared.preparedRecipeId
      );
      if (!entry) {
        return null;
      }
      const reviewed = options.reviewedById.get(prepared.preparedRecipeId);
      const expected = options.expectedById.get(prepared.preparedRecipeId);
      const authority = options.preparedAuthorities.get(prepared.preparedRecipeId);
      if (!reviewed || !expected || !authority) {
        throw new Error('STRICT_PREPARED_INSPECTION_AUTHORITY_MISSING');
      }
      const json = entry.toJSON() as Record<string, unknown>;
      if (
        json.title !== reviewed.title ||
        json.kind !== reviewed.kind ||
        json.doClause !== reviewed.doText ||
        json.dontClause !== reviewed.dontText ||
        !sameMarkdown(json.content, reviewed.markdown)
      ) {
        throw new Error('STRICT_PREPARED_PERSISTENCE_DIVERGENCE');
      }
      const resolvedFile = options.fileWriter._resolveFilePath(entry);
      if (!(await firstExisting([path.join(resolvedFile.dir, resolvedFile.filename)]))) {
        throw new Error('STRICT_PREPARED_FILE_READBACK_MISSING');
      }
      return {
        id: entry.id,
        title: entry.title,
        lifecycle: entry.lifecycle,
        privateCorpusRevision: options.revisionId,
        preparedHash: prepared.preparedHash,
        admissionId: authority.admission.admissionId,
        g1ReceiptHash: authority.g1.receiptHash,
        admissionReceiptHash: authority.admission.receiptHash,
        g2ReceiptHash: authority.g2.receiptHash,
        authoredFingerprint: reviewed.authoredFingerprint,
        dbHash: expected.dbHash,
        fileHash: expected.fileHash,
      };
    },
  });
}

async function persistStrictExpressionSets(
  context: StrictPersistenceContext,
  accumulators: StrictPersistenceAccumulators
): Promise<readonly StrictProducerExpressionSetV1[]> {
  const reviewer = createStrictIndependentReviewer(context.input);
  const authorizedSets: StrictProducerExpressionSetV1[] = [];
  for (const set of context.input.expressionSets) {
    const parentSet = set.parentSetId
      ? authorizedSets.find((candidate) => candidate.setId === set.parentSetId)
      : null;
    if (set.parentSetId && !parentSet) {
      throw new Error(`STRICT_SEMANTIC_REVIEW_PARENT_SET_MISSING:${set.setId}`);
    }
    const authorizedSet = await persistStrictZeroTerminal(
      context,
      accumulators,
      set,
      parentSet ?? null
    );
    authorizedSets.push(authorizedSet);
    for (const proposal of set.proposals) {
      await persistStrictProposal(context, accumulators, reviewer, set, proposal);
    }
  }
  assertStrictDispositionTargetsReady(accumulators);
  assertStrictExpressionTerminalConservation(authorizedSets, accumulators.expressionTerminalRows);
  return Object.freeze(authorizedSets);
}

async function persistStrictZeroTerminal(
  context: StrictPersistenceContext,
  accumulators: StrictPersistenceAccumulators,
  set: StrictProducerExpressionSetV1,
  parentSet: StrictProducerExpressionSetV1 | null
): Promise<StrictProducerExpressionSetV1> {
  if (!set.zeroDisposition) {
    return set;
  }
  const zeroProposal: StrictProposal = {
    expressionId: `zero:${set.setId}`,
    kind: 'draft',
    authored: set.zeroDisposition.authored,
    authoredFingerprint: hashCanonicalJson({
      schemaVersion: 1,
      authored: set.zeroDisposition.authored,
    }),
  };
  const candidate = prepareStrictAdmissionCandidate(context, set, zeroProposal);
  const admitted = await context.gateway.admitCandidate(candidate.item, {
    source: 'alembic-agent',
    runId: context.input.runId,
    analysisFixpointHash: context.input.analysisFixpointHash,
    privateCorpusRevision: context.revisionId,
    revisionRootManifestHash: currentAcceptedCorpusRoot(context.revisionId, context.acceptedCorpus),
    g1Receipt: candidate.g1,
    reviewedProjection: candidate.reviewed,
  });
  if (
    admitted.receipt.disposition !== 'admit' ||
    admitted.receipt.consolidation.action !== 'create'
  ) {
    throw new Error(`STRICT_SEMANTIC_REVIEW_ZERO_ADMISSION_REJECTED:${set.setId}`);
  }
  const semanticAdmission = createProducerSemanticAdmissionAuthority(
    context,
    zeroProposal,
    candidate.g1,
    admitted.receipt
  );
  accumulators.g1Receipts.push(semanticAdmission.g1);
  const dispositionReview = await reviewStrictZeroTerminal(
    context,
    set,
    zeroProposal,
    semanticAdmission
  );
  const authorizedSet = createStrictProducerExpressionSetV1({
    lineage: set.lineage,
    parentSet,
    proposals: set.proposals.map((proposal) => ({
      expressionId: proposal.expressionId,
      kind: proposal.kind,
      authored: proposal.authored,
      ...(proposal.matchingRepresentativeId
        ? { matchingRepresentativeId: proposal.matchingRepresentativeId }
        : {}),
    })),
    zeroDisposition: {
      reasonCode: set.zeroDisposition.reasonCode,
      authored: set.zeroDisposition.authored,
      dispositionReview,
    },
    modelHash: set.repairNode.modelHash,
    reasonHash: set.repairNode.reasonHash,
  });
  if (authorizedSet.setId !== set.setId) {
    throw new Error(`STRICT_SEMANTIC_REVIEW_ZERO_SET_ID_REBOUND:${set.setId}`);
  }
  accumulators.expressionTerminalRows.push({
    expressionId: `zero:${set.setId}`,
    recipeId: null,
    terminalFate: 'reviewed-zero',
    terminalReceiptId: dispositionReview.reviewReceiptId,
    terminalReceiptHash: dispositionReview.receiptHash,
    dispositionReview,
  });
  return authorizedSet;
}

async function reviewStrictZeroTerminal(
  context: StrictPersistenceContext,
  set: StrictProducerExpressionSetV1,
  zeroProposal: StrictProposal,
  semanticAdmission: ReturnType<typeof createProducerSemanticAdmissionAuthority>
): Promise<KnowledgeDispositionReviewV1> {
  const zeroDisposition = set.zeroDisposition;
  if (!zeroDisposition) {
    throw new Error(`STRICT_SEMANTIC_REVIEW_ZERO_DISPOSITION_MISSING:${set.setId}`);
  }
  const dispositionProposal = {
    reviewKind: 'producer-non-draft',
    populationHash: set.lineage.populationHash,
    hypothesisId: set.hypothesis.hypothesisId,
    expression: null,
    zeroDisposition: {
      reasonCode: zeroDisposition.reasonCode,
      terminalFate: 'reviewed-non-draft',
    },
  } as const;
  const proposedDispositionHash = hashKnowledgeDispositionProposalV1(dispositionProposal);
  const { induction, falsification, population } = resolveProducerReviewLineage(
    context.input.analysis,
    set
  );
  const semanticRequest = createAgentSemanticDispositionReviewRequestV1({
    strictWorkflowRunId: context.input.runId,
    sourceRevisionVectorHash: context.input.evidence.sourceRevisionVectorHash,
    currentAnalysisFixpointHash: context.input.analysisFixpointHash,
    populationHash: set.lineage.populationHash,
    proposedDispositionHash,
    finalExpandedSchedule: context.input.finalExpandedSchedule,
    executionReceipts: context.input.executionReceipts,
    evidence: createStrictSemanticReviewEvidenceV1({
      evidenceEntryIds: zeroDisposition.authored.evidenceEntryIds,
      executionReceipts: context.input.executionReceipts,
      session: context.input.semanticReviewSession,
      sourceRevisionVectorHash: context.input.evidence.sourceRevisionVectorHash,
      semanticRole: 'producer-zero-complete-comparison-authority',
    }),
    calibration: context.input.semanticReviewSession.calibration('producer-non-draft'),
    producer: createProductionActorIdentityV1({
      providerId: 'alembic-agent',
      modelId: context.input.producerModelHash,
      modelVersion: 'strict-producer-expression-v1',
      promptHash: normalizeStrictActorHash(set.repairNode.reasonHash),
      runId: set.lineage.runId,
      invocationId: `producer-zero:${set.setId}`,
      loadReceiptHash: normalizeStrictActorHash(set.repairNode.modelHash),
      outputHash: normalizeStrictActorHash(set.repairNode.outputHash),
    }),
    context: {
      reviewKind: 'producer-non-draft',
      privateCorpusRevision: context.revisionId,
      analysisFixpoint: context.input.analysis.fixpoint,
      population,
      induction,
      falsification,
      proposal: dispositionProposal,
      expressionSetReceiptId: `expression-set:${set.setId}`,
      g1Receipt: semanticAdmission.g1,
      admissionReceipt: semanticAdmission.admission,
      target: {
        expressionId: null,
        authoredFingerprint: zeroProposal.authoredFingerprint,
        terminalFate: 'reviewed-non-draft',
        targetRecipeId: null,
        targetFingerprint: null,
        targetReadyProofHash: null,
      },
    },
  });
  const { dispositionReview } = await executeStrictDispositionReviewV5({
    checkpoint: context.input.semanticReviewCheckpoint,
    semanticRequest,
    session: context.input.semanticReviewSession,
  });
  return dispositionReview;
}

async function persistStrictProposal(
  context: StrictPersistenceContext,
  accumulators: StrictPersistenceAccumulators,
  reviewer: IndependentValueReviewer,
  set: StrictProducerExpressionSetV1,
  proposal: StrictProposal
): Promise<void> {
  const candidate = prepareStrictAdmissionCandidate(context, set, proposal);
  accumulators.g1Receipts.push(candidate.g1);
  if (candidate.g1.verdict !== 'pass') {
    recordStrictRejectedTerminal(
      accumulators,
      proposal.expressionId,
      'g1-rejected',
      `strict-g1:${candidate.g1.receiptHash.slice(7, 31)}`,
      candidate.g1.receiptHash
    );
    return;
  }
  const admitted = await context.gateway.admitCandidate(candidate.item, {
    source: 'alembic-agent',
    runId: context.input.runId,
    analysisFixpointHash: context.input.analysisFixpointHash,
    privateCorpusRevision: context.revisionId,
    revisionRootManifestHash: currentAcceptedCorpusRoot(context.revisionId, context.acceptedCorpus),
    g1Receipt: candidate.g1,
    reviewedProjection: candidate.reviewed,
  });
  if (admitted.receipt.disposition !== 'admit') {
    await persistStrictDispositionTerminal(
      context,
      accumulators,
      set,
      proposal,
      candidate.g1,
      admitted.receipt
    );
    return;
  }
  if (admitted.receipt.finalAdmittedFingerprint !== candidate.reviewed.authoredFingerprint) {
    // Core 当前 admission 不返回改写后的 projection；一旦未来出现内容重写，必须停止并让
    // 新版本重新经过 G1，不能把旧 G1 收据错误绑定到新内容后继续 G2 或持久化。
    throw new Error(`STRICT_PRIVATE_CORPUS_G1_READMISSION_REQUIRED:${proposal.expressionId}`);
  }
  const review = await reviewer.review({
    authored: proposal.authored,
    evidence: context.input.evidence,
    expectedSourceRevisionVectorHash: context.input.evidence.sourceRevisionVectorHash,
    producerIdentity: `producer/${context.input.producerModelHash}`,
    admissionReceiptId: admitted.receipt.admissionId,
    calibrationReceiptHash: context.input.reviewer.calibrationReceiptHash,
    repairAttempt: set.version - 1,
  });
  const g2 = createStrictG2FromIndependentReview(
    context,
    set,
    candidate.g1,
    admitted.receipt,
    candidate.reviewed,
    review
  );
  if (g2.verdict !== 'pass') {
    recordStrictRejectedTerminal(
      accumulators,
      proposal.expressionId,
      'g2-rejected',
      `strict-g2:${g2.receiptHash.slice(7, 31)}`,
      g2.receiptHash
    );
    return;
  }
  await persistStrictContentReadyProposal(
    context,
    accumulators,
    set,
    proposal,
    candidate,
    admitted.receipt,
    g2
  );
}

async function persistStrictContentReadyProposal(
  context: StrictPersistenceContext,
  accumulators: StrictPersistenceAccumulators,
  set: StrictProducerExpressionSetV1,
  proposal: StrictProposal,
  candidate: ReturnType<typeof prepareStrictAdmissionCandidate>,
  admission: StrictAdmissionReceiptV1,
  g2: StrictG2ReceiptV1
): Promise<void> {
  const draft = await prepareStrictDraftPersistence(
    context,
    set,
    proposal,
    candidate.moduleId,
    candidate.dimensionId,
    candidate.item,
    candidate.reviewed,
    candidate.g1,
    admission,
    g2
  );
  const persisted = await context.gateway.persistPreparedReviewedCandidate(
    draft.item,
    draft.prepared,
    {
      source: 'alembic-agent',
      userId: 'strict-production',
      journalToken: draft.journalStepHash,
      reviewedProjection: draft.reviewed,
      g1Receipt: draft.g1,
      admissionReceipt: draft.admission,
      g2Receipt: draft.g2,
    }
  );
  const sourcePaths = reconcileStrictSourceRefs(context, proposal, persisted);
  const resolved = await resolveStrictPreparedBinding(context, draft, persisted, sourcePaths);
  accumulators.bindings.push(resolved.binding);
  const active =
    persisted.recipe.lifecycle === 'active'
      ? persisted.recipe
      : await context.gateway.publish(persisted.recipe.id, { userId: 'strict-production' });
  if (active.lifecycle !== 'active') {
    throw new Error('STRICT_PRIVATE_CORPUS_G3_ACTIVE_FAILED');
  }
  const readyMember = await createStrictReadyMemberProof({
    active,
    binding: resolved.binding,
    fileWriter: context.fileWriter,
    persistence: resolved.persistence,
    refRepository: context.repositories.recipeSourceRefRepository,
    refs: resolved.refs,
    repository: context.repositories.knowledgeRepository,
    reviewed: draft.reviewed,
    sourcePaths,
  });
  accumulators.activeRecipes.push({ id: active.id, title: active.title, lifecycle: 'active' });
  accumulators.readyMembers.push(readyMember);
  accumulators.expressionTerminalRows.push({
    expressionId: proposal.expressionId,
    recipeId: persisted.recipe.id,
    terminalFate: 'content-ready',
    terminalReceiptId: resolved.binding.bindingHash,
    terminalReceiptHash: resolved.binding.bindingHash,
  });
  context.acceptedCorpus.push({
    recipeId: persisted.recipe.id,
    projection: draft.reviewed,
    admissionSummary: {
      title: draft.reviewed.title,
      category: draft.reviewed.category || null,
      trigger: draft.reviewed.trigger || null,
      whenClause: draft.reviewed.whenClause || null,
      doClause: draft.reviewed.doText || null,
      dontClause: draft.reviewed.dontText || null,
      coreCode: draft.reviewed.coreCode || null,
      guardPattern: draft.reviewed.pattern || null,
      markdown: draft.reviewed.markdown || null,
    },
  });
}

function recordStrictRejectedTerminal(
  accumulators: StrictPersistenceAccumulators,
  expressionId: string,
  terminalFate: 'g1-rejected' | 'admission-rejected' | 'g2-rejected',
  terminalReceiptId: string,
  terminalReceiptHash: string
): void {
  accumulators.expressionTerminalRows.push({
    expressionId,
    recipeId: null,
    terminalFate,
    terminalReceiptId,
    terminalReceiptHash,
  });
}

function assertStrictDispositionTargetsReady(accumulators: StrictPersistenceAccumulators): void {
  const readyIds = new Set(accumulators.readyMembers.map((member) => member.recipeId));
  for (const terminal of accumulators.expressionTerminalRows) {
    if (
      (terminal.terminalFate === 'reviewed-merge' ||
        terminal.terminalFate === 'reviewed-duplicate') &&
      (!terminal.recipeId || !readyIds.has(terminal.recipeId))
    ) {
      throw new Error(`STRICT_DISPOSITION_TARGET_NOT_CONTENT_READY:${terminal.expressionId}`);
    }
  }
}

/**
 * proposal 与显式 zero disposition 都必须且只能落入一个终态行。这个检查位于串行循环
 * 末端，因此 merge/duplicate target readiness 与所有写入结果已经稳定，不会把中间态
 * 误报成闭环。
 */
function assertStrictExpressionTerminalConservation(
  sets: readonly StrictProducerExpressionSetV1[],
  terminals: readonly StrictPrivateCorpusContentResultV1['expressionTerminalRows'][number][]
): void {
  const expectedIds = sets.flatMap((set) => [
    ...set.proposals.map((proposal) => proposal.expressionId),
    ...(set.zeroDisposition ? [`zero:${set.setId}`] : []),
  ]);
  const actualIds = terminals.map((terminal) => terminal.expressionId);
  const duplicateActualIds = actualIds.filter(
    (expressionId, index) => actualIds.indexOf(expressionId) !== index
  );
  const actualSet = new Set(actualIds);
  const missingIds = expectedIds.filter((expressionId) => !actualSet.has(expressionId));
  const expectedSet = new Set(expectedIds);
  const unexpectedIds = actualIds.filter((expressionId) => !expectedSet.has(expressionId));
  if (
    expectedSet.size !== expectedIds.length ||
    duplicateActualIds.length > 0 ||
    missingIds.length > 0 ||
    unexpectedIds.length > 0
  ) {
    throw new Error(
      `STRICT_EXPRESSION_TERMINAL_CONSERVATION_FAILED:${JSON.stringify({
        duplicateActualIds: [...new Set(duplicateActualIds)].sort(),
        missingIds: [...new Set(missingIds)].sort(),
        unexpectedIds: [...new Set(unexpectedIds)].sort(),
      })}`
    );
  }
}

function createStrictTerminalExpressionSetReceipts(
  sets: readonly StrictProducerExpressionSetV1[],
  terminals: readonly StrictPrivateCorpusContentResultV1['expressionTerminalRows'][number][],
  privateCorpusRevision: string
): HypothesisExpressionSetReceiptV1[] {
  const terminalByExpression = new Map(
    terminals.map((terminal) => [terminal.expressionId, terminal] as const)
  );
  const receiptById = new Map<string, HypothesisExpressionSetReceiptV1>();
  const receipts: HypothesisExpressionSetReceiptV1[] = [];
  for (const set of sets) {
    const parentReceiptId = set.parentSetId ? `expression-set:${set.parentSetId}` : null;
    const parentReceipt = parentReceiptId ? receiptById.get(parentReceiptId) : null;
    if (parentReceiptId && !parentReceipt) {
      throw new Error(`STRICT_EXPRESSION_PARENT_RECEIPT_MISSING:${set.setId}`);
    }
    const terminalResolutions = set.proposals.map((proposal) => {
      const terminal = terminalByExpression.get(proposal.expressionId);
      if (!terminal || terminal.terminalFate === 'reviewed-zero') {
        throw new Error(`STRICT_EXPRESSION_TERMINAL_RESOLUTION_MISSING:${proposal.expressionId}`);
      }
      return {
        expressionId: proposal.expressionId,
        terminalFate: terminal.terminalFate,
        terminalReceiptId: terminal.terminalReceiptId,
        terminalReceiptHash: terminal.terminalReceiptHash,
        ...(terminal.dispositionReview ? { dispositionReview: terminal.dispositionReview } : {}),
        ...(terminal.matchingRepresentativeId
          ? { matchingRepresentativeId: terminal.matchingRepresentativeId }
          : {}),
        ...(terminal.matchingContentReadyRecipeId
          ? { matchingContentReadyRecipeId: terminal.matchingContentReadyRecipeId }
          : {}),
      };
    });
    const receipt = createStrictHypothesisExpressionSetReceiptV1({
      expressionSet: set,
      parentReceipt: parentReceipt ?? null,
      privateCorpusRevision,
      terminalHead: true,
      terminalResolutions,
    });
    receiptById.set(receipt.receiptId, receipt);
    receipts.push(receipt);
  }
  return receipts;
}

function prepareStrictAdmissionCandidate(
  context: StrictPersistenceContext,
  set: StrictProducerExpressionSetV1,
  proposal: StrictProposal
) {
  const moduleId = exactlyOne(proposal.authored.scope.moduleIds, 'STRICT_AUTHORED_MODULE_REQUIRED');
  const dimensionId = exactlyOne(
    proposal.authored.scope.dimensionIds,
    'STRICT_AUTHORED_DIMENSION_REQUIRED'
  );
  const item = toRecipeItem(proposal, moduleId, dimensionId, context.input.evidence);
  const reviewed = createRecipeCandidateFingerprintProjectionV1({
    title: proposal.authored.title,
    kind: proposal.authored.kind,
    category: item.category ?? '',
    trigger: item.trigger ?? '',
    whenClause: item.whenClause ?? '',
    doText: proposal.authored.doClause,
    dontText: proposal.authored.dontClause,
    coreCode: item.coreCode ?? '',
    pattern: item.content?.pattern ?? '',
    markdown: proposal.authored.markdown,
    usageGuide: proposal.authored.usageGuide,
    retrievalProfile: item.retrievalProfile,
    negativeIntents: proposal.authored.negativeIntent,
    scopeId: moduleId,
    moduleId,
    dimensionId,
    evidenceRefs: item.sourceRefs ?? [],
    lineageHashes: [set.lineage.lineageHash, set.repairNode.nodeHash],
    persistedPayload: createStrictRecipePersistedPayloadV1(item, 'alembic-agent'),
  });
  const g1 = createStrictG1ReceiptV1({
    candidateFingerprint: reviewed.authoredFingerprint,
    retrievalReadinessHash: hashCanonicalJson(item.retrievalProfile),
    rows: evaluateStrictG1Axes({ dimensionId, item, moduleId, proposal, reviewed, set }),
  });
  return { item, reviewed, g1, moduleId, dimensionId };
}

async function persistStrictDispositionTerminal(
  context: StrictPersistenceContext,
  accumulators: StrictPersistenceAccumulators,
  set: StrictProducerExpressionSetV1,
  proposal: StrictProposal,
  g1: StrictG1ReceiptV1,
  admission: StrictAdmissionReceiptV1
): Promise<void> {
  if (admission.disposition === 'reject') {
    recordStrictRejectedTerminal(
      accumulators,
      proposal.expressionId,
      'admission-rejected',
      admission.admissionId,
      admission.receiptHash
    );
    return;
  }
  const targetRecipeId = admission.consolidation.targetRecipeId;
  const targetReadyMember = accumulators.readyMembers.find(
    (member) => member.recipeId === targetRecipeId
  );
  if (
    !targetRecipeId ||
    !targetReadyMember ||
    (proposal.matchingRepresentativeId && proposal.matchingRepresentativeId !== targetRecipeId) ||
    admission.complete !== true ||
    admission.truncated !== false ||
    admission.continuation !== null
  ) {
    throw new Error(`STRICT_DISPOSITION_REVIEW_MISMATCH:${proposal.expressionId}`);
  }
  const terminalFate =
    admission.disposition === 'merge'
      ? ('reviewed-merge' as const)
      : ('reviewed-duplicate' as const);
  const dispositionProposal = {
    reviewKind: 'producer-non-draft',
    populationHash: set.lineage.populationHash,
    hypothesisId: set.hypothesis.hypothesisId,
    expression: {
      expressionId: proposal.expressionId,
      authoredFingerprint: proposal.authoredFingerprint,
      terminalFate,
      matchingRepresentativeId: targetRecipeId,
      matchingContentReadyRecipeId: targetRecipeId,
    },
    zeroDisposition: null,
  } as const;
  const proposedDispositionHash = hashKnowledgeDispositionProposalV1(dispositionProposal);
  const producer = createProductionActorIdentityV1({
    providerId: 'alembic-agent',
    modelId: context.input.producerModelHash,
    modelVersion: 'strict-producer-expression-v1',
    promptHash: normalizeStrictActorHash(set.repairNode.reasonHash),
    runId: set.lineage.runId,
    invocationId: `producer:${set.setId}`,
    loadReceiptHash: normalizeStrictActorHash(set.repairNode.modelHash),
    outputHash: normalizeStrictActorHash(set.repairNode.outputHash),
  });
  const { induction, falsification, population } = resolveProducerReviewLineage(
    context.input.analysis,
    set
  );
  const semanticAdmission = createProducerSemanticAdmissionAuthority(
    context,
    proposal,
    g1,
    admission
  );
  const semanticRequest = createAgentSemanticDispositionReviewRequestV1({
    strictWorkflowRunId: context.input.runId,
    sourceRevisionVectorHash: context.input.evidence.sourceRevisionVectorHash,
    currentAnalysisFixpointHash: context.input.analysisFixpointHash,
    populationHash: set.lineage.populationHash,
    proposedDispositionHash,
    finalExpandedSchedule: context.input.finalExpandedSchedule,
    executionReceipts: context.input.executionReceipts,
    evidence: createStrictSemanticReviewEvidenceV1({
      evidenceEntryIds: proposal.authored.evidenceEntryIds,
      executionReceipts: context.input.executionReceipts,
      session: context.input.semanticReviewSession,
      sourceRevisionVectorHash: context.input.evidence.sourceRevisionVectorHash,
      semanticRole: 'producer-non-draft-comparison-authority',
    }),
    calibration: context.input.semanticReviewSession.calibration('producer-non-draft'),
    producer,
    context: {
      reviewKind: 'producer-non-draft',
      privateCorpusRevision: context.revisionId,
      analysisFixpoint: context.input.analysis.fixpoint,
      population,
      induction,
      falsification,
      proposal: dispositionProposal,
      expressionSetReceiptId: `expression-set:${set.setId}`,
      g1Receipt: semanticAdmission.g1,
      admissionReceipt: semanticAdmission.admission,
      target: {
        expressionId: proposal.expressionId,
        authoredFingerprint: proposal.authoredFingerprint,
        terminalFate,
        targetRecipeId,
        targetFingerprint: targetReadyMember.authoredFingerprint,
        targetReadyProofHash: targetReadyMember.proofHash,
      },
    },
  });
  const { dispositionReview } = await executeStrictDispositionReviewV5({
    checkpoint: context.input.semanticReviewCheckpoint,
    semanticRequest,
    session: context.input.semanticReviewSession,
  });
  accumulators.expressionTerminalRows.push({
    expressionId: proposal.expressionId,
    recipeId: targetRecipeId,
    terminalFate,
    terminalReceiptId: dispositionReview.reviewReceiptId,
    terminalReceiptHash: dispositionReview.receiptHash,
    dispositionReview,
    matchingRepresentativeId: targetRecipeId,
    matchingContentReadyRecipeId: targetRecipeId,
  });
}

function createProducerSemanticAdmissionAuthority(
  context: StrictPersistenceContext,
  proposal: StrictProposal,
  persistenceG1: StrictG1ReceiptV1,
  persistenceAdmission: StrictAdmissionReceiptV1
): { readonly g1: StrictG1ReceiptV1; readonly admission: StrictAdmissionReceiptV1 } {
  // Agent expression receipt 的 authoredFingerprint 是 producer 终态身份；Main 的
  // RecipeCandidateFingerprint 则包含 persisted payload/lineage，属于 persistence 身份。
  // 两者不能混用。这里在与 gateway 完全相同的 accepted-corpus snapshot 上重新执行
  // Core canonical G1/Admission 封印，专供 producer-non-draft V5 语义终态证明。
  const g1 = createStrictG1ReceiptV1({
    candidateFingerprint: proposal.authoredFingerprint,
    retrievalReadinessHash: persistenceG1.retrievalReadinessHash,
    rows: persistenceG1.rows,
  });
  const corpusInspection = createStrictAcceptedCorpusInspectionV1({
    runId: persistenceAdmission.runId,
    analysisFixpointHash: persistenceAdmission.analysisFixpointHash,
    privateCorpusRevision: persistenceAdmission.privateCorpusRevision,
    revisionRootManifestHash: persistenceAdmission.revisionRootManifestHash,
    entries: context.acceptedCorpus,
  });
  if (
    corpusInspection.inspectionHash !== persistenceAdmission.acceptedCorpusInspectionHash ||
    corpusInspection.acceptedCorpusHash !== persistenceAdmission.acceptedCorpusHash
  ) {
    throw new Error('STRICT_SEMANTIC_REVIEW_ADMISSION_SNAPSHOT_MISMATCH');
  }
  const admission = createStrictAdmissionReceiptV1({
    g1Receipt: g1,
    corpusInspection,
    inputFingerprint: proposal.authoredFingerprint,
    finalAdmittedFingerprint: proposal.authoredFingerprint,
    exactMatches: persistenceAdmission.exactMatches,
    semanticMatches: persistenceAdmission.semanticMatches,
    consolidation: persistenceAdmission.consolidation,
    algorithmVersion: persistenceAdmission.algorithmVersion,
  });
  if (admission.disposition !== persistenceAdmission.disposition) {
    throw new Error('STRICT_SEMANTIC_REVIEW_ADMISSION_DECISION_MISMATCH');
  }
  return Object.freeze({ g1, admission });
}

function resolveProducerReviewLineage(
  analysis: StrictAnalysisExecutionResultV1,
  set: StrictProducerExpressionSetV1
) {
  const epoch = analysis.epochs.find(
    (candidate) =>
      candidate.population.populationHash === set.lineage.populationHash &&
      candidate.inductions.some(
        (receipt) => receipt.receiptHash === set.lineage.inductionReceiptHash
      ) &&
      candidate.falsifications.some(
        (receipt) => receipt.receiptHash === set.lineage.falsificationReceiptHash
      )
  );
  const induction = epoch?.inductions.find(
    (receipt) => receipt.receiptHash === set.lineage.inductionReceiptHash
  );
  const falsification = epoch?.falsifications.find(
    (receipt) => receipt.receiptHash === set.lineage.falsificationReceiptHash
  );
  if (!epoch || !induction || !falsification) {
    throw new Error(`STRICT_SEMANTIC_REVIEW_LINEAGE_MISSING:${set.setId}`);
  }
  return {
    induction,
    falsification,
    population: epoch.population,
  };
}

function normalizeStrictActorHash(value: string): string {
  return /^sha256:[a-f0-9]{64}$/u.test(value)
    ? value
    : /^[a-f0-9]{64}$/u.test(value)
      ? `sha256:${value}`
      : hashCanonicalJson(value);
}

function createStrictIndependentReviewer(input: StrictPrivateCorpusPersistenceInput) {
  return new IndependentValueReviewer({
    identity: input.reviewer.identity,
    chat: async (prompt) => {
      const result = await input.agentService.run({
        profile: { id: 'plan-selection' },
        message: {
          role: 'internal',
          content: prompt,
          metadata: { task: 'strict-independent-value-review' },
        },
        context: { source: 'system-workflow', runtimeSource: 'system' },
        execution: { toolChoiceOverride: 'none' },
        presentation: { responseShape: 'system-task-result' },
      });
      if (result.status !== 'success' || result.toolCalls.length > 0) {
        throw new Error('STRICT_INDEPENDENT_REVIEW_RUN_FAILED');
      }
      return result.reply;
    },
  });
}

function createStrictG2FromIndependentReview(
  context: StrictPersistenceContext,
  set: StrictProducerExpressionSetV1,
  g1: StrictG1ReceiptV1,
  admission: StrictAdmissionReceiptV1,
  reviewed: StrictReviewedProjection,
  review: IndependentReviewDecisionV1
): StrictG2ReceiptV1 {
  const axisNames: Record<
    IndependentReviewDecisionV1['axes'][number]['axis'],
    Parameters<typeof createStrictG2ReceiptV1>[0]['rows'][number]['axis']
  > = {
    entailment: 'entailment',
    'contradiction-free': 'contradiction-free',
    'project-specificity': 'project-specificity-nontriviality',
    actionability: 'actionability',
    'scope-correctness': 'scope-generalization-correctness',
    'retrieval-fitness': 'retrieval-negative-intent-fitness',
  };
  return createStrictG2ReceiptV1({
    g1Receipt: g1,
    admissionReceipt: admission,
    reviewedFingerprint: reviewed.authoredFingerprint,
    producer: {
      identity: `producer/${context.input.producerModelHash}`,
      method: 'strict-producer-expression-v1',
      modelHash: context.input.producerModelHash,
      promptHash: set.repairNode.reasonHash,
    },
    reviewer: {
      identity: `${review.reviewerIdentity.provider}/${review.reviewerIdentity.model}/${review.reviewerIdentity.method}`,
      method: review.reviewerIdentity.method,
      modelHash: hashCanonicalJson(review.reviewerIdentity),
      promptHash: context.input.reviewer.calibrationReceiptHash,
    },
    rows: review.axes.map((row) => ({
      axis: axisNames[row.axis],
      axisVerdict:
        row.verdict === 'pass' ? ('pass' as const) : row.verdict === 'narrow' ? 'revise' : 'fail',
      score: row.score,
      reasonCode: row.reasonCode,
      evidenceRefs: row.evidenceEntryIds,
      repairable: row.verdict === 'narrow',
    })),
    novelty: {
      decision:
        review.noveltyDecision === 'novel-project-specific'
          ? 'novel-project-specific'
          : review.noveltyDecision === 'known-general'
            ? 'generic'
            : 'already-covered',
      reasonCode: review.reasonCode,
      evidenceRefs: review.axes.flatMap((row) => row.evidenceEntryIds),
    },
    duplicate: {
      decision: 'no-match',
      reasonCode: 'core-admission-complete-corpus-no-match',
      evidenceRefs: review.axes.flatMap((row) => row.evidenceEntryIds),
      admissionAlgorithmVersion: admission.algorithmVersion,
      comparedPrivateCorpusRevision: admission.privateCorpusRevision,
      matchedRecipeIds: [],
      matchedFingerprints: [],
      targetRecipeId: null,
      consolidationFingerprint: null,
    },
    repairAttempt: set.version - 1,
    calibrationReceiptHash: context.input.reviewer.calibrationReceiptHash,
    ruleVersion: 'alembic-main-independent-value-g2-v1',
    permittedRepairFields: review.verdict === 'narrow' ? ['authored-projection'] : [],
  });
}

function currentAcceptedCorpusRoot(
  revisionId: string,
  entries: readonly StrictAcceptedCorpusEntryV1[]
): string {
  return hashCanonicalJson({
    schemaVersion: 1,
    revisionId,
    acceptedEntries: entries
      .map((entry) => ({
        recipeId: entry.recipeId,
        authoredFingerprint: entry.projection.authoredFingerprint,
      }))
      .sort((left, right) => left.recipeId.localeCompare(right.recipeId)),
  });
}

async function prepareStrictDraftPersistence(
  context: StrictPersistenceContext,
  set: StrictProducerExpressionSetV1,
  _proposal: StrictProposal,
  moduleId: string,
  dimensionId: string,
  item: CreateRecipeItem,
  reviewed: StrictReviewedProjection,
  g1: StrictG1ReceiptV1,
  admission: StrictAdmissionReceiptV1,
  g2: StrictG2ReceiptV1
): Promise<StrictDraftPreparation> {
  const journalStepHash = context.input.journal.entries.at(-1)?.entryHash;
  if (!journalStepHash) {
    throw new Error('STRICT_PERSISTENCE_JOURNAL_STEP_REQUIRED');
  }
  const dbHash = hashCanonicalJson({
    kind: 'strict-db-row-projection-v1',
    revisionId: context.revisionId,
    reviewed,
  });
  const fileHash = hashCanonicalJson({
    kind: 'strict-recipe-file-projection-v1',
    markdown: reviewed.markdown,
    retrievalProfile: item.retrievalProfile,
  });
  const prepared = prepareRecipePersistenceV1({
    runId: context.input.runId,
    analysisFixpointHash: context.input.analysisFixpointHash,
    privateCorpusRevision: context.revisionId,
    admissionId: admission.admissionId,
    cellId: `${moduleId}::${dimensionId}`,
    authoredFingerprint: reviewed.authoredFingerprint,
    causalParentIds: set.repairNode.parentNodeIds,
    expectedDbHash: dbHash,
    expectedFileHash: fileHash,
    journalStepHash,
  });
  context.reviewedById.set(prepared.preparedRecipeId, reviewed);
  context.expectedById.set(prepared.preparedRecipeId, { dbHash, fileHash });
  context.preparedAuthorities.set(prepared.preparedRecipeId, { g1, admission, g2 });
  const rowCheckpointPath = path.join(
    context.input.recoveryRoot,
    `${prepared.preparedRecipeId}.json`
  );
  const rowCheckpoint = await readPreparedRowCheckpoint(rowCheckpointPath, prepared.preparedHash);
  return {
    item,
    reviewed,
    g1,
    admission,
    g2,
    journalStepHash,
    dbHash,
    fileHash,
    prepared,
    rowCheckpointPath,
    rowCheckpoint,
    moduleId,
  };
}

function reconcileStrictSourceRefs(
  context: StrictPersistenceContext,
  proposal: StrictProposal,
  persisted: StrictPersistedCandidate
): string[] {
  const sourcePaths = buildStrictSourceRefs(proposal, context.input.evidence).map((sourceRef) =>
    evidencePath(sourceRef)
  );
  for (const sourcePath of sourcePaths) {
    context.repositories.recipeSourceRefRepository.upsert({
      recipeId: persisted.recipe.id,
      sourcePath,
      status: 'active',
      verifiedAt: Date.now(),
    });
  }
  return sourcePaths;
}

async function resolveStrictPreparedBinding(
  context: StrictPersistenceContext,
  draft: StrictDraftPreparation,
  persisted: StrictPersistedCandidate,
  sourcePaths: readonly string[]
): Promise<StrictResolvedPreparedBinding> {
  if (draft.rowCheckpoint) {
    if (
      draft.rowCheckpoint.g1ReceiptHash !== draft.g1.receiptHash ||
      draft.rowCheckpoint.admissionReceiptHash !== draft.admission.receiptHash ||
      draft.rowCheckpoint.g2ReceiptHash !== draft.g2.receiptHash ||
      draft.rowCheckpoint.binding.recipeId !== persisted.recipe.id ||
      draft.rowCheckpoint.binding.authoredFingerprint !== draft.reviewed.authoredFingerprint
    ) {
      throw new Error('STRICT_PREPARED_ROW_CHECKPOINT_DIVERGENCE');
    }
    return {
      persistence: draft.rowCheckpoint.persistence,
      refs: draft.rowCheckpoint.refs,
      binding: draft.rowCheckpoint.binding,
    };
  }
  if (persisted.recipe.lifecycle !== 'pending' && persisted.recipe.lifecycle !== 'staging') {
    throw new Error('STRICT_PREPARED_ROW_CHECKPOINT_MISSING');
  }
  const persistence = createStrictPersistenceReceiptV1({
    prepared: draft.prepared,
    g1Receipt: draft.g1,
    admissionReceipt: draft.admission,
    g2Receipt: draft.g2,
    actualRecipeId: persisted.recipe.id,
    actualAuthoredFingerprint: draft.reviewed.authoredFingerprint,
    storageHash: hashCanonicalJson({ dbHash: draft.dbHash, fileHash: draft.fileHash }),
    databaseRowHash: draft.dbHash,
    fileHash: draft.fileHash,
    actualLifecycle: persisted.recipe.lifecycle,
  });
  const refs = createRefReconciliationReceiptV1({
    persistence,
    sourceRefIds: sourcePaths,
    reasoningSourceIds: sourcePaths,
    bridgeRefIds: context.repositories.recipeSourceRefRepository
      .findByRecipeId(persisted.recipe.id)
      .map((row) => row.sourcePath),
    blockerCodes: [],
  });
  const binding = createRecipeProductionBindingV1({
    persistence,
    refReconciliation: refs,
    runId: context.input.runId,
    manifestHash: context.input.manifestHash,
    planHash: context.input.planHash,
    cellId: draft.prepared.cellId,
    moduleId: draft.moduleId,
  });
  await writePreparedRowCheckpoint(draft.rowCheckpointPath, {
    preparedHash: draft.prepared.preparedHash,
    g1ReceiptHash: draft.g1.receiptHash,
    admissionReceiptHash: draft.admission.receiptHash,
    g2ReceiptHash: draft.g2.receiptHash,
    persistence,
    refs,
    binding,
  });
  return { persistence, refs, binding };
}

async function createStrictReadyMemberProof(input: {
  readonly active: Awaited<ReturnType<RecipeProductionGateway['publish']>>;
  readonly binding: RecipeProductionBindingV1;
  readonly fileWriter: KnowledgeFileWriter;
  readonly persistence: StrictPersistenceReceiptV1;
  readonly refRepository: ReturnType<typeof createAlembicRepositories>['recipeSourceRefRepository'];
  readonly refs: RefReconciliationReceiptV1;
  readonly repository: ReturnType<typeof createAlembicRepositories>['knowledgeRepository'];
  readonly reviewed: StrictReviewedProjection;
  readonly sourcePaths: readonly string[];
}): Promise<StrictReadyMemberProofV1> {
  if (input.active.lifecycle !== 'active') {
    throw new Error('STRICT_READY_MEMBER_LIFECYCLE_INVALID');
  }
  const readback = await readStrictReadyDatabase(input);
  assertStrictDatabaseProjection(input);
  const databaseReadbackHash = hashStrictReadyDatabaseReadback(readback);
  const fileReadbackHash = await readStrictReadyFile(input, readback);
  const refReadbackHash = readStrictReadyRefs(input, readback.id);
  const semantic = buildStrictReadyMemberSemantic(
    input,
    readback,
    databaseReadbackHash,
    fileReadbackHash,
    refReadbackHash
  );
  return freezeDeep({ ...semantic, proofHash: hashCanonicalJson(semantic) });
}

async function readStrictReadyDatabase(input: {
  readonly active: { readonly id: string };
  readonly repository: StrictKnowledgeRepository;
  readonly reviewed: StrictReviewedProjection;
}): Promise<StrictKnowledgeEntry> {
  const readback = await input.repository.findById(input.active.id);
  const json = readback?.toJSON() as Record<string, unknown> | undefined;
  if (
    !readback ||
    !json ||
    readback.lifecycle !== 'active' ||
    json.title !== input.reviewed.title ||
    json.kind !== input.reviewed.kind ||
    json.doClause !== input.reviewed.doText ||
    json.dontClause !== input.reviewed.dontText ||
    !sameMarkdown(json.content, input.reviewed.markdown) ||
    hashCanonicalJson(json.retrievalProfile) !== hashCanonicalJson(input.reviewed.retrievalProfile)
  ) {
    throw new Error('STRICT_READY_MEMBER_DATABASE_READBACK_FAILED');
  }
  return readback;
}

function assertStrictDatabaseProjection(input: {
  readonly binding: RecipeProductionBindingV1;
  readonly persistence: StrictPersistenceReceiptV1;
  readonly reviewed: StrictReviewedProjection;
}): void {
  const expected = hashCanonicalJson({
    kind: 'strict-db-row-projection-v1',
    revisionId: input.binding.privateCorpusRevision,
    reviewed: input.reviewed,
  });
  if (input.persistence.databaseRowHash !== expected) {
    throw new Error('STRICT_READY_MEMBER_DATABASE_READBACK_FAILED');
  }
}

async function readStrictReadyFile(
  input: {
    readonly fileWriter: KnowledgeFileWriter;
    readonly persistence: StrictPersistenceReceiptV1;
    readonly reviewed: StrictReviewedProjection;
  },
  readback: StrictKnowledgeEntry
): Promise<string> {
  const resolvedFile = input.fileWriter._resolveFilePath(readback);
  const fileBytes = await fsp.readFile(path.join(resolvedFile.dir, resolvedFile.filename));
  const fileReadback = parseKnowledgeMarkdown(fileBytes.toString('utf8'));
  const expectedProjectionHash = hashCanonicalJson({
    kind: 'strict-recipe-file-projection-v1',
    markdown: input.reviewed.markdown,
    retrievalProfile: input.reviewed.retrievalProfile,
  });
  if (
    fileReadback.id !== readback.id ||
    fileReadback.title !== input.reviewed.title ||
    fileReadback.lifecycle !== 'active' ||
    fileReadback.kind !== input.reviewed.kind ||
    fileReadback.doClause !== input.reviewed.doText ||
    fileReadback.dontClause !== input.reviewed.dontText ||
    !sameMarkdown(fileReadback.content, input.reviewed.markdown) ||
    hashCanonicalJson(fileReadback.retrievalProfile) !==
      hashCanonicalJson(input.reviewed.retrievalProfile) ||
    input.persistence.fileHash !== expectedProjectionHash
  ) {
    throw new Error('STRICT_READY_MEMBER_FILE_READBACK_FAILED');
  }
  return hashStrictReadyFileReadback(readback.id, fileBytes);
}

function readStrictReadyRefs(
  input: {
    readonly refRepository: ReturnType<
      typeof createAlembicRepositories
    >['recipeSourceRefRepository'];
    readonly refs: RefReconciliationReceiptV1;
    readonly sourcePaths: readonly string[];
  },
  recipeId: string
): string {
  const rows = input.refRepository.findByRecipeId(recipeId);
  const actualRefIds = rows.map((row) => row.sourcePath).sort();
  if (
    JSON.stringify([...input.sourcePaths].sort()) !== JSON.stringify(actualRefIds) ||
    JSON.stringify([...input.refs.sourceRefIds].sort()) !== JSON.stringify([...actualRefIds].sort())
  ) {
    throw new Error('STRICT_READY_MEMBER_REF_READBACK_FAILED');
  }
  return hashStrictReadyRefReadback(recipeId, rows);
}

function hashStrictReadyDatabaseReadback(entry: StrictKnowledgeEntry): string {
  return hashCanonicalJson({
    kind: 'strict-ready-database-readback-v1',
    recipeId: entry.id,
    row: entry.toJSON(),
  });
}

function hashStrictReadyFileReadback(recipeId: string, fileBytes: Buffer): string {
  return hashCanonicalJson({
    kind: 'strict-ready-file-readback-v1',
    recipeId,
    fileBytesBase64: fileBytes.toString('base64'),
  });
}

function hashStrictReadyRefReadback(
  recipeId: string,
  rows: ReturnType<
    ReturnType<typeof createAlembicRepositories>['recipeSourceRefRepository']['findByRecipeId']
  >
): string {
  const canonicalRows = rows
    .map((row) => ({
      recipeId: row.recipeId,
      sourcePath: row.sourcePath,
      status: row.status,
      newPath: row.newPath,
      verifiedAt: row.verifiedAt,
      contentFp: row.contentFp,
    }))
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  return hashCanonicalJson({
    kind: 'strict-ready-ref-readback-v1',
    recipeId,
    rows: canonicalRows,
  });
}

function buildStrictReadyMemberSemantic(
  input: {
    readonly binding: RecipeProductionBindingV1;
    readonly persistence: StrictPersistenceReceiptV1;
    readonly refs: RefReconciliationReceiptV1;
  },
  readback: StrictKnowledgeEntry,
  databaseReadbackHash: string,
  fileReadbackHash: string,
  refReadbackHash: string
): Omit<StrictReadyMemberProofV1, 'proofHash'> {
  return {
    schemaVersion: 1 as const,
    recipeId: readback.id,
    title: readback.title,
    runId: input.binding.runId,
    privateCorpusRevision: input.binding.privateCorpusRevision,
    analysisFixpointHash: input.binding.analysisFixpointHash,
    authoredFingerprint: input.binding.authoredFingerprint,
    bindingHash: input.binding.bindingHash,
    persistenceReceiptHash: input.persistence.receiptHash,
    databaseRowHash: input.persistence.databaseRowHash,
    databaseReadbackHash,
    fileHash: input.persistence.fileHash,
    fileReadbackHash,
    refReconciliationReceiptHash: input.refs.receiptHash,
    refReadbackHash,
    lifecycle: 'active' as const,
  };
}

function evaluateStrictG1Axes(input: {
  readonly dimensionId: string;
  readonly item: CreateRecipeItem;
  readonly moduleId: string;
  readonly proposal: StrictProducerExpressionSetV1['proposals'][number];
  readonly reviewed: ReturnType<typeof createRecipeCandidateFingerprintProjectionV1>;
  readonly set: StrictProducerExpressionSetV1;
}) {
  const evidenceRefs = [...input.proposal.authored.evidenceEntryIds];
  const sourceRefs = [...(input.item.sourceRefs ?? [])];
  const profile = input.item.retrievalProfile;
  const negativeIntents = [...input.proposal.authored.negativeIntent].sort();
  const profileExclusions = [...(profile?.exclusions.map((row) => row.text) ?? [])].sort();
  const serialized = JSON.stringify(input.proposal.authored);
  const checks: Record<(typeof STRICT_G1_HARD_AXES_V1)[number], boolean> = {
    'schema-and-field-policy': [
      input.item.title,
      input.item.doClause,
      input.item.dontClause,
      input.item.usageGuide,
      input.item.content?.markdown,
    ].every((value) => typeof value === 'string' && value.trim().length > 0),
    'manifest-session-cell-module-identity':
      input.proposal.authored.scope.moduleIds.length === 1 &&
      input.proposal.authored.scope.dimensionIds.length === 1 &&
      input.item.moduleName === input.moduleId &&
      input.item.dimensionId === input.dimensionId,
    'source-confinement-revision-and-snippet':
      evidenceRefs.length > 0 &&
      evidenceRefs.every((ref) => /^E-\d+$/u.test(ref)) &&
      evidenceRefs.every((ref) => sourceRefs.includes(ref)) &&
      sourceRefs.some((ref) => /:\d+-\d+$/u.test(ref)),
    'claimed-graph-and-source-ref-integrity':
      new Set(sourceRefs).size === sourceRefs.length &&
      evidenceRefs.every((ref) => sourceRefs.includes(ref)),
    'retrieval-usage-negative-intent-provenance':
      Boolean(profile?.summary.primary && profile.summary.technicalEnglish) &&
      JSON.stringify(negativeIntents) === JSON.stringify(profileExclusions) &&
      evidenceRefs.every((ref) => profile?.provenance.evidenceRefs.includes(ref)),
    'credential-private-data-redaction':
      !/(?:sk-[a-z0-9_-]{12,}|api[_-]?key\s*=|-----BEGIN [A-Z ]*PRIVATE KEY-----|\/Users\/|\/home\/)/iu.test(
        serialized
      ),
    'structured-lineage-and-fingerprint': Boolean(
      input.reviewed.authoredFingerprint &&
        input.set.lineage.lineageHash &&
        input.set.repairNode.nodeHash
    ),
    'fact-population-cluster-hypothesis-falsification-lineage':
      input.set.lineage.hypothesis.premiseFactIds.length > 0 &&
      Boolean(
        input.set.lineage.populationHash &&
          input.set.lineage.clusterSetHash &&
          input.set.lineage.inductionReceiptHash &&
          input.set.lineage.analysisFixpointHash
      ),
  };
  return STRICT_G1_HARD_AXES_V1.map((axis) => {
    if (!checks[axis]) {
      throw new Error(`STRICT_PRIVATE_CORPUS_G1_AXIS_FAILED:${axis}`);
    }
    return {
      axis,
      verdict: 'pass' as const,
      reasonCode: `validated:${axis}`,
      evidenceRefs,
    };
  });
}

export async function indexSealAndVerifyStrictPrivateCorpus(input: {
  readonly baseResolver: WorkspaceResolver;
  readonly content: StrictPrivateCorpusContentResultV1;
  readonly expectedCurrentContext: PrivateCorpusRevisionExpectedContextV1;
  readonly embedProvider: ConstructorParameters<
    typeof RecipeVectorGenerationRuntime
  >[0]['embedProvider'];
  readonly onStage?: (stage: 'PRIVATE_CORPUS_SEALED' | 'PRIVATE_INDEXES_VERIFIED') => void;
}): Promise<StrictPrivateCorpusResultV1> {
  validatePrivateCorpusRevisionCheckpointV1(
    input.content.revisionCheckpointReceipt,
    input.content.revisionInitReceipt,
    input.expectedCurrentContext
  );
  const rehydrated = await rehydratePrivateCorpusRevisionV1(
    input.baseResolver,
    input.content.revisionInitReceipt,
    input.expectedCurrentContext
  );
  let vectorGenerationId: string | null = null;
  let vectorManifest: RecipeVectorGenerationManifest | null = null;
  let vectorInspection: RecipeVectorGenerationInspection | null = null;
  try {
    const repositories = createAlembicRepositories(rehydrated.runtime.connection);
    const knowledgeService = createKnowledgeService(rehydrated.handle.resolver, repositories);
    const writeZone = new WriteZone(rehydrated.handle.resolver);
    const baseVectorStore = await createLocalVectorStore(rehydrated.handle.resolver.dataRoot, {
      kind: 'json',
      json: { writeZone },
    });
    const vectorStorage = new FileRecipeVectorGenerationStorage({
      baseStore: baseVectorStore,
      dataRoot: rehydrated.handle.resolver.dataRoot,
      createStore: (root) =>
        createLocalVectorStoreSync(root, { kind: 'json', json: { writeZone } }),
    });
    const vectorManager = new RecipeVectorGenerationManager(vectorStorage, vectorStorage);
    const vectorRuntime = new RecipeVectorGenerationRuntime({
      embedProvider: input.embedProvider,
      generationManager: vectorManager,
      knowledgeService,
      storage: vectorStorage,
    });
    rehydrated.handle.seal(input.content.rootManifestHash);
    input.onStage?.('PRIVATE_CORPUS_SEALED');
    const vectorBuild = await vectorRuntime.rebuild('full-build');
    if (
      (vectorBuild.status !== 'activated' && vectorBuild.status !== 'already-active') ||
      !vectorBuild.generationId ||
      vectorBuild.manifest?.status !== 'ready' ||
      vectorBuild.inspection?.healthy !== true
    ) {
      throw new Error('STRICT_PRIVATE_CORPUS_VECTOR_NOT_READY');
    }
    vectorGenerationId = vectorBuild.generationId;
    vectorManifest = vectorBuild.manifest;
    vectorInspection = vectorBuild.inspection;
    // 只有真实向量 generation 已激活且 inspection 通过后，才能宣称 index 边界已完成。
    input.onStage?.('PRIVATE_INDEXES_VERIFIED');
  } finally {
    rehydrated.runtime.close();
  }
  const freshProcess = await rehydratePrivateCorpusRevisionV1(
    input.baseResolver,
    input.content.revisionInitReceipt,
    input.expectedCurrentContext
  );
  try {
    if (!vectorGenerationId || !vectorManifest || !vectorInspection) {
      throw new Error('STRICT_PRIVATE_CORPUS_VECTOR_NOT_READY');
    }
    const repositories = createAlembicRepositories(freshProcess.runtime.connection);
    const active = await repositories.knowledgeRepository.findByLifecycle('active', {
      page: 1,
      pageSize: Math.max(1, input.content.activeRecipes.length + 1),
    });
    const freshActiveIds = active.data.flatMap((entry) => (entry ? [entry.id] : [])).sort();
    const expectedActiveIds = input.content.activeRecipes.map((recipe) => recipe.id).sort();
    if (JSON.stringify(freshActiveIds) !== JSON.stringify(expectedActiveIds)) {
      throw new Error('STRICT_PRIVATE_CORPUS_FRESH_REHYDRATE_DIVERGENCE');
    }
    const fileWriter = new KnowledgeFileWriter(
      freshProcess.handle.resolver.dataRoot,
      new WriteZone(freshProcess.handle.resolver)
    );
    const sealedCorpusVerification = await verifyStrictSealedCorpus({
      activeRecipes: input.content.activeRecipes,
      readyMembers: input.content.readyMembers,
      repository: repositories.knowledgeRepository,
      fileWriter,
      refRepository: repositories.recipeSourceRefRepository,
      vectorGenerationId,
      vectorManifest,
      vectorInspection,
    });
    freshProcess.handle.seal(input.content.rootManifestHash);
    const freshProcessRehydrateHash = hashCanonicalJson({
      activeRecipeIds: freshActiveIds,
      initReceiptHash: freshProcess.handle.initReceipt.initReceiptHash,
      migrationLedgerSemanticHash: freshProcess.handle.initReceipt.migrationLedgerSemanticHash,
      revisionId: freshProcess.handle.initReceipt.revisionId,
      rootManifestHash: input.content.rootManifestHash,
      vectorGenerationId,
      vectorManifestHash: vectorManifest.manifestHash,
      sealedCorpusVerificationHash: sealedCorpusVerification.verificationHash,
    });
    return Object.freeze({
      ...input.content,
      activeRecipeIds: expectedActiveIds,
      freshProcessRehydrateHash,
      sealedCorpusVerification,
      vectorGenerationId,
      vectorManifestHash: vectorManifest.manifestHash,
    });
  } finally {
    freshProcess.runtime.close();
  }
}

function createKnowledgeService(
  resolver: WorkspaceResolver,
  repositories: ReturnType<typeof createAlembicRepositories>,
  fileWriter = new KnowledgeFileWriter(resolver.dataRoot, new WriteZone(resolver)),
  graph = new KnowledgeGraphService(repositories.knowledgeEdgeRepository)
): KnowledgeService {
  return new KnowledgeService(
    repositories.knowledgeRepository as unknown as ConstructorParameters<
      typeof KnowledgeService
    >[0],
    { async log() {} },
    null,
    graph,
    { fileWriter }
  );
}

interface StrictSealedCorpusVerificationInput {
  readonly activeRecipes: StrictPrivateCorpusContentResultV1['activeRecipes'];
  readonly readyMembers: readonly StrictReadyMemberProofV1[];
  readonly repository: StrictKnowledgeRepository;
  readonly fileWriter: Pick<KnowledgeFileWriter, '_resolveFilePath'>;
  readonly refRepository: Pick<
    ReturnType<typeof createAlembicRepositories>['recipeSourceRefRepository'],
    'findByRecipeId'
  >;
  readonly vectorGenerationId: string;
  readonly vectorManifest: Pick<
    RecipeVectorGenerationManifest,
    | 'generationId'
    | 'manifestHash'
    | 'status'
    | 'recipeCount'
    | 'expectedIds'
    | 'expectedIdsByRecipe'
  >;
  readonly vectorInspection: RecipeVectorGenerationInspection;
}

interface StrictSparseEvidenceV1 {
  readonly recipeId: string | undefined;
  readonly resultIds: readonly string[];
}

interface StrictSealedStoreReadbacksV1 {
  readonly durableReadbackHash: string;
  readonly refReadbackHash: string;
}

export async function verifyStrictSealedCorpus(
  input: StrictSealedCorpusVerificationInput
): Promise<StrictSealedCorpusVerificationV1> {
  const expectedIds = input.activeRecipes.map((recipe) => recipe.id).sort();
  const readyMembers = [...input.readyMembers].sort((left, right) =>
    left.recipeId.localeCompare(right.recipeId)
  );
  assertSealedReadyMembers(expectedIds, readyMembers);
  const storeReadbacks = await readSealedStoreMembers(input, readyMembers);
  await assertSealedActiveLifecycle(input, expectedIds);
  const sparseEvidence = await verifySealedSparseMembers(input);
  const manifestExpectedIds = assertSealedVectorGeneration(input, expectedIds);
  const semantic = buildSealedCorpusVerificationSemantic(
    input,
    expectedIds,
    readyMembers,
    storeReadbacks,
    sparseEvidence,
    manifestExpectedIds
  );
  return freezeDeep({ ...semantic, verificationHash: hashCanonicalJson(semantic) });
}

function assertSealedReadyMembers(
  expectedIds: readonly string[],
  readyMembers: readonly StrictReadyMemberProofV1[]
): void {
  if (
    new Set(expectedIds).size !== expectedIds.length ||
    JSON.stringify(readyMembers.map((member) => member.recipeId)) !== JSON.stringify(expectedIds) ||
    readyMembers.some((member) => member.lifecycle !== 'active' || !validReadyMemberProof(member))
  ) {
    failSealedCorpus('ready-member-conservation');
  }
}

async function readSealedStoreMembers(
  input: StrictSealedCorpusVerificationInput,
  readyMembers: readonly StrictReadyMemberProofV1[]
): Promise<StrictSealedStoreReadbacksV1> {
  const actualMembers = await Promise.all(
    readyMembers.map(async (member) => {
      let entry: StrictKnowledgeEntry | null;
      let databaseReadbackHash: string;
      try {
        entry = await input.repository.findById(member.recipeId);
        databaseReadbackHash = entry ? hashStrictReadyDatabaseReadback(entry) : '';
      } catch {
        failSealedCorpus('database-readback-conservation');
      }
      if (!entry || databaseReadbackHash !== member.databaseReadbackHash) {
        failSealedCorpus('database-readback-conservation');
      }

      let fileReadbackHash: string;
      try {
        const resolvedFile = input.fileWriter._resolveFilePath(entry);
        const fileBytes = await fsp.readFile(path.join(resolvedFile.dir, resolvedFile.filename));
        fileReadbackHash = hashStrictReadyFileReadback(member.recipeId, fileBytes);
      } catch {
        failSealedCorpus('file-readback-conservation');
      }
      if (fileReadbackHash !== member.fileReadbackHash) {
        failSealedCorpus('file-readback-conservation');
      }

      let refReadbackHash: string;
      try {
        refReadbackHash = hashStrictReadyRefReadback(
          member.recipeId,
          input.refRepository.findByRecipeId(member.recipeId)
        );
      } catch {
        failSealedCorpus('ref-readback-conservation');
      }
      if (refReadbackHash !== member.refReadbackHash) {
        failSealedCorpus('ref-readback-conservation');
      }

      return {
        durable: {
          recipeId: member.recipeId,
          persistenceReceiptHash: member.persistenceReceiptHash,
          databaseRowHash: member.databaseRowHash,
          databaseReadbackHash,
          fileHash: member.fileHash,
          fileReadbackHash,
        },
        refs: {
          recipeId: member.recipeId,
          refReconciliationReceiptHash: member.refReconciliationReceiptHash,
          refReadbackHash,
        },
      };
    })
  );
  const durableReadbackHash = hashCanonicalJson(actualMembers.map((member) => member.durable));
  const refReadbackHash = hashCanonicalJson(actualMembers.map((member) => member.refs));
  return { durableReadbackHash, refReadbackHash };
}

async function assertSealedActiveLifecycle(
  input: StrictSealedCorpusVerificationInput,
  expectedIds: readonly string[]
): Promise<void> {
  const byId = await Promise.all(expectedIds.map((id) => input.repository.findById(id)));
  const byTitle = await Promise.all(
    input.activeRecipes.map((recipe) => input.repository.findByTitle(recipe.title))
  );
  const listed = await input.repository.findByLifecycle('active', {
    page: 1,
    pageSize: Math.max(1, expectedIds.length + 1),
  });
  const listedIds = listed.data
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .map((entry) => entry.id)
    .sort();
  if (
    byId.some(
      (entry, index) => !entry || entry.id !== expectedIds[index] || entry.lifecycle !== 'active'
    ) ||
    byTitle.some(
      (entry, index) =>
        !entry || entry.id !== input.activeRecipes[index]?.id || entry.lifecycle !== 'active'
    ) ||
    JSON.stringify(listedIds) !== JSON.stringify(expectedIds)
  ) {
    failSealedCorpus('active-lifecycle-conservation');
  }
}

async function verifySealedSparseMembers(
  input: StrictSealedCorpusVerificationInput
): Promise<StrictSparseEvidenceV1[]> {
  const sparse = await Promise.all(
    input.activeRecipes.map((recipe) =>
      input.repository.search(recipe.title, { page: 1, pageSize: 10 })
    )
  );
  const sparseEvidence = sparse.map((page, index) => ({
    recipeId: input.activeRecipes[index]?.id,
    resultIds: page.data.flatMap((entry) => (entry ? [entry.id] : [])).sort(),
  }));
  if (
    sparseEvidence.some(
      (evidence) => !evidence.recipeId || !evidence.resultIds.includes(evidence.recipeId)
    )
  ) {
    failSealedCorpus('sparse-member-conservation');
  }
  return sparseEvidence;
}

function assertSealedVectorGeneration(
  input: StrictSealedCorpusVerificationInput,
  expectedIds: readonly string[]
): string[] {
  const issueLists = [
    input.vectorInspection.missingIds,
    input.vectorInspection.orphanIds,
    input.vectorInspection.staleIds,
    input.vectorInspection.staleGenerationIds,
    input.vectorInspection.duplicateIds,
    input.vectorInspection.partialIds,
    input.vectorInspection.hashMismatchIds,
    input.vectorInspection.dimensionMismatchIds,
  ];
  const manifestExpectedIds = [...input.vectorManifest.expectedIds].sort();
  const expectedIdsByRecipe = Object.values(input.vectorManifest.expectedIdsByRecipe).flat().sort();
  if (
    input.vectorManifest.status !== 'ready' ||
    !input.vectorGenerationId ||
    input.vectorGenerationId.trim() !== input.vectorGenerationId ||
    !isCanonicalDigest(input.vectorManifest.manifestHash) ||
    input.vectorGenerationId !== input.vectorManifest.generationId ||
    input.vectorManifest.recipeCount !== expectedIds.length ||
    JSON.stringify(Object.keys(input.vectorManifest.expectedIdsByRecipe).sort()) !==
      JSON.stringify(expectedIds) ||
    new Set(manifestExpectedIds).size !== manifestExpectedIds.length ||
    JSON.stringify(manifestExpectedIds) !== JSON.stringify(expectedIdsByRecipe) ||
    input.vectorInspection.healthy !== true ||
    input.vectorInspection.expectedCount !== input.vectorInspection.presentCount ||
    input.vectorInspection.expectedCount !== manifestExpectedIds.length ||
    issueLists.some((list) => list.length > 0)
  ) {
    failSealedCorpus('vector-generation-conservation');
  }
  return manifestExpectedIds;
}

function buildSealedCorpusVerificationSemantic(
  input: StrictSealedCorpusVerificationInput,
  expectedIds: readonly string[],
  readyMembers: readonly StrictReadyMemberProofV1[],
  storeReadbacks: StrictSealedStoreReadbacksV1,
  sparseEvidence: readonly StrictSparseEvidenceV1[],
  manifestExpectedIds: readonly string[]
): Omit<StrictSealedCorpusVerificationV1, 'verificationHash'> {
  return {
    schemaVersion: 1 as const,
    activeRecipeIds: expectedIds,
    readyMemberSetHash: hashCanonicalJson(readyMembers.map((member) => member.proofHash)),
    durableReadbackHash: storeReadbacks.durableReadbackHash,
    refReadbackHash: storeReadbacks.refReadbackHash,
    sparseEvidenceHash: hashCanonicalJson(sparseEvidence),
    vectorGenerationId: input.vectorGenerationId,
    vectorManifestHash: input.vectorManifest.manifestHash,
    vectorInspectionHash: hashCanonicalJson({
      expectedVectorIds: manifestExpectedIds,
      inspection: input.vectorInspection,
    }),
    verdict: 'pass' as const,
    failedPredicate: null,
  };
}

function validReadyMemberProof(member: StrictReadyMemberProofV1): boolean {
  const { proofHash, ...semantic } = member;
  return (
    Object.values(semantic).every((value) => typeof value !== 'string' || value.length > 0) &&
    [
      member.authoredFingerprint,
      member.bindingHash,
      member.persistenceReceiptHash,
      member.databaseRowHash,
      member.databaseReadbackHash,
      member.fileHash,
      member.fileReadbackHash,
      member.refReconciliationReceiptHash,
      member.refReadbackHash,
      member.proofHash,
    ].every(isCanonicalSha) &&
    proofHash === hashCanonicalJson(semantic)
  );
}

function failSealedCorpus(predicate: string): never {
  throw new Error(`STRICT_SEALED_CORPUS_VERIFICATION_FAILED:${predicate}`);
}

function isCanonicalSha(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isCanonicalDigest(value: unknown): value is string {
  return typeof value === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/u.test(value);
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

function toRecipeItem(
  proposal: StrictProducerExpressionSetV1['proposals'][number],
  moduleId: string,
  dimensionId: string,
  evidence: FrozenEvidenceProjectionV1
): CreateRecipeItem {
  const exclusions = readExclusionTexts(proposal.authored.retrievalProfile);
  if (
    JSON.stringify([...exclusions].sort()) !==
    JSON.stringify([...proposal.authored.negativeIntent].sort())
  ) {
    throw new Error('STRICT_AUTHORED_NEGATIVE_INTENT_MISMATCH');
  }
  const sourceRefs = buildStrictSourceRefs(proposal, evidence);
  const source: CreateRecipeItem = {
    title: proposal.authored.title,
    description: proposal.authored.doClause,
    trigger: `@strict-${proposal.expressionId.replace(/[^a-zA-Z0-9_-]/gu, '-').slice(-48)}`,
    kind: proposal.authored.kind,
    topicHint: dimensionId,
    whenClause: proposal.authored.usageGuide,
    doClause: proposal.authored.doClause,
    dontClause: proposal.authored.dontClause,
    coreCode: extractStrictCoreCode(proposal.authored.markdown),
    headers: [],
    content: {
      markdown: proposal.authored.markdown,
      pattern: '',
      rationale: proposal.authored.usageGuide,
    },
    reasoning: {
      whyStandard: proposal.authored.usageGuide,
      sources: [...proposal.authored.evidenceEntryIds],
      confidence: 1,
    },
    tags: ['strict-production', dimensionId],
    category: dimensionId,
    knowledgeType: 'code-pattern',
    language: 'en',
    usageGuide: proposal.authored.usageGuide,
    scope: moduleId,
    moduleName: moduleId,
    dimensionId,
    sourceRefs,
  };
  source.retrievalProfile = buildCoreReadyRetrievalProfile(proposal, source, exclusions);
  return source;
}

function buildStrictSourceRefs(
  proposal: StrictProducerExpressionSetV1['proposals'][number],
  evidence: FrozenEvidenceProjectionV1
): string[] {
  const entries = new Map(evidence.entries.map((entry) => [entry.evidenceEntryId, entry]));
  const bounded = proposal.authored.evidenceEntryIds.map((entryId) => {
    const entry = entries.get(entryId);
    if (!entry) {
      throw new Error(`STRICT_AUTHORED_EVIDENCE_UNKNOWN:${entryId}`);
    }
    return `${entry.relativePath}:${entry.startLine}-${entry.endLine}`;
  });
  return [...new Set([...proposal.authored.evidenceEntryIds, ...bounded])].sort();
}

function extractStrictCoreCode(markdown: string): string {
  const match = /```(?:[a-z0-9_-]+)?\n([\s\S]*?)```/iu.exec(markdown);
  const code = match?.[1]?.trim() ?? '';
  if (!code || code.split('\n').length < 3) {
    throw new Error('STRICT_AUTHORED_CORE_CODE_REQUIRED');
  }
  return code;
}

function buildCoreReadyRetrievalProfile(
  proposal: StrictProducerExpressionSetV1['proposals'][number],
  source: CreateRecipeItem,
  exclusions: readonly string[]
): NonNullable<CreateRecipeItem['retrievalProfile']> {
  const evidenceRefs = [...(source.sourceRefs ?? [])];
  const intents = readProfileTexts(proposal.authored.retrievalProfile, 'intents');
  if (intents.length === 0 || evidenceRefs.length === 0) {
    throw new Error('STRICT_RETRIEVAL_PROFILE_PROVENANCE_REQUIRED');
  }
  const technicalEnglish = [
    proposal.authored.doClause,
    proposal.authored.usageGuide,
    ...intents,
  ].find(isTechnicalEnglish);
  if (!technicalEnglish) {
    throw new Error('STRICT_RETRIEVAL_PROFILE_TECHNICAL_ENGLISH_REQUIRED');
  }
  return {
    schemaVersion: '1',
    primaryLanguage: 'en',
    summary: {
      primary: proposal.authored.doClause,
      technicalEnglish,
    },
    concepts: intents.map((term) => ({ term, language: 'en', provenanceRefs: evidenceRefs })),
    scenarios: [
      {
        text: proposal.authored.usageGuide,
        language: 'en',
        provenanceRefs: evidenceRefs,
      },
    ],
    exclusions: exclusions.map((text) => ({
      text,
      language: 'en',
      provenanceRefs: evidenceRefs,
    })),
    provenance: {
      evidenceRefs,
      sourceFieldRefs: [
        'field:title',
        'field:language',
        'field:dimensionId',
        'field:category',
        'field:knowledgeType',
        'field:kind',
        'field:tags',
        'field:description',
        'field:trigger',
        'field:topicHint',
        'field:moduleName',
        'field:whenClause',
        'field:doClause',
        'field:dontClause',
        'field:usageGuide',
        'field:content.markdown',
        'field:content.rationale',
      ],
      sourceContentHash: computeStrictRecipeSourceContentHash(source),
      generator: 'alembic-main-strict-production-v1',
    },
  };
}

function computeStrictRecipeSourceContentHash(source: CreateRecipeItem): string {
  const content = readRecord(source.content);
  const reasoning = readRecord(source.reasoning);
  const identity = {
    category: readText(source.category),
    content: {
      markdown: readText(content.markdown),
      pattern: readText(content.pattern),
      rationale: readText(content.rationale),
    },
    coreCode: readText(source.coreCode),
    description: readText(source.description),
    dimensionId: readText(source.dimensionId),
    doClause: readText(source.doClause),
    dontClause: readText(source.dontClause),
    kind: readText(source.kind),
    knowledgeType: readText(source.knowledgeType),
    language: readText(source.language),
    moduleName: readText(source.moduleName),
    reasoning: {
      sources: readTexts(reasoning.sources),
      whyStandard: readText(reasoning.whyStandard),
    },
    tags: readTexts(source.tags),
    title: readText(source.title),
    topicHint: readText(source.topicHint),
    trigger: readText(source.trigger),
    usageGuide: readText(source.usageGuide),
    whenClause: readText(source.whenClause),
  };
  return createHash('sha256').update(stableStringify(identity)).digest('hex');
}

function readProfileTexts(profile: Readonly<Record<string, unknown>>, field: string): string[] {
  return readTexts(profile[field]);
}

function readTexts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  return value.flatMap((candidate) => {
    const text = readText(candidate);
    const key = text.toLowerCase().replace(/\s+/gu, ' ');
    if (!text || seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [text];
  });
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\r\n/gu, '\n').trim() : '';
}

function isTechnicalEnglish(value: string): boolean {
  const letters = value.match(/[A-Za-z]/gu)?.length ?? 0;
  const cjk = value.match(/[\u3400-\u9fff]/gu)?.length ?? 0;
  return letters >= 4 && letters > cjk;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function readExclusionTexts(profile: Readonly<Record<string, unknown>>): string[] {
  const rows = Array.isArray(profile.exclusions) ? profile.exclusions : [];
  return rows
    .map((row) =>
      row && typeof row === 'object' && 'text' in row && typeof row.text === 'string'
        ? row.text
        : ''
    )
    .filter(Boolean);
}

function sameMarkdown(content: unknown, expected: string): boolean {
  return Boolean(
    content &&
      typeof content === 'object' &&
      'markdown' in content &&
      (content as { markdown?: unknown }).markdown === expected
  );
}

function exactlyOne(values: readonly string[], code: string): string {
  if (values.length !== 1 || !values[0]) {
    throw new Error(code);
  }
  return values[0];
}

function revisionIdForFixpoint(fixpointHash: string): string {
  return `revision-${fixpointHash.replace(/^sha256:/u, '').slice(0, 24)}`;
}

function evidencePath(entryId: string): string {
  return `frozen-evidence/${entryId.replace(/[^a-zA-Z0-9:._-]/gu, '-')}`;
}

async function readPreparedRowCheckpoint(
  filePath: string,
  expectedPreparedHash: string
): Promise<StrictPreparedRowCheckpointV1 | null> {
  let parsed: StrictPreparedRowCheckpointV1;
  try {
    parsed = JSON.parse(await fsp.readFile(filePath, 'utf8')) as StrictPreparedRowCheckpointV1;
  } catch (error: unknown) {
    if (readCode(error) === 'ENOENT') {
      return null;
    }
    if (error instanceof SyntaxError) {
      throw new Error('STRICT_PREPARED_ROW_CHECKPOINT_INVALID');
    }
    throw error;
  }
  const { checkpointHash, ...semantic } = parsed;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.preparedHash !== expectedPreparedHash ||
    checkpointHash !== hashCanonicalJson(semantic)
  ) {
    throw new Error('STRICT_PREPARED_ROW_CHECKPOINT_DIVERGENCE');
  }
  return Object.freeze(parsed);
}

async function writePreparedRowCheckpoint(
  filePath: string,
  input: Omit<StrictPreparedRowCheckpointV1, 'schemaVersion' | 'checkpointHash'>
): Promise<void> {
  const semantic = { schemaVersion: 1 as const, ...input };
  const checkpoint = { ...semantic, checkpointHash: hashCanonicalJson(semantic) };
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${randomUUID()}`;
  const handle = await fsp.open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(checkpoint)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tempPath, filePath);
  const directory = await fsp.open(path.dirname(filePath), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function firstExisting(paths: readonly string[]): Promise<string | null> {
  for (const candidate of paths) {
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch (error: unknown) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
  }
  return null;
}

function readCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

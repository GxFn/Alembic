import { createHash, randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { IndependentReviewDecisionV1 } from '@alembic/agent/evaluation';
import type { StrictProducerExpressionSetV1 } from '@alembic/agent/production';
import { WriteZone } from '@alembic/core/io';
import {
  type CreateRecipeItem,
  createRecipeCandidateFingerprintProjectionV1,
  createRecipeProductionBindingV1,
  createRefReconciliationReceiptV1,
  createStrictG1ReceiptV1,
  createStrictPersistenceReceiptV1,
  KnowledgeFileWriter,
  KnowledgeGraphService,
  KnowledgeService,
  prepareRecipePersistenceV1,
  type RecipeProductionBindingV1,
  RecipeProductionGateway,
  type RefReconciliationReceiptV1,
  STRICT_G1_HARD_AXES_V1,
  type StrictG1ReceiptV1,
  type StrictPersistenceReceiptV1,
} from '@alembic/core/knowledge';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import { createAlembicRepositories } from '@alembic/core/repositories';
import {
  asEmbeddingPort,
  createLocalVectorStore,
  createLocalVectorStoreSync,
  RecipeVectorGenerationManager,
} from '@alembic/core/vector';
import {
  initializePrivateCorpusRevisionV1,
  type PrivateCorpusRevisionInitReceiptV1,
  rehydratePrivateCorpusRevisionV1,
  type WorkspaceResolver,
} from '@alembic/core/workspace';
import {
  FileRecipeVectorGenerationStorage,
  RecipeVectorGenerationRuntime,
} from '../../../service/vector/RecipeVectorGenerationRuntime.js';
import type { StrictProductionJournal } from './StrictProductionJournal.js';

export interface StrictPrivateCorpusContentResultV1 {
  readonly revisionInitReceipt: PrivateCorpusRevisionInitReceiptV1;
  readonly revisionId: string;
  readonly rootManifestHash: string;
  readonly g1Receipts: readonly StrictG1ReceiptV1[];
  readonly bindings: readonly RecipeProductionBindingV1[];
  readonly expressionTerminalRows: readonly {
    readonly expressionId: string;
    readonly recipeId: string | null;
    readonly terminalFate: 'content-ready' | 'reviewed-merge' | 'reviewed-duplicate';
    readonly terminalReceiptId: string;
  }[];
  readonly activeRecipes: readonly { readonly id: string; readonly title: string }[];
}

export interface StrictCandidateOracleV1 {
  readonly schemaVersion: 1;
  readonly checks: readonly {
    readonly tool: 'get-by-id' | 'get-by-title' | 'list-active' | 'search-sparse' | 'search-vector';
    readonly pass: true;
    readonly evidenceHash: string;
  }[];
  readonly oracleHash: string;
}

export interface StrictPrivateCorpusResultV1 extends StrictPrivateCorpusContentResultV1 {
  readonly freshProcessRehydrateHash: string;
  readonly activeRecipeIds: readonly string[];
  readonly vectorGenerationId: string;
  readonly vectorManifestHash: string;
  readonly candidateOracle: StrictCandidateOracleV1;
}

interface StrictPreparedRowCheckpointV1 {
  readonly schemaVersion: 1;
  readonly preparedHash: string;
  readonly g1ReceiptHash: string;
  readonly persistence: StrictPersistenceReceiptV1;
  readonly refs: RefReconciliationReceiptV1;
  readonly binding: RecipeProductionBindingV1;
  readonly checkpointHash: string;
}

interface StrictPrivateCorpusPersistenceInput {
  readonly acceptedMigrationBundleSemanticHash: string;
  readonly analysisFixpointHash: string;
  readonly baseResolver: WorkspaceResolver;
  readonly configReceiptHash: string;
  readonly credentialLocationSymbol: string;
  readonly expressionSets: readonly StrictProducerExpressionSetV1[];
  readonly independentReviews: readonly IndependentReviewDecisionV1[];
  readonly journal: StrictProductionJournal;
  readonly manifestHash: string;
  readonly planHash: string;
  readonly recoveryRoot: string;
  readonly runId: string;
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
  readonly reviewedById: Map<string, StrictReviewedProjection>;
  readonly expectedById: Map<string, { dbHash: string; fileHash: string }>;
  readonly reviews: ReadonlyMap<string, IndependentReviewDecisionV1>;
}

interface StrictPersistenceAccumulators {
  readonly g1Receipts: StrictG1ReceiptV1[];
  readonly bindings: RecipeProductionBindingV1[];
  readonly expressionTerminalRows: StrictPrivateCorpusResultV1['expressionTerminalRows'][number][];
  readonly activeRecipes: Array<{ id: string; title: string }>;
}

interface StrictDraftPreparation {
  readonly item: CreateRecipeItem;
  readonly reviewed: StrictReviewedProjection;
  readonly g1: StrictG1ReceiptV1;
  readonly journalStepHash: string;
  readonly dbHash: string;
  readonly fileHash: string;
  readonly prepared: ReturnType<typeof prepareRecipePersistenceV1>;
  readonly rowCheckpointPath: string;
  readonly rowCheckpoint: StrictPreparedRowCheckpointV1 | null;
  readonly moduleId: string;
}

export async function persistStrictPrivateCorpusContent(
  input: StrictPrivateCorpusPersistenceInput
): Promise<StrictPrivateCorpusContentResultV1> {
  const revisionId = revisionIdForFixpoint(input.analysisFixpointHash);
  const initialized = input.resumeInitReceipt
    ? await rehydratePrivateCorpusRevisionV1(input.baseResolver, input.resumeInitReceipt)
    : await initializePrivateCorpusRevisionV1(input.baseResolver, {
        runId: input.runId,
        revisionId,
        analysisFixpointHash: input.analysisFixpointHash,
        configReceiptHash: input.configReceiptHash,
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
  const knowledgeService = new KnowledgeService(
    repositories.knowledgeRepository as unknown as ConstructorParameters<
      typeof KnowledgeService
    >[0],
    { async log() {} },
    null,
    graph,
    { fileWriter }
  );
  const reviewedById = new Map<
    string,
    ReturnType<typeof createRecipeCandidateFingerprintProjectionV1>
  >();
  const expectedById = new Map<string, { dbHash: string; fileHash: string }>();
  const gateway = new RecipeProductionGateway({
    knowledgeService: knowledgeService as unknown as ConstructorParameters<
      typeof RecipeProductionGateway
    >[0]['knowledgeService'],
    projectRoot: input.baseResolver.projectRoot,
    authorizePreparedRecipe(journalToken, prepared, reviewedProjection) {
      return (
        journalToken === input.journal.entries.at(-1)?.entryHash &&
        prepared.journalStepHash === journalToken &&
        reviewedProjection.authoredFingerprint === prepared.authoredFingerprint
      );
    },
    async inspectPreparedRecipe(prepared) {
      const entry = await repositories.knowledgeRepository.findById(prepared.preparedRecipeId);
      if (!entry) {
        return null;
      }
      const reviewed = reviewedById.get(prepared.preparedRecipeId);
      const expected = expectedById.get(prepared.preparedRecipeId);
      if (!reviewed || !expected) {
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
      const resolvedFile = fileWriter._resolveFilePath(entry);
      if (!(await firstExisting([path.join(resolvedFile.dir, resolvedFile.filename)]))) {
        throw new Error('STRICT_PREPARED_FILE_READBACK_MISSING');
      }
      return {
        id: entry.id,
        title: entry.title,
        lifecycle: entry.lifecycle,
        privateCorpusRevision: revisionId,
        dbHash: expected.dbHash,
        fileHash: expected.fileHash,
      };
    },
  });
  const g1Receipts: StrictG1ReceiptV1[] = [];
  const bindings: RecipeProductionBindingV1[] = [];
  const expressionTerminalRows: StrictPrivateCorpusResultV1['expressionTerminalRows'][number][] =
    [];
  const activeRecipes: Array<{ id: string; title: string }> = [];
  const reviews = new Map(
    input.independentReviews.map((review) => [review.admissionReceiptId, review])
  );
  await persistStrictExpressionSets(
    {
      input,
      revisionId,
      repositories,
      gateway,
      reviewedById,
      expectedById,
      reviews,
    },
    { g1Receipts, bindings, expressionTerminalRows, activeRecipes }
  );
  const rootManifestHash = hashCanonicalJson({
    analysisFixpointHash: input.analysisFixpointHash,
    bindings: bindings.map((binding) => binding.bindingHash),
    expressionTerminalRows,
    revisionId,
  });
  initialized.runtime.close();
  return Object.freeze({
    revisionInitReceipt: initReceipt,
    revisionId,
    rootManifestHash,
    g1Receipts,
    bindings,
    expressionTerminalRows,
    activeRecipes: [...activeRecipes].sort((left, right) => left.id.localeCompare(right.id)),
  });
}

async function persistStrictExpressionSets(
  context: StrictPersistenceContext,
  accumulators: StrictPersistenceAccumulators
): Promise<void> {
  for (const set of context.input.expressionSets) {
    for (const proposal of set.proposals) {
      const admissionReceiptId = hashCanonicalJson({
        expressionId: proposal.expressionId,
        kind: 'non-persisting-admission',
      });
      const review = context.reviews.get(admissionReceiptId);
      if (!review || review.verdict !== 'pass') {
        throw new Error('STRICT_PRIVATE_CORPUS_G2_REVIEW_MISSING');
      }
      if (proposal.kind !== 'draft') {
        accumulators.expressionTerminalRows.push({
          expressionId: proposal.expressionId,
          recipeId: null,
          terminalFate: proposal.kind === 'merge' ? 'reviewed-merge' : 'reviewed-duplicate',
          terminalReceiptId: review.decisionHash,
        });
        continue;
      }
      const moduleId = exactlyOne(
        proposal.authored.scope.moduleIds,
        'STRICT_AUTHORED_MODULE_REQUIRED'
      );
      const dimensionId = exactlyOne(
        proposal.authored.scope.dimensionIds,
        'STRICT_AUTHORED_DIMENSION_REQUIRED'
      );
      const draft = await prepareStrictDraftPersistence(
        context,
        set,
        proposal,
        moduleId,
        dimensionId
      );
      accumulators.g1Receipts.push(draft.g1);
      const persisted = await context.gateway.persistPreparedReviewedCandidate(
        draft.item,
        draft.prepared,
        {
          source: 'alembic-agent',
          userId: 'strict-production',
          journalToken: draft.journalStepHash,
          reviewedProjection: draft.reviewed,
        }
      );
      const sourcePaths = reconcileStrictSourceRefs(context, proposal, persisted);
      const binding = await resolveStrictPreparedBinding(
        context,
        draft,
        persisted,
        admissionReceiptId,
        review.decisionHash,
        sourcePaths
      );
      accumulators.bindings.push(binding);
      const active =
        persisted.recipe.lifecycle === 'active'
          ? persisted.recipe
          : await context.gateway.publish(persisted.recipe.id, { userId: 'strict-production' });
      if (active.lifecycle !== 'active') {
        throw new Error('STRICT_PRIVATE_CORPUS_G3_ACTIVE_FAILED');
      }
      accumulators.activeRecipes.push({ id: active.id, title: active.title });
      accumulators.expressionTerminalRows.push({
        expressionId: proposal.expressionId,
        recipeId: persisted.recipe.id,
        terminalFate: 'content-ready',
        terminalReceiptId: binding.bindingHash,
      });
    }
  }
}

async function prepareStrictDraftPersistence(
  context: StrictPersistenceContext,
  set: StrictProducerExpressionSetV1,
  proposal: StrictProposal,
  moduleId: string,
  dimensionId: string
): Promise<StrictDraftPreparation> {
  const item = toRecipeItem(proposal, moduleId, dimensionId);
  const reviewed = createRecipeCandidateFingerprintProjectionV1({
    title: proposal.authored.title,
    kind: proposal.authored.kind,
    doText: proposal.authored.doClause,
    dontText: proposal.authored.dontClause,
    markdown: proposal.authored.markdown,
    usageGuide: proposal.authored.usageGuide,
    retrievalProfile: item.retrievalProfile,
    negativeIntents: proposal.authored.negativeIntent,
    scopeId: moduleId,
    moduleId,
    dimensionId,
    evidenceRefs: proposal.authored.evidenceEntryIds,
    lineageHashes: [set.lineage.lineageHash, set.repairNode.nodeHash],
  });
  const g1 = createStrictG1ReceiptV1({
    candidateFingerprint: reviewed.authoredFingerprint,
    retrievalReadinessHash: hashCanonicalJson(item.retrievalProfile),
    rows: evaluateStrictG1Axes({ dimensionId, item, moduleId, proposal, reviewed, set }),
  });
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
    cellId: `${moduleId}::${dimensionId}`,
    authoredFingerprint: reviewed.authoredFingerprint,
    causalParentIds: set.repairNode.parentNodeIds,
    expectedDbHash: dbHash,
    expectedFileHash: fileHash,
    journalStepHash,
  });
  context.reviewedById.set(prepared.preparedRecipeId, reviewed);
  context.expectedById.set(prepared.preparedRecipeId, { dbHash, fileHash });
  const rowCheckpointPath = path.join(
    context.input.recoveryRoot,
    `${prepared.preparedRecipeId}.json`
  );
  const rowCheckpoint = await readPreparedRowCheckpoint(rowCheckpointPath, prepared.preparedHash);
  return {
    item,
    reviewed,
    g1,
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
  const sourcePaths = proposal.authored.evidenceEntryIds.map((entryId) => evidencePath(entryId));
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
  admissionReceiptId: string,
  g2ReceiptHash: string,
  sourcePaths: readonly string[]
): Promise<RecipeProductionBindingV1> {
  if (draft.rowCheckpoint) {
    if (
      draft.rowCheckpoint.g1ReceiptHash !== draft.g1.receiptHash ||
      draft.rowCheckpoint.binding.recipeId !== persisted.recipe.id ||
      draft.rowCheckpoint.binding.authoredFingerprint !== draft.reviewed.authoredFingerprint
    ) {
      throw new Error('STRICT_PREPARED_ROW_CHECKPOINT_DIVERGENCE');
    }
    return draft.rowCheckpoint.binding;
  }
  if (persisted.recipe.lifecycle !== 'pending' && persisted.recipe.lifecycle !== 'staging') {
    throw new Error('STRICT_PREPARED_ROW_CHECKPOINT_MISSING');
  }
  const persistence = createStrictPersistenceReceiptV1({
    prepared: draft.prepared,
    g1ReceiptHash: draft.g1.receiptHash,
    admissionReceiptHash: admissionReceiptId,
    g2ReceiptHash,
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
    persistence,
    refs,
    binding,
  });
  return binding;
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
      evidenceRefs.length > 0 && evidenceRefs.every((ref) => /^E-\d+$/u.test(ref)),
    'claimed-graph-and-source-ref-integrity':
      new Set(evidenceRefs).size === evidenceRefs.length &&
      JSON.stringify([...evidenceRefs].sort()) ===
        JSON.stringify([...(input.item.sourceRefs ?? [])].sort()),
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
  readonly embedProvider: ConstructorParameters<
    typeof RecipeVectorGenerationRuntime
  >[0]['embedProvider'];
}): Promise<StrictPrivateCorpusResultV1> {
  const rehydrated = await rehydratePrivateCorpusRevisionV1(
    input.baseResolver,
    input.content.revisionInitReceipt
  );
  let candidateOracle: StrictCandidateOracleV1;
  let vectorGenerationId: string;
  let vectorManifestHash: string;
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
    const dryRun = await vectorRuntime.dryRun('full-build');
    const existingVector = await vectorRuntime.status();
    const recoveredManifest =
      existingVector.active &&
      existingVector.manifest?.status === 'ready' &&
      sameVectorCorpus(existingVector.manifest, dryRun.manifest)
        ? existingVector.manifest
        : null;
    const vectorManifest =
      recoveredManifest ?? (await vectorRuntime.rebuild('full-build')).manifest;
    if (!vectorManifest || vectorManifest.status !== 'ready') {
      throw new Error('STRICT_PRIVATE_CORPUS_VECTOR_NOT_READY');
    }
    candidateOracle = await runCandidateFiveToolOracle({
      activeRecipes: input.content.activeRecipes,
      embedProvider: input.embedProvider,
      repository: repositories.knowledgeRepository,
      vectorStore: await vectorStorage.open(vectorManifest.generationId),
    });
    vectorGenerationId = vectorManifest.generationId;
    vectorManifestHash = vectorManifest.manifestHash;
    rehydrated.handle.seal(input.content.rootManifestHash);
  } finally {
    rehydrated.runtime.close();
  }
  const freshProcess = await rehydratePrivateCorpusRevisionV1(
    input.baseResolver,
    input.content.revisionInitReceipt
  );
  try {
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
    freshProcess.handle.seal(input.content.rootManifestHash);
    const freshProcessRehydrateHash = hashCanonicalJson({
      activeRecipeIds: freshActiveIds,
      initReceiptHash: freshProcess.handle.initReceipt.initReceiptHash,
      migrationLedgerSemanticHash: freshProcess.handle.initReceipt.migrationLedgerSemanticHash,
      revisionId: freshProcess.handle.initReceipt.revisionId,
      rootManifestHash: input.content.rootManifestHash,
      vectorGenerationId,
      vectorManifestHash,
    });
    return Object.freeze({
      ...input.content,
      activeRecipeIds: expectedActiveIds,
      candidateOracle,
      freshProcessRehydrateHash,
      vectorGenerationId,
      vectorManifestHash,
    });
  } finally {
    freshProcess.runtime.close();
  }
}

function sameVectorCorpus(
  left: Awaited<ReturnType<RecipeVectorGenerationRuntime['status']>>['manifest'],
  right: Awaited<ReturnType<RecipeVectorGenerationRuntime['dryRun']>>['manifest']
): boolean {
  return Boolean(
    left &&
      left.corpusFingerprint === right.corpusFingerprint &&
      left.provider === right.provider &&
      left.model === right.model &&
      left.dimension === right.dimension &&
      left.documentCount === right.documentCount &&
      left.recipeCount === right.recipeCount
  );
}

function createKnowledgeService(
  resolver: WorkspaceResolver,
  repositories: ReturnType<typeof createAlembicRepositories>
): KnowledgeService {
  const graph = new KnowledgeGraphService(repositories.knowledgeEdgeRepository);
  const fileWriter = new KnowledgeFileWriter(resolver.dataRoot, new WriteZone(resolver));
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

export async function runCandidateFiveToolOracle(input: {
  readonly activeRecipes: StrictPrivateCorpusContentResultV1['activeRecipes'];
  readonly embedProvider: ConstructorParameters<
    typeof RecipeVectorGenerationRuntime
  >[0]['embedProvider'];
  readonly repository: ReturnType<typeof createAlembicRepositories>['knowledgeRepository'];
  readonly vectorStore: Awaited<ReturnType<FileRecipeVectorGenerationStorage['open']>>;
}): Promise<StrictCandidateOracleV1> {
  if (!input.embedProvider || input.activeRecipes.length === 0) {
    throw new Error('STRICT_CANDIDATE_ORACLE_INPUT_MISSING');
  }
  const expectedIds = input.activeRecipes.map((recipe) => recipe.id).sort();
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
  const sparse = await Promise.all(
    input.activeRecipes.map((recipe) =>
      input.repository.search(recipe.title, { page: 1, pageSize: 10 })
    )
  );
  const queryVector = await asEmbeddingPort(
    input.embedProvider as Parameters<typeof asEmbeddingPort>[0]
  ).embedQuery(input.activeRecipes[0]?.title ?? '');
  const vector = await input.vectorStore.searchVector(queryVector, {
    topK: Math.max(5, expectedIds.length),
  });
  const vectorRecipeIds = [
    ...new Set(
      vector
        .map((hit) => {
          const metadata = hit.item.metadata;
          return metadata && typeof metadata === 'object' && 'recipeId' in metadata
            ? String(metadata.recipeId)
            : '';
        })
        .filter(Boolean)
    ),
  ].sort();
  const checks = [
    oracleCheck(
      'get-by-id',
      byId.every((entry, index) => entry?.id === expectedIds[index]),
      byId
    ),
    oracleCheck(
      'get-by-title',
      byTitle.every((entry, index) => entry?.id === input.activeRecipes[index]?.id),
      byTitle
    ),
    oracleCheck(
      'list-active',
      JSON.stringify(listedIds) === JSON.stringify(expectedIds),
      listedIds
    ),
    oracleCheck(
      'search-sparse',
      sparse.every((page, index) =>
        page.data.some((entry) => entry?.id === input.activeRecipes[index]?.id)
      ),
      sparse.map((page) => page.data.flatMap((entry) => (entry ? [entry.id] : [])))
    ),
    oracleCheck(
      'search-vector',
      vectorRecipeIds.some((id) => expectedIds.includes(id)),
      vectorRecipeIds
    ),
  ] as const;
  return Object.freeze({
    schemaVersion: 1,
    checks,
    oracleHash: hashCanonicalJson({ schemaVersion: 1, checks }),
  });
}

function oracleCheck(
  tool: StrictCandidateOracleV1['checks'][number]['tool'],
  pass: boolean,
  evidence: unknown
): StrictCandidateOracleV1['checks'][number] {
  if (!pass) {
    throw new Error(`STRICT_CANDIDATE_ORACLE_FAILED:${tool}`);
  }
  return Object.freeze({ tool, pass: true, evidenceHash: hashCanonicalJson(evidence) });
}

function toRecipeItem(
  proposal: StrictProducerExpressionSetV1['proposals'][number],
  moduleId: string,
  dimensionId: string
): CreateRecipeItem {
  const exclusions = readExclusionTexts(proposal.authored.retrievalProfile);
  if (
    JSON.stringify([...exclusions].sort()) !==
    JSON.stringify([...proposal.authored.negativeIntent].sort())
  ) {
    throw new Error('STRICT_AUTHORED_NEGATIVE_INTENT_MISMATCH');
  }
  const source: CreateRecipeItem = {
    title: proposal.authored.title,
    description: proposal.authored.doClause,
    trigger: `@strict-${proposal.expressionId.replace(/[^a-zA-Z0-9_-]/gu, '-').slice(-48)}`,
    kind: proposal.authored.kind,
    topicHint: dimensionId,
    whenClause: proposal.authored.usageGuide,
    doClause: proposal.authored.doClause,
    dontClause: proposal.authored.dontClause,
    coreCode: '',
    content: { markdown: proposal.authored.markdown, rationale: proposal.authored.usageGuide },
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
    sourceRefs: [...proposal.authored.evidenceEntryIds],
  };
  source.retrievalProfile = buildCoreReadyRetrievalProfile(proposal, source, exclusions);
  return source;
}

function buildCoreReadyRetrievalProfile(
  proposal: StrictProducerExpressionSetV1['proposals'][number],
  source: CreateRecipeItem,
  exclusions: readonly string[]
): NonNullable<CreateRecipeItem['retrievalProfile']> {
  const evidenceRefs = [...proposal.authored.evidenceEntryIds];
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

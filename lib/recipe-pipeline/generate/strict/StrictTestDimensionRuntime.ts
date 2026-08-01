import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AgentService } from '@alembic/agent/service';
import { readAlembicMigrationBundleManifest } from '@alembic/core/database';
import { baseDimensions } from '@alembic/core/host-agent-workflows';
import type { StrictColdStartConfigProjectionInputV1 } from '@alembic/core/plans';
import type { StrictTestFailureStageV1 } from '@alembic/core/production';
import {
  type CanonicalSha256,
  hashBytes,
  hashCanonicalJson,
} from '@alembic/core/project-context-foundation';
import type { WorkspaceResolver } from '@alembic/core/workspace';
import {
  createRuntimeConfigLoadReceiptV1,
  type RuntimeConfigLoadReceiptV1,
} from '../../../infrastructure/config/RuntimeConfigLoadReceipt.js';
import { createSemanticReviewTrustEnrollmentAuthorization } from '../../../infrastructure/config/SemanticReviewTrustStore.js';
import type { ServiceContainer } from '../../../injection/ServiceContainer.js';
import {
  captureMainCertifiedProjectFacts,
  MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS,
  type MainCertifiedProjectFactsState,
  type MainCertifiedProjectionPayload,
  openMainCertifiedProjectFactsArtifact,
  reopenMainCertifiedProjectFactsConsumer,
  resolveMainCertifiedProjectScopeHash,
} from '../../../project-facts/CertifiedProjectFactsRuntime.js';
import { resolveProjectScopeAnalysisContext } from '../../../project-scope/ProjectScopeAnalysis.js';
import { StrictSemanticReviewRuntimeFactory } from '../../../service/semantic-review/StrictSemanticReviewRuntimeFactory.js';
import { executeStrictAnalysisAndProduction } from './StrictAnalysisRuntime.js';
import type {
  StrictSemanticReviewCheckpointPortV1,
  StrictSemanticReviewCheckpointV1,
} from './StrictDispositionReviewRuntime.js';
import { createMainStrictFactQueryFamiliesV1 } from './StrictFactExecutionRuntime.js';
import {
  buildStrictCandidateCoverage,
  finalizeStrictPrivateCandidate,
} from './StrictFinalizationRuntime.js';
import { compileStrictColdStartPlanning } from './StrictPlanningRuntime.js';
import {
  indexSealAndVerifyStrictPrivateCorpus,
  persistStrictPrivateCorpusContent,
} from './StrictPrivateCorpusRuntime.js';
import { STRICT_PRODUCTION_STATES_V1, StrictProductionJournal } from './StrictProductionJournal.js';
import { verifyRuntimeArtifactManifestV1 } from './StrictRuntimeArtifacts.js';
import {
  type StrictTestDimensionCheckpointV1,
  StrictTestDimensionOrchestrator,
  type StrictTestDimensionOrchestratorDependencies,
  type StrictTestPreparedPreflightV1,
} from './StrictTestDimensionOrchestrator.js';
import {
  createStrictTestPrivateWorkspace,
  resolveStrictTestPrivateWorkspacePolicy,
  type StrictTestPrivateWorkspaceAuthorityV1,
} from './StrictTestPrivateWorkspace.js';
import type { StrictTestPreflightRequestV1 } from './StrictTestRequestContracts.js';

const PRIVATE_CHAIN_CHECKPOINT = 'strict-test-private-chain.json';
const SEMANTIC_REVIEW_CHECKPOINT = 'strict-test-semantic-review.json';
const PRIVATE_TRUST_CONFIG = '.asd/config.json';

interface StrictTestPreparedExecutionContextV1 {
  readonly schemaVersion: 1;
  readonly carrier: MainCertifiedProjectFactsState;
  readonly projection: MainCertifiedProjectionPayload;
  readonly certifiedPlanningFacts: Awaited<
    ReturnType<typeof compileStrictColdStartPlanning>
  >['certifiedPlanningFacts'];
  readonly planCognitionHash: CanonicalSha256;
  readonly configReceipt: Awaited<
    ReturnType<typeof compileStrictColdStartPlanning>
  >['configReceipt'];
  readonly runtimeConfigReceipt: RuntimeConfigLoadReceiptV1;
  readonly runtimeArtifactReceipt: Awaited<
    ReturnType<typeof verifyRuntimeArtifactManifestV1>
  >['receipt'];
  readonly modelHash: CanonicalSha256;
  readonly reviewer: {
    readonly calibrationReceiptHash: CanonicalSha256;
    readonly identity: {
      readonly provider: string;
      readonly model: string;
      readonly method: string;
    };
  };
  readonly acceptedMigrationBundleSemanticHash: CanonicalSha256;
  readonly credentialLocationSymbol: string;
}

export function createStrictTestDimensionOrchestrator(
  container: ServiceContainer
): StrictTestDimensionOrchestrator {
  return new StrictTestDimensionOrchestrator(createStrictTestDependencies(container));
}

export function createStrictTestDependencies(
  container: ServiceContainer
): StrictTestDimensionOrchestratorDependencies {
  const analysisScope = resolveProjectScopeAnalysisContext(container);
  const controlRoot = path.resolve(analysisScope.controlRoot ?? analysisScope.projectRoot);
  return {
    clock: () => new Date().toISOString(),
    resolveRunRoot: (demandKey, runId) =>
      path.join(controlRoot, 'strict-test-runs', demandKey, runId),
    findRunRoot: async (runId) => findRunRoot(controlRoot, runId),
    preparePreflight: (input) => prepareStrictTestPreflight(container, input),
    revalidate: (checkpoint) => revalidateStrictTestPreflight(container, checkpoint),
    execute: (input) => executeStrictTestPrivateChain(container, input),
    observeNonMutation: async () => ({
      productionStateHash: await snapshotProductionState(analysisScope.dataRoot),
      publicRouteStateHash: await snapshotPublicRouteState(analysisScope.dataRoot),
    }),
    verificationCommands: [
      'npm run build:check',
      'npx vitest run test/integration/StrictTestDimensionPipeline.integration.test.ts',
      'npm run probe:strict-test-main',
    ],
  };
}

async function prepareStrictTestPreflight(
  container: ServiceContainer,
  input: StrictTestPreflightRequestV1
): Promise<StrictTestPreparedPreflightV1> {
  const analysisScope = resolveProjectScopeAnalysisContext(container);
  const projectRoot = await fsp.realpath(path.resolve(input.projectRoot));
  if (projectRoot !== (await fsp.realpath(analysisScope.projectRoot))) {
    throw new Error('STRICT_TEST_PROJECT_ROOT_MISMATCH');
  }
  const baseResolver = requireWorkspaceResolver(container, projectRoot);
  const workspaceAuthority = await strictTestWorkspaceAuthority(
    analysisScope,
    input.demandKey,
    input.runId
  );
  const policy = await resolveStrictTestPrivateWorkspacePolicy(workspaceAuthority);
  const productionBeforeStateHash = await snapshotProductionState(analysisScope.dataRoot);
  const publicRouteBeforeStateHash = await snapshotPublicRouteState(analysisScope.dataRoot);
  const officialRecipeBeforeStateHash = await snapshotOfficialRecipeState(analysisScope.dataRoot);
  const workspace = await createStrictTestPrivateWorkspace({
    authority: workspaceAuthority,
    baseResolver,
  });

  const privateAnalysisScope = { ...analysisScope, dataRoot: workspace.privateDataRoot };
  const carrier = await captureMainCertifiedProjectFacts({
    analysisScope: privateAnalysisScope,
    dimensions: [...baseDimensions],
    projectRoot,
    source: 'alembic-main-strict-test',
  });
  const reopened = await reopenMainCertifiedProjectFactsConsumer({
    carrier,
    consumer: 'recipe-generation',
    dataRoot: workspace.privateDataRoot,
    entrypoint: MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS['recipe-generation'],
    runId: `${input.runId}:strict-test-preflight`,
  });
  const artifact = await openMainCertifiedProjectFactsArtifact({
    carrier,
    dataRoot: workspace.privateDataRoot,
  });
  const runtimeArtifacts = await loadCurrentRuntimeArtifacts();
  const provider = requireProvider(container);
  const modelHash = hashCanonicalJson({ provider: provider.name, model: provider.model });
  const promptHash = runtimeArtifacts.artifactBindings
    .promptSopEvaluatorBundleHash as CanonicalSha256;
  const strictConfig = strictTestConfig(runtimeArtifacts.receipt.receiptHash as CanonicalSha256);
  const reviewer = {
    calibrationReceiptHash: hashCanonicalJson({ promptHash, rubric: 'strict-test-private-v1' }),
    identity: {
      provider: provider.name,
      model: provider.model,
      method: 'durable-semantic-review-v5',
    },
  };
  const planning = await compileStrictColdStartPlanning({
    agentService: container.get('agentService') as Pick<AgentService, 'run'>,
    authorization: {
      factQueryFamilies: createMainStrictFactQueryFamiliesV1(),
      modelHash,
      promptHash,
      strictConfig,
    },
    carrier,
    projection: reopened.projection,
  });
  const runtimeConfigReceipt = createRuntimeConfigLoadReceiptV1({
    projectRoot,
    workspaceResolver: baseResolver,
    planning: { modelHash, promptHash, strictConfig },
    artifactBindings: runtimeArtifacts.artifactBindings,
    actualProvider: provider,
    actualEmbeddingProvider: container.singletons._embedProvider,
  });
  const productionAfterReadStateHash = await snapshotProductionState(analysisScope.dataRoot);
  const consumerReceipt = carrier.receipts['recipe-generation'];
  if (!consumerReceipt) {
    throw new Error('STRICT_TEST_CERTIFIED_FACTS_CONSUMER_RECEIPT_REQUIRED');
  }
  const languages = unique(reopened.projection.files.map((file) => file.language));
  const factFamilies = createMainStrictFactQueryFamiliesV1();
  const currentBindings = {
    schemaVersion: 1 as const,
    profile: 'strict-test-dimension' as const,
    demandKey: input.demandKey,
    runId: input.runId,
    projectRootIdentity: projectRoot,
    controlRootIdentity: await fsp.realpath(workspaceAuthority.controlRoot),
    sourceRootIdentity: projectRoot,
    canonicalProjectIdentityHash: carrier.canonicalScopeHash as CanonicalSha256,
    sourceRevisionVectorHash: carrier.sourceVectorHash as CanonicalSha256,
    sourceInventoryHash: sourceInventoryHash(reopened.projection),
    sourceFileCount: reopened.projection.files.length,
    moduleCount: reopened.projection.modules.length,
    languageCount: languages.length,
    parserCount: languages.length,
    backendCount: factFamilies.length,
    certifiedProjectFactsArtifactHash: hashCanonicalJson(artifact),
    certifiedProjectFactsContentHash: carrier.factsContentHash as CanonicalSha256,
    certifiedProjectFactsSourceArtifactHash: carrier.certificationBindingHash as CanonicalSha256,
    certifiedProjectFactsSourceVectorHash: carrier.sourceVectorHash as CanonicalSha256,
    certifiedProjectFactsConsumerReceiptHash: consumerReceipt.receiptHash as CanonicalSha256,
    strictConfigReceiptHash: planning.configReceipt.loadHash,
    providerModelHash: modelHash,
    promptSopHash: promptHash,
    factQueryBackendHash: hashCanonicalJson(factFamilies),
    parserBackendHash: hashCanonicalJson(languages),
    embeddingVectorHash: runtimeConfigReceipt.vector.adapterArtifactHash as CanonicalSha256,
    runtimeArtifactManifestHash: runtimeArtifacts.receipt.manifestHash as CanonicalSha256,
    runtimeArtifactBindingHash: runtimeArtifacts.receipt.receiptHash as CanonicalSha256,
    productionBeforeStateHash,
    productionAfterReadStateHash,
    publicRouteBeforeStateHash,
    officialRecipeBeforeStateHash,
    privateWorkspacePolicyHash: policy.policyHash as CanonicalSha256,
    generatedAt: new Date().toISOString(),
    validUntil: null,
  };
  const executionContext: StrictTestPreparedExecutionContextV1 = {
    schemaVersion: 1,
    carrier,
    projection: reopened.projection,
    certifiedPlanningFacts: planning.certifiedPlanningFacts,
    // Agent strict-test authority绑定的是 Core 编译计划中已验收的 cognition lineage，
    // 不是 Main 对原始 cognition envelope 的旁路摘要。
    planCognitionHash: planning.compiledPlan.execution.planCognitionHash as CanonicalSha256,
    configReceipt: planning.configReceipt,
    runtimeConfigReceipt,
    runtimeArtifactReceipt: runtimeArtifacts.receipt,
    modelHash,
    reviewer,
    acceptedMigrationBundleSemanticHash: hashCanonicalJson(readAlembicMigrationBundleManifest()),
    credentialLocationSymbol: 'config-ref:strict-test-private-reviewer',
  };
  return {
    compiledPlan: planning.compiledPlan,
    currentBindings,
    executionContext,
    privateEvidenceRefs: [
      'strict-test:certified-project-facts',
      'strict-test:runtime-artifact-receipt',
      'strict-test:private-workspace-policy',
    ],
  };
}

async function revalidateStrictTestPreflight(
  container: ServiceContainer,
  checkpoint: StrictTestDimensionCheckpointV1
) {
  const analysisScope = resolveProjectScopeAnalysisContext(container);
  const productionStateHash = await snapshotProductionState(analysisScope.dataRoot);
  const publicRouteStateHash = await snapshotPublicRouteState(analysisScope.dataRoot);
  const policy = await resolveStrictTestPrivateWorkspacePolicy(
    await strictTestWorkspaceAuthority(analysisScope, checkpoint.demandKey, checkpoint.runId)
  );
  const context = readExecutionContext(checkpoint.executionContext);
  const captured = await captureMainCertifiedProjectFacts({
    analysisScope: { ...analysisScope, dataRoot: policy.privateDataRoot },
    dimensions: [...baseDimensions],
    projectRoot: checkpoint.projectRoot,
    source: 'alembic-main-strict-test',
  });
  if (
    productionStateHash !== checkpoint.preflight.productionBeforeStateHash ||
    publicRouteStateHash !== checkpoint.preflight.publicRouteBeforeStateHash ||
    policy.policyHash !== checkpoint.preflight.privateWorkspacePolicyHash ||
    captured.sourceVectorHash !== checkpoint.preflight.sourceRevisionVectorHash ||
    captured.factsContentHash !== checkpoint.preflight.certifiedProjectFactsContentHash ||
    captured.certificationBindingHash !== context.carrier.certificationBindingHash
  ) {
    throw new Error('STRICT_TEST_PREFLIGHT_RUNTIME_DRIFT');
  }
  return checkpoint.currentBindings;
}

async function executeStrictTestPrivateChain(
  container: ServiceContainer,
  input: Parameters<StrictTestDimensionOrchestratorDependencies['execute']>[0]
) {
  const context = readExecutionContext(input.executionContext);
  const analysisScope = resolveProjectScopeAnalysisContext(container);
  const baseResolver = requireWorkspaceResolver(
    container,
    input.currentBindings.projectRootIdentity
  );
  const workspace = await createStrictTestPrivateWorkspace({
    authority: await strictTestWorkspaceAuthority(
      analysisScope,
      input.preflight.demandKey,
      input.preflight.runId
    ),
    baseResolver,
  });
  await ensurePrivateSemanticTrustAuthorization(workspace.privateDataRoot);
  const artifact = await openMainCertifiedProjectFactsArtifact({
    carrier: context.carrier,
    dataRoot: workspace.privateDataRoot,
  });
  const provider = requireProvider(container);
  const semanticReviewFactory = new StrictSemanticReviewRuntimeFactory({
    dataRoot: workspace.privateDataRoot,
    provider,
  });
  const semanticReviewSession = await semanticReviewFactory.openSession({
    artifact,
    credentialLocationSymbol: context.credentialLocationSymbol,
    modelVersion: context.modelHash,
    projection: context.projection,
    projectRoot: input.currentBindings.projectRootIdentity,
    reviewer: context.reviewer,
    runId: input.preflight.runId,
    runtimeConfigHash: context.runtimeConfigReceipt.configHash,
    sourceRevisionVectorHash: input.compiledPlan.execution.sourceRevisionVectorHash,
  });
  const semanticReviewCheckpoint = await createPrivateSemanticReviewCheckpoint(input.runRoot);
  const analysis = await executeStrictAnalysisAndProduction({
    agentService: container.get('agentService') as Pick<AgentService, 'run'>,
    artifact,
    certifiedPlanningFacts: context.certifiedPlanningFacts,
    compiledPlan: input.compiledPlan,
    journalId: hashCanonicalJson({
      profile: 'strict-test-dimension',
      runId: input.preflight.runId,
    }),
    modelHash: context.modelHash,
    planCognitionHash: context.planCognitionHash,
    projection: context.projection,
    reviewer: context.reviewer,
    runId: input.preflight.runId,
    semanticReviewSession,
    strictTest: {
      automaticSelection: input.automaticSelection,
      clock: () => new Date().toISOString(),
      currentBindings: input.currentBindings,
      preflight: input.preflight,
      projection: input.projection,
      semanticReviewCheckpoint,
    },
  });
  const agentReceipt = analysis.strictTestExecutionReceipt;
  if (!agentReceipt || agentReceipt.segmentStatus !== 'completed') {
    throw stageError('ANALYSIS_FIXPOINT_CLOSED', 'STRICT_TEST_AGENT_RECEIPT_NOT_COMPLETED');
  }

  // Agent receipt 在任何 corpus 写入前封印同 run 的 stage output 与精确 selected-cell 集。
  // “rejected/private-review-pending” 仅表示 Agent G2 没有冒充 Main 的 durable corpus review；
  // Main 随后仍须在私有链重新执行真实 G3 review，且只能消费该 receipt 已封印的 cell。
  const receiptCellIds = new Set(
    agentReceipt.cellDispositions
      .filter((row) => row.disposition !== 'failed')
      .map((row) => row.cellId)
  );
  const authorizedExpressionSets = analysis.expressionSets.filter((set) =>
    set.proposals.some((proposal) => {
      const moduleId = proposal.authored.scope.moduleIds[0];
      const dimensionId = proposal.authored.scope.dimensionIds[0];
      return Boolean(moduleId && dimensionId && receiptCellIds.has(`${moduleId}::${dimensionId}`));
    })
  );
  const journalRoot = path.join(input.runRoot, 'private-chain-journal');
  const journal = await StrictProductionJournal.open({
    operationRoot: journalRoot,
    ownerId: `strict-test:${input.preflight.runId}`,
    runId: input.preflight.runId,
  });
  try {
    if (!journal.entries.length) {
      await journal.append(STRICT_PRODUCTION_STATES_V1[0], {
        profile: 'strict-test-dimension',
        agentReceiptHash: agentReceipt.receiptHash,
      });
    }
    const content = await persistStrictPrivateCorpusContent({
      acceptedMigrationBundleSemanticHash: context.acceptedMigrationBundleSemanticHash,
      agentService: container.get('agentService') as Pick<AgentService, 'run'>,
      analysis,
      analysisFixpointHash: analysis.fixpoint.fixpointHash,
      baseResolver: workspace.resolver,
      configReceiptHash: context.runtimeConfigReceipt.receiptHash,
      credentialLocationSymbol: context.credentialLocationSymbol,
      evidence: analysis.evidence,
      executionCellIds: input.projection.executionCellIds,
      executionReceipts: analysis.factExecutionReceipts,
      expressionSets: authorizedExpressionSets,
      finalExpandedSchedule: analysis.finalExpandedSchedule,
      journal,
      manifestHash: context.carrier.certificationBindingHash,
      planHash: input.compiledPlan.canonicalPlanHash,
      producerModelHash: context.modelHash,
      recoveryRoot: path.join(input.runRoot, 'prepared-rows'),
      runId: input.preflight.runId,
      runtimeReceiptHash: context.runtimeArtifactReceipt.receiptHash,
      terminalObligations: analysis.fixpoint.terminalObligations,
      reviewer: context.reviewer,
      semanticReviewCheckpoint,
      semanticReviewSession,
    });
    const candidateCoverage = await buildStrictCandidateCoverage({
      analysis,
      compiledPlan: input.compiledPlan,
      executionCellIds: input.projection.executionCellIds,
      expressionSets: authorizedExpressionSets,
      privateCorpus: content,
      producerModelHash: context.modelHash,
      reviewerIdentity: context.reviewer.identity,
      runId: input.preflight.runId,
      semanticReviewCheckpoint,
      semanticReviewSession,
    });
    const privateCorpus = await indexSealAndVerifyStrictPrivateCorpus({
      baseResolver: workspace.resolver,
      content,
      expectedCurrentContext: {
        runId: input.preflight.runId,
        revisionId: content.revisionId,
        analysisFixpointHash: analysis.fixpoint.fixpointHash,
        configReceiptHash: context.runtimeConfigReceipt.receiptHash,
        runtimeReceiptHash: context.runtimeArtifactReceipt.receiptHash,
      },
      embedProvider: container.singletons._embedProvider as Parameters<
        typeof indexSealAndVerifyStrictPrivateCorpus
      >[0]['embedProvider'],
    });
    const candidateDataManifestHash = hashCanonicalJson({
      profile: 'strict-test-dimension',
      rootManifestHash: privateCorpus.rootManifestHash,
      candidateCoverageReceiptHash: candidateCoverage.receiptHash,
      vectorGenerationId: privateCorpus.vectorGenerationId,
      vectorManifestHash: privateCorpus.vectorManifestHash,
      selectedCellIds: input.projection.executionCellIds,
      agentReceiptHash: agentReceipt.receiptHash,
    });
    const snapshotId = `snapshot-${candidateDataManifestHash.slice('sha256:'.length)}`;
    const finalization = finalizeStrictPrivateCandidate({
      analysis,
      candidateCoverage,
      candidateDataManifestHash,
      certifiedProjectFactsHash: context.carrier.factsContentHash,
      compiledPlan: input.compiledPlan,
      planCognitionHash: context.planCognitionHash,
      privateCorpus: canonicalizeStrictTestPrivateCorpus(privateCorpus),
      runId: input.preflight.runId,
      snapshotId,
    });
    const durable = {
      schemaVersion: 1,
      profile: 'strict-test-dimension',
      agentReceipt,
      candidateCoverage,
      privateCorpus,
      finalization,
    };
    await writeJsonAtomic(path.join(input.runRoot, PRIVATE_CHAIN_CHECKPOINT), durable);
    assertStrictTestPrivateCompletionHashes({
      finalCoverage: finalization.finalCoverage,
      g4ReceiptHash: finalization.g4ReceiptHash,
      servingManifest: finalization.servingManifest,
      servingValidationHash: finalization.servingSnapshotValidation.receiptHash,
    });
    return {
      finalCoverageBinding: finalization.finalCoverage,
      servingSnapshotManifest: finalization.servingManifest,
      privateG4ReceiptHash: finalization.g4ReceiptHash as CanonicalSha256,
      privateServingValidationHash: finalization.servingSnapshotValidation
        .receiptHash as CanonicalSha256,
      privateEvidenceRefs: [
        `strict-test:agent-receipt:${agentReceipt.receiptHash}`,
        `strict-test:private-corpus:${privateCorpus.sealedCorpusVerification.verificationHash}`,
        `strict-test:serving:${finalization.servingSnapshotValidation.receiptHash}`,
      ],
    };
  } finally {
    await journal.close();
  }
}

function canonicalizeStrictTestPrivateCorpus(
  privateCorpus: Awaited<ReturnType<typeof indexSealAndVerifyStrictPrivateCorpus>>
): Awaited<ReturnType<typeof indexSealAndVerifyStrictPrivateCorpus>> {
  const vectorManifestHash = privateCorpus.vectorManifestHash.startsWith('sha256:')
    ? privateCorpus.vectorManifestHash
    : `sha256:${privateCorpus.vectorManifestHash}`;
  const sealedSemantic = {
    ...privateCorpus.sealedCorpusVerification,
    vectorManifestHash,
  };
  const { verificationHash: _verificationHash, ...verificationInput } = sealedSemantic;
  return Object.freeze({
    ...privateCorpus,
    vectorManifestHash,
    sealedCorpusVerification: Object.freeze({
      ...verificationInput,
      verificationHash: hashCanonicalJson(verificationInput),
    }),
  });
}

function assertStrictTestPrivateCompletionHashes(input: {
  readonly finalCoverage: Awaited<
    ReturnType<typeof finalizeStrictPrivateCandidate>
  >['finalCoverage'];
  readonly g4ReceiptHash: string;
  readonly servingManifest: Awaited<
    ReturnType<typeof finalizeStrictPrivateCandidate>
  >['servingManifest'];
  readonly servingValidationHash: string;
}): void {
  const hashes = {
    privateG4ReceiptHash: input.g4ReceiptHash,
    privateServingValidationHash: input.servingValidationHash,
    candidateCoverageReceiptHash: input.finalCoverage.candidateCoverageReceiptHash,
    candidateCellSetHash: input.finalCoverage.candidateCellSetHash,
    finalCoverageG4ReceiptHash: input.finalCoverage.g4ReceiptHash,
    candidateDataManifestHash: input.finalCoverage.candidateDataManifestHash,
    finalCoverageReceiptHash: input.finalCoverage.receiptHash,
    servingFinalCoverageBindingHash: input.servingManifest.finalCoverageBindingHash,
    servingSnapshotValidationHash: input.servingManifest.servingSnapshotValidationHash,
    vectorManifestHash: input.servingManifest.vectorManifestHash,
    certifiedProjectFactsHash: input.servingManifest.certifiedProjectFactsHash,
    sourceRevisionVectorHash: input.servingManifest.sourceRevisionVectorHash,
    analysisFixpointHash: input.servingManifest.analysisFixpointHash,
    servingManifestHash: input.servingManifest.manifestHash,
  };
  const invalid = Object.entries(hashes)
    .filter(([, hash]) => !/^sha256:[0-9a-f]{64}$/u.test(hash))
    .map(([field]) => field);
  if (invalid.length > 0) {
    throw new Error(`STRICT_TEST_PRIVATE_COMPLETION_HASH_INVALID:${invalid.join(',')}`);
  }
}

function strictTestConfig(sourceHash: CanonicalSha256): StrictColdStartConfigProjectionInputV1 {
  const strictColdStart = {
    candidateAttemptCap: 100,
    maxAuthoredCandidatesPerCellPass: 1,
    providerRequestCap: 200,
    detailRequestCap: 200,
    tokenCap: 2_000_000,
    timeMsCap: 600_000,
    costMicrousdCap: 5_000_000,
    factQueryObligationCap: 10_000,
    moduleWireBound: 5_000,
    cellWireBound: 100_000,
  };
  return {
    sourceArtifactHash: hashCanonicalJson({ sourceHash, profile: 'strict-test-dimension-v1' }),
    strictColdStart,
    fieldSources: Object.fromEntries(
      Object.keys(strictColdStart).map((field) => [field, `alembic-main:strict-test:${field}`])
    ) as StrictColdStartConfigProjectionInputV1['fieldSources'],
  };
}

async function loadCurrentRuntimeArtifacts() {
  const manifestPath = process.env.ALEMBIC_RUNTIME_ARTIFACT_MANIFEST_PATH?.trim();
  if (!manifestPath || !path.isAbsolute(manifestPath)) {
    throw new Error('STRICT_TEST_RUNTIME_ARTIFACT_MANIFEST_PATH_REQUIRED');
  }
  const bytes = await fsp.readFile(manifestPath);
  const manifest = JSON.parse(bytes.toString('utf8')) as { manifestHash?: unknown };
  if (typeof manifest.manifestHash !== 'string') {
    throw new Error('STRICT_TEST_RUNTIME_ARTIFACT_MANIFEST_INVALID');
  }
  return verifyRuntimeArtifactManifestV1({
    expectedManifestContentHash: hashBytes(bytes),
    expectedManifestHash: manifest.manifestHash,
    manifestPath,
    manifestSymbol: 'controller:runtime-artifact-manifest',
  });
}

function requireProvider(container: ServiceContainer) {
  const provider = container.singletons.aiProvider as
    | { name?: unknown; model?: unknown; chatWithTools?: unknown }
    | undefined;
  if (
    !provider ||
    typeof provider.name !== 'string' ||
    typeof provider.model !== 'string' ||
    typeof provider.chatWithTools !== 'function'
  ) {
    throw new Error('STRICT_TEST_AI_PROVIDER_UNAVAILABLE');
  }
  return provider as ConstructorParameters<
    typeof StrictSemanticReviewRuntimeFactory
  >[0]['provider'];
}

function requireWorkspaceResolver(
  container: ServiceContainer,
  projectRoot: string
): WorkspaceResolver {
  const resolver = container.singletons._workspaceResolver as WorkspaceResolver | undefined;
  if (!resolver || path.resolve(resolver.projectRoot) !== path.resolve(projectRoot)) {
    throw new Error('STRICT_TEST_WORKSPACE_RESOLVER_MISMATCH');
  }
  return resolver;
}

async function strictTestWorkspaceAuthority(
  analysisScope: ReturnType<typeof resolveProjectScopeAnalysisContext>,
  demandKey: string,
  runId: string
): Promise<StrictTestPrivateWorkspaceAuthorityV1> {
  const projectRoot = await fsp.realpath(analysisScope.projectRoot);
  const sourceRoots = analysisScope.projectScope?.folders.map((folder) => folder.path) ?? [
    projectRoot,
  ];
  return {
    canonicalProjectIdentityHash: resolveMainCertifiedProjectScopeHash({
      analysisScope,
      projectRoot,
    }),
    controlRoot: analysisScope.controlRoot ?? projectRoot,
    demandKey,
    productionDataRoot: analysisScope.dataRoot,
    projectRoot,
    runId,
    sourceRoots,
  };
}

async function ensurePrivateSemanticTrustAuthorization(dataRoot: string): Promise<void> {
  const configPath = path.join(dataRoot, PRIVATE_TRUST_CONFIG);
  try {
    await fsp.lstat(configPath);
    return;
  } catch (error: unknown) {
    if (readCode(error) !== 'ENOENT') {
      throw error;
    }
  }
  await fsp.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const authorization = createSemanticReviewTrustEnrollmentAuthorization({ dataRoot });
  await fsp.writeFile(configPath, `${JSON.stringify({ semanticReviewTrust: authorization })}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

async function createPrivateSemanticReviewCheckpoint(
  runRoot: string
): Promise<StrictSemanticReviewCheckpointPortV1> {
  const checkpointPath = path.join(runRoot, SEMANTIC_REVIEW_CHECKPOINT);
  let checkpoint: StrictSemanticReviewCheckpointV1 | undefined;
  try {
    checkpoint = JSON.parse(
      await fsp.readFile(checkpointPath, 'utf8')
    ) as StrictSemanticReviewCheckpointV1;
  } catch (error: unknown) {
    if (readCode(error) !== 'ENOENT') {
      throw error;
    }
  }
  return Object.freeze({
    read: () => checkpoint,
    persist: async (next: StrictSemanticReviewCheckpointV1) => {
      checkpoint = structuredClone(next);
      await writeJsonAtomic(checkpointPath, next);
    },
  });
}

function readExecutionContext(value: unknown): StrictTestPreparedExecutionContextV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('STRICT_TEST_EXECUTION_CONTEXT_REQUIRED');
  }
  const context = value as StrictTestPreparedExecutionContextV1;
  if (context.schemaVersion !== 1 || !context.carrier || !context.projection) {
    throw new Error('STRICT_TEST_EXECUTION_CONTEXT_INVALID');
  }
  return context;
}

async function findRunRoot(controlRoot: string, runId: string): Promise<string> {
  const root = path.join(controlRoot, 'strict-test-runs');
  const matches: string[] = [];
  try {
    for (const demand of await fsp.readdir(root, { withFileTypes: true })) {
      if (!demand.isDirectory() || demand.isSymbolicLink()) {
        continue;
      }
      const candidate = path.join(root, demand.name, runId);
      try {
        if ((await fsp.lstat(candidate)).isDirectory()) {
          matches.push(candidate);
        }
      } catch (error: unknown) {
        if (readCode(error) !== 'ENOENT') {
          throw error;
        }
      }
    }
  } catch (error: unknown) {
    if (readCode(error) === 'ENOENT') {
      throw new Error('STRICT_TEST_RUN_NOT_FOUND');
    }
    throw error;
  }
  if (matches.length !== 1) {
    throw new Error(matches.length ? 'STRICT_TEST_RUN_ID_AMBIGUOUS' : 'STRICT_TEST_RUN_NOT_FOUND');
  }
  return matches[0] as string;
}

async function snapshotProductionState(dataRoot: string): Promise<CanonicalSha256> {
  return snapshotPaths(
    dataRoot,
    ['.asd', 'Alembic'],
    (relativePath) =>
      relativePath.startsWith('.asd/logs/') || relativePath.startsWith('.asd/cache/')
  );
}

async function snapshotPublicRouteState(dataRoot: string): Promise<CanonicalSha256> {
  return snapshotPaths(dataRoot, ['.asd/context/recipe-publications'], () => false);
}

async function snapshotOfficialRecipeState(dataRoot: string): Promise<CanonicalSha256> {
  return snapshotPaths(
    dataRoot,
    ['Alembic', '.asd/alembic.db', '.asd/alembic.db-wal', '.asd/alembic.db-shm'],
    () => false
  );
}

async function snapshotPaths(
  root: string,
  relativeRoots: readonly string[],
  exclude: (relativePath: string) => boolean
): Promise<CanonicalSha256> {
  const rows: Array<Record<string, unknown>> = [];
  for (const relativeRoot of relativeRoots) {
    await snapshotEntry(path.resolve(root), relativeRoot, rows, exclude);
  }
  return hashCanonicalJson(
    rows.sort((left, right) => String(left.path).localeCompare(String(right.path)))
  );
}

async function snapshotEntry(
  root: string,
  relativePath: string,
  rows: Array<Record<string, unknown>>,
  exclude: (relativePath: string) => boolean
): Promise<void> {
  if (exclude(relativePath)) {
    return;
  }
  const target = path.join(root, relativePath);
  let stat: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    stat = await fsp.lstat(target);
  } catch (error: unknown) {
    if (readCode(error) === 'ENOENT') {
      rows.push({ path: relativePath, kind: 'absent' });
      return;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    rows.push({ path: relativePath, kind: 'symlink', target: await fsp.readlink(target) });
    return;
  }
  if (stat.isFile()) {
    rows.push({
      path: relativePath,
      kind: 'file',
      size: stat.size,
      hash: `sha256:${createHash('sha256')
        .update(await fsp.readFile(target))
        .digest('hex')}`,
    });
    return;
  }
  if (!stat.isDirectory()) {
    rows.push({ path: relativePath, kind: 'other', mode: stat.mode });
    return;
  }
  rows.push({ path: relativePath, kind: 'directory' });
  for (const child of (await fsp.readdir(target)).sort()) {
    await snapshotEntry(root, path.join(relativePath, child), rows, exclude);
  }
}

function sourceInventoryHash(projection: MainCertifiedProjectionPayload): CanonicalSha256 {
  return hashCanonicalJson(
    projection.files.map((file) => ({
      repoId: file.repoId,
      relativePath: file.relativePath,
      blobHash: file.blobHash,
      byteLength: file.byteLength,
      language: file.language,
      moduleIds: file.moduleIds,
    }))
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function stageError(
  stage: StrictTestFailureStageV1,
  code: string
): Error & { failedStage: StrictTestFailureStageV1 } {
  return Object.assign(new Error(code), { failedStage: stage });
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, filePath);
}

function readCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AgentService } from '@alembic/agent/service';
import { baseDimensions } from '@alembic/core/host-agent-workflows';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import type {
  PrivateCorpusRevisionInitReceiptV1,
  WorkspaceResolver,
} from '@alembic/core/workspace';
import {
  createRuntimeConfigLoadReceiptV1,
  type RuntimeConfigLoadReceiptV1,
} from '../../../infrastructure/config/RuntimeConfigLoadReceipt.js';
import type { ServiceContainer } from '../../../injection/ServiceContainer.js';
import {
  captureMainCertifiedProjectFacts,
  MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS,
  type MainCertifiedProjectFactsState,
  type MainCertifiedProjectionPayload,
  reopenMainCertifiedProjectFactsConsumer,
  resolveMainCertifiedProjectScopeHash,
} from '../../../project-facts/CertifiedProjectFactsRuntime.js';
import type { ProjectScopeAnalysisContext } from '../../../project-scope/ProjectScopeAnalysis.js';
import { commitPreparedPublicRoute, inspectPublicRoute } from './PublicRouteCas.js';
import { executeStrictAnalysisAndProduction } from './StrictAnalysisRuntime.js';
import { confinedPath, loadStrictProductionAuthorization } from './StrictAuthorization.js';
import {
  acquireStrictPublicationOperationLock,
  buildStrictCandidateCoverage,
  finalizeStrictCandidate,
  installAndVerifyStrictPublicationMarker,
  materializeStrictPublicServingData,
  persistAndVerifyStrictPublicServingBundle,
  preflightStrictPublicationMarker,
  type StrictPublicServingBundleReceiptV1,
  type StrictPublicServingDataReceiptV1,
  strictPublicationPaths,
  verifyStrictPublicationMarker,
  verifyStrictPublicServingBundle,
  verifyStrictPublicServingData,
} from './StrictFinalizationRuntime.js';
import { compileStrictColdStartPlanning } from './StrictPlanningRuntime.js';
import {
  indexSealAndVerifyStrictPrivateCorpus,
  persistStrictPrivateCorpusContent,
} from './StrictPrivateCorpusRuntime.js';
import type { StrictProductionRuntimeRequestV1 } from './StrictProductionContracts.js';
import { STRICT_PRODUCTION_STATES_V1, StrictProductionJournal } from './StrictProductionJournal.js';
import {
  createMainStrictResetDatabasePort,
  executeExactStrictReset,
  verifyStrictResetSnapshotAndRestoreProbe,
} from './StrictResetProtocol.js';
import {
  type RuntimeArtifactLoadReceiptV1,
  verifyRuntimeArtifactManifestV1,
} from './StrictRuntimeArtifacts.js';

const CHECKPOINT_FILE = 'strict-production.checkpoint.json';
const RUNTIME_REPORT_FILE = 'strict-production.runtime-report.json';
const REVISION_INIT_FILE = 'strict-private-revision-init-receipt.json';

interface StrictProductionCheckpointV1 {
  schemaVersion: 2;
  facts?: {
    carrier: MainCertifiedProjectFactsState;
    projection: MainCertifiedProjectionPayload;
  };
  planning?: Awaited<ReturnType<typeof compileStrictColdStartPlanning>>;
  analysis?: Awaited<ReturnType<typeof executeStrictAnalysisAndProduction>>;
  privateCorpusContent?: Awaited<ReturnType<typeof persistStrictPrivateCorpusContent>>;
  candidateCoverage?: ReturnType<typeof buildStrictCandidateCoverage>;
  privateCorpus?: Awaited<ReturnType<typeof indexSealAndVerifyStrictPrivateCorpus>>;
  publicServingData?: StrictPublicServingDataReceiptV1;
  finalization?: ReturnType<typeof finalizeStrictCandidate>;
  publicServingBundle?: StrictPublicServingBundleReceiptV1;
  rejectedPublicSnapshotIds?: string[];
}

interface StrictColdStartProductionInput {
  readonly analysisScope: ProjectScopeAnalysisContext;
  readonly container: ServiceContainer;
  readonly logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  readonly request: StrictProductionRuntimeRequestV1;
}

type StrictFactsStage = NonNullable<StrictProductionCheckpointV1['facts']>;
type StrictPlanningStage = NonNullable<StrictProductionCheckpointV1['planning']>;
type StrictAnalysisStage = NonNullable<StrictProductionCheckpointV1['analysis']>;
type StrictCandidateCoverageStage = NonNullable<StrictProductionCheckpointV1['candidateCoverage']>;
type StrictPrivateCorpusStage = NonNullable<StrictProductionCheckpointV1['privateCorpus']>;
type StrictPublicServingDataStage = NonNullable<StrictProductionCheckpointV1['publicServingData']>;
type StrictFinalizationStage = NonNullable<StrictProductionCheckpointV1['finalization']>;
type StrictPublicServingBundleStage = NonNullable<
  StrictProductionCheckpointV1['publicServingBundle']
>;

interface StrictExecutionContext {
  readonly input: StrictColdStartProductionInput;
  readonly authorization: Awaited<ReturnType<typeof loadStrictProductionAuthorization>>;
  readonly checkpoint: StrictProductionCheckpointV1;
  readonly dataRoot: string;
  readonly projectRoot: string;
  readonly operationRoot: string;
  readonly publicRoutePath: string;
  readonly journal: StrictProductionJournal;
  readonly runtimeArtifactReceipt: RuntimeArtifactLoadReceiptV1;
  readonly runtimeConfigReceipt: RuntimeConfigLoadReceiptV1;
}

export async function runStrictColdStartProduction(
  input: StrictColdStartProductionInput
): Promise<unknown> {
  const { dataRoot, projectRoot } = input.analysisScope;
  const authorization = await loadStrictProductionAuthorization({
    dataRoot,
    projectRoot,
    request: input.request,
  });
  const runtimeArtifacts = await verifyRuntimeArtifactManifestV1({
    expectedManifestContentHash: authorization.runtimeArtifacts.manifestContentHash,
    expectedManifestHash: authorization.runtimeArtifacts.manifestHash,
    manifestPath: requireRuntimeArtifactManifestPath(),
    manifestSymbol: authorization.runtimeArtifacts.manifestSymbol,
  });
  const workspaceResolver = input.container.singletons._workspaceResolver as
    | WorkspaceResolver
    | undefined;
  if (!workspaceResolver || workspaceResolver.projectRoot !== path.resolve(projectRoot)) {
    throw new Error('STRICT_RUNTIME_CONFIG_WORKSPACE_RESOLVER_MISMATCH');
  }
  const runtimeConfigReceipt = createRuntimeConfigLoadReceiptV1({
    projectRoot,
    workspaceResolver,
    planning: authorization.planning,
    artifactBindings: runtimeArtifacts.artifactBindings,
    actualProvider: input.container.singletons.aiProvider,
    actualEmbeddingProvider: input.container.singletons._embedProvider,
  });
  const operationRoot = confinedPath(dataRoot, authorization.operationRoot);
  const publicRoutePath = strictPublicationPaths(dataRoot).activePath;
  const actualProjectIdentityHash = resolveMainCertifiedProjectScopeHash({
    analysisScope: input.analysisScope,
    projectRoot,
  });
  if (actualProjectIdentityHash !== authorization.privateCorpus.projectIdentityHash) {
    throw new Error('STRICT_AUTHORIZATION_PROJECT_IDENTITY_MISMATCH');
  }
  const publicationLock = await acquireStrictPublicationOperationLock({
    dataRoot,
    ownerId: input.request.ownerId,
    runId: input.request.runId,
  });
  try {
    const journal = await StrictProductionJournal.open({
      operationRoot,
      ownerId: input.request.ownerId,
      resumeOwnerId: input.request.resumeOwnerId,
      runId: input.request.runId,
    });
    try {
      assertRuntimeLoadResumeBindings({
        authorizationHash: authorization.authorizationHash,
        journal,
        runtimeArtifactReceipt: runtimeArtifacts.receipt,
        runtimeConfigReceipt,
      });
      const checkpoint = await readCheckpoint(operationRoot);
      if (journal.resumePoint === 'FINALIZED') {
        return verifyFinalizedReplay({
          authorization,
          checkpoint,
          dataRoot,
          operationRoot,
          publicRoutePath,
          runtimeArtifactReceipt: runtimeArtifacts.receipt,
          runtimeConfigReceipt,
        });
      }
      const context: StrictExecutionContext = {
        input,
        authorization,
        checkpoint,
        dataRoot,
        projectRoot,
        operationRoot,
        publicRoutePath,
        journal,
        runtimeArtifactReceipt: runtimeArtifacts.receipt,
        runtimeConfigReceipt,
      };
      await prepareAuthorizedBlankState(context);
      const { facts, planning } = await ensureFactsAndPlanning(context);
      const analysis = await ensureAnalysis(context, facts, planning);
      const { candidateCoverage, privateCorpus } = await ensurePrivateCorpus(
        context,
        facts,
        planning,
        analysis
      );
      return await finalizeAndPublish(
        context,
        facts,
        planning,
        analysis,
        candidateCoverage,
        privateCorpus
      );
    } finally {
      await journal.close();
    }
  } finally {
    await publicationLock.close();
  }
}

async function verifyFinalizedReplay(input: {
  readonly authorization: Awaited<ReturnType<typeof loadStrictProductionAuthorization>>;
  readonly checkpoint: StrictProductionCheckpointV1;
  readonly dataRoot: string;
  readonly operationRoot: string;
  readonly publicRoutePath: string;
  readonly runtimeArtifactReceipt: RuntimeArtifactLoadReceiptV1;
  readonly runtimeConfigReceipt: RuntimeConfigLoadReceiptV1;
}): Promise<unknown> {
  const {
    authorization,
    checkpoint,
    dataRoot,
    operationRoot,
    publicRoutePath,
    runtimeArtifactReceipt,
    runtimeConfigReceipt,
  } = input;
  if (
    !checkpoint.publicServingData ||
    !checkpoint.finalization ||
    !checkpoint.privateCorpus ||
    !checkpoint.publicServingBundle
  ) {
    throw new Error('STRICT_FINALIZED_PUBLIC_BUNDLE_CHECKPOINT_MISSING');
  }
  await verifyStrictPublicationMarker({
    dataRoot,
    projectIdentityHash: authorization.privateCorpus.projectIdentityHash,
    migrationBundleHash: authorization.privateCorpus.acceptedMigrationBundleSemanticHash,
  });
  await verifyStrictPublicServingBundle({
    dataRoot,
    dataReceipt: checkpoint.publicServingData,
    finalization: checkpoint.finalization,
    privateCorpus: checkpoint.privateCorpus,
    receipt: checkpoint.publicServingBundle,
  });
  const report = (await readJson(path.join(operationRoot, RUNTIME_REPORT_FILE))) as {
    publicHandle?: { routeHash?: unknown };
    runtimeLoad?: {
      artifactReceipt?: { receiptHash?: unknown };
      configReceipt?: { receiptHash?: unknown };
    };
  };
  if (
    report.runtimeLoad?.artifactReceipt?.receiptHash !== runtimeArtifactReceipt.receiptHash ||
    report.runtimeLoad?.configReceipt?.receiptHash !== runtimeConfigReceipt.receiptHash
  ) {
    throw new Error('STRICT_RUNTIME_LOAD_RECEIPT_RESUME_MISMATCH');
  }
  const currentRoute = await inspectPublicRoute(publicRoutePath);
  if (
    !currentRoute ||
    currentRoute.hash !== report.publicHandle?.routeHash ||
    currentRoute.bytes !== checkpoint.finalization.preparedPublicRoute.canonicalBytes
  ) {
    throw new Error('STRICT_FINALIZED_PUBLIC_ROUTE_DIVERGENCE');
  }
  return report;
}

async function prepareAuthorizedBlankState(context: StrictExecutionContext): Promise<void> {
  const { authorization, checkpoint, dataRoot, journal, operationRoot, publicRoutePath } = context;
  const database = context.input.container.get('database');
  await advance(journal, 'PC_F_ACCEPTED', {
    pcfBaselineReceiptHash: authorization.pcfBaselineReceiptHash,
    runtimeArtifactManifestHash: context.runtimeArtifactReceipt.manifestHash,
    runtimeArtifactReceiptHash: context.runtimeArtifactReceipt.receiptHash,
  });
  await advance(journal, 'AUTHORIZED', {
    authorizationHash: authorization.authorizationHash,
    runtimeConfigHash: context.runtimeConfigReceipt.configHash,
    runtimeConfigReceiptHash: context.runtimeConfigReceipt.receiptHash,
  });
  const markerInput = {
    dataRoot,
    projectIdentityHash: authorization.privateCorpus.projectIdentityHash,
    migrationBundleHash: authorization.privateCorpus.acceptedMigrationBundleSemanticHash,
  };
  await preflightStrictPublicationMarker({
    ...markerInput,
    allowMissingForPristineOperation: before(journal.resumePoint, 'BLANK'),
  });
  const observedPublicRoute = await inspectPublicRoute(publicRoutePath);
  const preparedRoute = checkpoint.finalization?.preparedPublicRoute;
  const exactPreparedRouteObserved = Boolean(
    observedPublicRoute &&
      preparedRoute &&
      observedPublicRoute.hash === hashCanonicalJson(preparedRoute.route) &&
      observedPublicRoute.bytes === preparedRoute.canonicalBytes
  );
  if (before(journal.resumePoint, 'PUBLIC_CAS_PREPARED') && observedPublicRoute !== null) {
    throw new Error('STRICT_AUTHORIZATION_OBSERVED_POINTER_MISMATCH');
  }
  if (
    !before(journal.resumePoint, 'PUBLIC_CAS_PREPARED') &&
    observedPublicRoute !== null &&
    !exactPreparedRouteObserved
  ) {
    throw new Error('STRICT_AUTHORIZATION_OBSERVED_POINTER_MISMATCH');
  }
  if (!before(journal.resumePoint, 'PUBLIC_CAS_COMMITTED') && !exactPreparedRouteObserved) {
    throw new Error('STRICT_PUBLIC_ROUTE_COMMIT_READBACK_MISSING');
  }
  await advance(journal, 'JOURNAL_OPEN', {
    runtimeArtifactReceiptHash: context.runtimeArtifactReceipt.receiptHash,
    runtimeConfigReceiptHash: context.runtimeConfigReceipt.receiptHash,
    observedPointersHash: hashCanonicalJson({
      publicRouteHash: observedPublicRoute?.hash ?? null,
      resetPaths: authorization.reset.relativePaths,
      resetTables: authorization.reset.tables,
    }),
  });
  if (before(journal.resumePoint, 'SNAPSHOT_VERIFIED')) {
    const snapshot = await verifyStrictResetSnapshotAndRestoreProbe({
      allowedRelativePaths: authorization.reset.relativePaths,
      allowedTables: authorization.reset.tables,
      dataRoot,
      database,
      snapshotRoot: path.join(operationRoot, 'snapshots', 'pre-reset'),
    });
    await advance(journal, 'SNAPSHOT_VERIFIED', {
      snapshotReceiptHash: snapshot.receiptHash,
      restoreProbeHash: snapshot.restoreProbeHash,
    });
  }
  if (before(journal.resumePoint, 'BLANK')) {
    const reset = await executeExactStrictReset({
      allowedRelativePaths: authorization.reset.relativePaths,
      allowedTables: authorization.reset.tables,
      dataRoot,
      database: createMainStrictResetDatabasePort(database),
    });
    const marker = await installAndVerifyStrictPublicationMarker(markerInput);
    await advance(journal, 'BLANK', {
      resetReceiptHash: reset.receiptHash,
      markerHash: marker.markerHash,
      blank: true,
    });
  }
}

async function ensureFactsAndPlanning(
  context: StrictExecutionContext
): Promise<{ facts: StrictFactsStage; planning: StrictPlanningStage }> {
  const { checkpoint, dataRoot, journal, operationRoot, projectRoot } = context;
  let facts = checkpoint.facts;
  if (!facts) {
    const carrier = await captureMainCertifiedProjectFacts({
      analysisScope: context.input.analysisScope,
      dimensions: [...baseDimensions],
      projectRoot,
      source: 'alembic-main-bootstrap',
    });
    const reopened = await reopenMainCertifiedProjectFactsConsumer({
      carrier,
      consumer: 'recipe-generation',
      dataRoot,
      entrypoint: MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS['recipe-generation'],
      runId: `${context.input.request.runId}:recipe-generation`,
    });
    facts = { carrier, projection: reopened.projection };
    checkpoint.facts = facts;
    await writeCheckpoint(operationRoot, checkpoint);
  }
  assertSingleCaptureFacts(facts.carrier);
  if (
    facts.carrier.canonicalScopeHash !== context.authorization.privateCorpus.projectIdentityHash
  ) {
    throw new Error('STRICT_CERTIFIED_PROJECT_IDENTITY_MISMATCH');
  }
  await advance(journal, 'PROJECT_FACTS_READY', {
    artifactId: facts.carrier.artifactId,
    factsContentHash: facts.carrier.factsContentHash,
    sourceVectorHash: facts.carrier.sourceVectorHash,
    recipeConsumerReceiptHash: facts.carrier.receipts['recipe-generation']?.receiptHash,
  });
  let planning = checkpoint.planning;
  if (!planning) {
    planning = await compileStrictColdStartPlanning({
      agentService: context.input.container.get('agentService') as Pick<AgentService, 'run'>,
      authorization: context.authorization.planning,
      carrier: facts.carrier,
      projection: facts.projection,
    });
    checkpoint.planning = planning;
    await writeCheckpoint(operationRoot, checkpoint);
  }
  await advancePlanningJournal(journal, planning);
  return { facts, planning };
}

async function advancePlanningJournal(
  journal: StrictProductionJournal,
  planning: StrictPlanningStage
): Promise<void> {
  await advance(journal, 'REQUIRED_FACT_UNIVERSE_READY', {
    requiredUniverseHash: planning.compiledPlan.requiredFactApplicability.requiredHash,
    requiredCount: planning.compiledPlan.requiredFactApplicability.requiredCount,
  });
  await advance(journal, 'PLAN_COGNITION_ACCEPTED', {
    planCognitionHash: planning.planCognitionHash,
  });
  await advance(journal, 'PLAN_COMPILED', {
    compiledPlanHash: planning.compiledPlan.canonicalPlanHash,
    eligibleCellCount: planning.compiledPlan.universe.eligibleCount,
  });
  await advance(journal, 'BASELINE_FACT_SCHEDULE_FROZEN', {
    baselineScheduleHash: planning.compiledPlan.schedule.baselineScheduleHash,
    factObligationCount: planning.compiledPlan.schedule.factHarvestObligations.length,
  });
}

async function ensureAnalysis(
  context: StrictExecutionContext,
  facts: StrictFactsStage,
  planning: StrictPlanningStage
): Promise<StrictAnalysisStage> {
  let analysis = context.checkpoint.analysis;
  if (!analysis) {
    const journalId = context.journal.entries.at(-1)?.entryHash;
    if (!journalId) {
      throw new Error('STRICT_ANALYSIS_JOURNAL_BINDING_REQUIRED');
    }
    analysis = await executeStrictAnalysisAndProduction({
      agentService: context.input.container.get('agentService') as Pick<AgentService, 'run'>,
      compiledPlan: planning.compiledPlan,
      journalId,
      modelHash: context.authorization.planning.modelHash,
      planCognitionHash: planning.planCognitionHash,
      projection: facts.projection,
      reviewer: context.authorization.planning.reviewer,
      runId: context.input.request.runId,
    });
    context.checkpoint.analysis = analysis;
    await writeCheckpoint(context.operationRoot, context.checkpoint);
  }
  await advanceAnalysisJournal(context.journal, analysis);
  return analysis;
}

async function advanceAnalysisJournal(
  journal: StrictProductionJournal,
  analysis: StrictAnalysisStage
): Promise<void> {
  await advance(journal, 'CODE_FACTS_READY', {
    factCount: analysis.facts.length,
    factGraphHash: hashCanonicalJson(analysis.facts.map((fact) => fact.factId)),
  });
  await advance(journal, 'BASELINE_POPULATIONS_READY', {
    populationHash: analysis.epoch.population.populationHash,
    conservation: analysis.epoch.population.conservation,
  });
  await advance(journal, 'ANALYSIS_EPOCHS_OPEN', { epochHash: analysis.epoch.epochHash });
  await advance(journal, 'ANALYSIS_FIXPOINT_CLOSED', {
    analysisFixpointHash: analysis.fixpoint.fixpointHash,
  });
  await advance(journal, 'EXPRESSION_BATCH_OPEN', {
    eligibleHypothesisCount: analysis.epoch.producerEligibleHypotheses.length,
  });
  await advance(journal, 'HYPOTHESIS_EXPRESSION_SETS_CLOSED', {
    expressionSetManifestHash: hashCanonicalJson(analysis.expressionSets.map((set) => set.setHash)),
  });
}

async function ensurePrivateCorpus(
  context: StrictExecutionContext,
  facts: StrictFactsStage,
  planning: StrictPlanningStage,
  analysis: StrictAnalysisStage
): Promise<{
  candidateCoverage: StrictCandidateCoverageStage;
  privateCorpus: StrictPrivateCorpusStage;
}> {
  const resolver = context.input.container.singletons._workspaceResolver as
    | WorkspaceResolver
    | undefined;
  if (!resolver || resolver.projectRoot !== path.resolve(context.projectRoot)) {
    throw new Error('STRICT_PRIVATE_CORPUS_WORKSPACE_RESOLVER_MISMATCH');
  }
  let content = context.checkpoint.privateCorpusContent;
  if (!content) {
    const initReceipt = await readOptionalJson(
      path.join(context.operationRoot, REVISION_INIT_FILE)
    );
    content = await persistStrictPrivateCorpusContent({
      acceptedMigrationBundleSemanticHash:
        context.authorization.privateCorpus.acceptedMigrationBundleSemanticHash,
      analysisFixpointHash: analysis.fixpoint.fixpointHash,
      baseResolver: resolver,
      configReceiptHash: planning.configReceipt.loadHash,
      credentialLocationSymbol: context.authorization.privateCorpus.credentialLocationSymbol,
      expressionSets: analysis.expressionSets,
      independentReviews: analysis.independentReviews,
      journal: context.journal,
      manifestHash: facts.carrier.certificationBindingHash,
      planHash: planning.compiledPlan.canonicalPlanHash,
      recoveryRoot: path.join(context.operationRoot, 'prepared-rows'),
      runId: context.input.request.runId,
      ...(initReceipt
        ? { resumeInitReceipt: initReceipt as PrivateCorpusRevisionInitReceiptV1 }
        : {}),
      onRevisionInitialized: (receipt) =>
        writeJsonAtomic(path.join(context.operationRoot, REVISION_INIT_FILE), receipt),
    });
    context.checkpoint.privateCorpusContent = content;
    await writeCheckpoint(context.operationRoot, context.checkpoint);
  }
  await advance(context.journal, 'CONTENT_READY_CORPUS_SEALED', {
    privateCorpusRevision: content.revisionId,
    rootManifestHash: content.rootManifestHash,
    bindingCount: content.bindings.length,
  });
  let candidateCoverage = context.checkpoint.candidateCoverage;
  if (!candidateCoverage) {
    candidateCoverage = buildStrictCandidateCoverage({
      analysis,
      compiledPlan: planning.compiledPlan,
      expressionSets: analysis.expressionSets,
      privateCorpus: content,
      reviewerIdentity: context.authorization.planning.reviewer.identity,
    });
    context.checkpoint.candidateCoverage = candidateCoverage;
    await writeCheckpoint(context.operationRoot, context.checkpoint);
  }
  await advance(context.journal, 'CANDIDATE_COVERAGE_CLOSED', {
    candidateCoverageReceiptHash: candidateCoverage.receiptHash,
  });
  await advance(context.journal, 'CANDIDATE_ASSEMBLED', {
    candidateAssemblyHash: hashCanonicalJson({
      activeRecipes: content.activeRecipes,
      bindings: content.bindings.map((binding) => binding.bindingHash),
      rootManifestHash: content.rootManifestHash,
    }),
  });
  let privateCorpus = context.checkpoint.privateCorpus;
  if (!privateCorpus) {
    privateCorpus = await indexSealAndVerifyStrictPrivateCorpus({
      baseResolver: resolver,
      content,
      embedProvider: context.input.container.singletons._embedProvider as Parameters<
        typeof indexSealAndVerifyStrictPrivateCorpus
      >[0]['embedProvider'],
    });
    context.checkpoint.privateCorpus = privateCorpus;
    await writeCheckpoint(context.operationRoot, context.checkpoint);
  }
  await advance(context.journal, 'INDEXES_BUILT', {
    vectorGenerationId: privateCorpus.vectorGenerationId,
    vectorManifestHash: privateCorpus.vectorManifestHash,
  });
  await advance(context.journal, 'CANDIDATE_DATA_SEALED', {
    rootManifestHash: privateCorpus.rootManifestHash,
  });
  return { candidateCoverage, privateCorpus };
}

async function finalizeAndPublish(
  context: StrictExecutionContext,
  facts: StrictFactsStage,
  planning: StrictPlanningStage,
  analysis: StrictAnalysisStage,
  candidateCoverage: StrictCandidateCoverageStage,
  privateCorpus: StrictPrivateCorpusStage,
  excludedSnapshotId?: string
): Promise<unknown> {
  const resolver = requirePublicBundleResolver(context);
  const publicServingData = await resolvePublicServingData(
    context,
    resolver,
    planning,
    candidateCoverage,
    privateCorpus,
    excludedSnapshotId ?? context.checkpoint.rejectedPublicSnapshotIds?.at(-1)
  );
  const finalization = await resolveStrictFinalization(
    context,
    facts,
    planning,
    analysis,
    candidateCoverage,
    privateCorpus,
    publicServingData
  );
  const publicServingBundle = await resolvePublicServingBundle(
    context,
    candidateCoverage,
    privateCorpus,
    publicServingData,
    finalization
  );
  await advanceStrictFinalizationJournal(context, finalization);
  await verifyStrictPublicationMarker({
    dataRoot: context.dataRoot,
    projectIdentityHash: context.authorization.privateCorpus.projectIdentityHash,
    migrationBundleHash: context.authorization.privateCorpus.acceptedMigrationBundleSemanticHash,
  });
  await verifyStrictPublicServingBundle({
    dataRoot: context.dataRoot,
    dataReceipt: publicServingData,
    finalization,
    privateCorpus,
    receipt: publicServingBundle,
  });
  await advance(context.journal, 'PUBLIC_CAS_PREPARED', {
    preparedRouteHash: hashCanonicalJson(finalization.preparedPublicRoute.route),
    routeBytesHash: finalization.preparedPublicRoute.routeBytesHash,
    semanticHash: finalization.preparedPublicRoute.semanticHash,
  });
  const route = await commitPreparedPublicRoute({
    expectedCurrentHash: null,
    prepared: {
      bytes: finalization.preparedPublicRoute.canonicalBytes,
      hash: hashCanonicalJson(finalization.preparedPublicRoute.route),
    },
    routePath: context.publicRoutePath,
  });
  await advance(context.journal, 'PUBLIC_CAS_COMMITTED', {
    routeHash: route.routeHash,
    status: route.status,
  });
  const report = buildRuntimeReport(
    context,
    facts,
    planning,
    analysis,
    privateCorpus,
    finalization,
    route.routeHash
  );
  await writeJsonAtomic(path.join(context.operationRoot, RUNTIME_REPORT_FILE), report);
  await advance(context.journal, 'FINALIZED', {
    runtimeReportHash: hashCanonicalJson(report),
    publicRouteHash: route.routeHash,
    runtimeArtifactReceiptHash: context.runtimeArtifactReceipt.receiptHash,
    runtimeConfigReceiptHash: context.runtimeConfigReceipt.receiptHash,
  });
  return report;
}

function requirePublicBundleResolver(context: StrictExecutionContext): WorkspaceResolver {
  const resolver = context.input.container.singletons._workspaceResolver as
    | WorkspaceResolver
    | undefined;
  if (!resolver || resolver.projectRoot !== path.resolve(context.projectRoot)) {
    throw new Error('STRICT_PUBLIC_BUNDLE_WORKSPACE_RESOLVER_MISMATCH');
  }
  return resolver;
}

async function resolvePublicServingData(
  context: StrictExecutionContext,
  resolver: WorkspaceResolver,
  planning: StrictPlanningStage,
  candidateCoverage: StrictCandidateCoverageStage,
  privateCorpus: StrictPrivateCorpusStage,
  excludedSnapshotId?: string
): Promise<StrictPublicServingDataStage> {
  const existing = context.checkpoint.publicServingData;
  if (existing) {
    try {
      await verifyStrictPublicServingData({
        candidateCoverage,
        dataRoot: context.dataRoot,
        privateCorpus,
        receipt: existing,
      });
      return existing;
    } catch (error) {
      if (!(await canRepairPublicSnapshot(context))) {
        throw error;
      }
      await invalidatePublicSnapshotCheckpoint(context, existing.snapshotId);
      throw new Error('STRICT_PUBLIC_SNAPSHOT_INVALIDATED', { cause: error });
    }
  }
  const created = await materializeStrictPublicServingData({
    baseResolver: resolver,
    candidateCoverage,
    dataRoot: context.dataRoot,
    ...(excludedSnapshotId ? { excludedSnapshotId } : {}),
    privateCorpus,
    revisionInitReceipt: privateCorpus.revisionInitReceipt,
    projectIdentityHash: context.authorization.privateCorpus.projectIdentityHash,
    migrationBundleHash: context.authorization.privateCorpus.acceptedMigrationBundleSemanticHash,
    servingConfig: {
      loadHash: planning.configReceipt.loadHash,
      sourceArtifactHash: planning.configReceipt.sourceArtifactHash,
      strictColdStart: planning.configReceipt.strictColdStart,
    },
  });
  context.checkpoint.publicServingData = created;
  await writeCheckpoint(context.operationRoot, context.checkpoint);
  return created;
}

async function resolveStrictFinalization(
  context: StrictExecutionContext,
  facts: StrictFactsStage,
  planning: StrictPlanningStage,
  analysis: StrictAnalysisStage,
  candidateCoverage: StrictCandidateCoverageStage,
  privateCorpus: StrictPrivateCorpusStage,
  publicServingData: StrictPublicServingDataStage
): Promise<StrictFinalizationStage> {
  const existing = context.checkpoint.finalization;
  const reconstructed = finalizeStrictCandidate({
    analysis,
    candidateCoverage,
    candidateDataManifestHash: publicServingData.candidateDataManifestHash,
    certifiedProjectFactsHash: facts.carrier.certificationBindingHash,
    committedAt: existing?.preparedPublicRoute.route.committedAt ?? new Date().toISOString(),
    compiledPlan: planning.compiledPlan,
    expressionSets: analysis.expressionSets,
    planCognitionHash: planning.planCognitionHash,
    privateCorpus,
    runId: context.input.request.runId,
    snapshotId: publicServingData.snapshotId,
  });
  if (existing) {
    if (hashCanonicalJson(reconstructed) !== hashCanonicalJson(existing)) {
      throw new Error('STRICT_FINALIZATION_CHECKPOINT_DIVERGENCE');
    }
    return reconstructed;
  }
  context.checkpoint.finalization = reconstructed;
  await writeCheckpoint(context.operationRoot, context.checkpoint);
  return reconstructed;
}

function requireRuntimeArtifactManifestPath(): string {
  const manifestPath = process.env.ALEMBIC_RUNTIME_ARTIFACT_MANIFEST_PATH?.trim();
  if (!manifestPath || !path.isAbsolute(manifestPath)) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_MANIFEST_PATH_REQUIRED');
  }
  return path.resolve(manifestPath);
}

function assertRuntimeLoadResumeBindings(input: {
  readonly authorizationHash: string;
  readonly journal: StrictProductionJournal;
  readonly runtimeArtifactReceipt: RuntimeArtifactLoadReceiptV1;
  readonly runtimeConfigReceipt: RuntimeConfigLoadReceiptV1;
}): void {
  const expectedByState: Partial<
    Record<(typeof STRICT_PRODUCTION_STATES_V1)[number], Readonly<Record<string, unknown>>>
  > = {
    PC_F_ACCEPTED: {
      runtimeArtifactManifestHash: input.runtimeArtifactReceipt.manifestHash,
      runtimeArtifactReceiptHash: input.runtimeArtifactReceipt.receiptHash,
    },
    AUTHORIZED: {
      authorizationHash: input.authorizationHash,
      runtimeConfigHash: input.runtimeConfigReceipt.configHash,
      runtimeConfigReceiptHash: input.runtimeConfigReceipt.receiptHash,
    },
    JOURNAL_OPEN: {
      runtimeArtifactReceiptHash: input.runtimeArtifactReceipt.receiptHash,
      runtimeConfigReceiptHash: input.runtimeConfigReceipt.receiptHash,
    },
    FINALIZED: {
      runtimeArtifactReceiptHash: input.runtimeArtifactReceipt.receiptHash,
      runtimeConfigReceiptHash: input.runtimeConfigReceipt.receiptHash,
    },
  };
  for (const entry of input.journal.entries) {
    const expected = expectedByState[entry.state];
    if (expected && Object.entries(expected).some(([key, value]) => entry.payload[key] !== value)) {
      throw new Error('STRICT_RUNTIME_LOAD_RECEIPT_RESUME_MISMATCH');
    }
  }
}

async function resolvePublicServingBundle(
  context: StrictExecutionContext,
  candidateCoverage: StrictCandidateCoverageStage,
  privateCorpus: StrictPrivateCorpusStage,
  publicServingData: StrictPublicServingDataStage,
  finalization: StrictFinalizationStage
): Promise<StrictPublicServingBundleStage> {
  const existing = context.checkpoint.publicServingBundle;
  if (!existing) {
    const created = await persistAndVerifyStrictPublicServingBundle({
      dataRoot: context.dataRoot,
      dataReceipt: publicServingData,
      finalization,
      privateCorpus,
    });
    context.checkpoint.publicServingBundle = created;
    await writeCheckpoint(context.operationRoot, context.checkpoint);
    return created;
  }
  try {
    await verifyStrictPublicServingBundle({
      dataRoot: context.dataRoot,
      dataReceipt: publicServingData,
      finalization,
      privateCorpus,
      receipt: existing,
    });
    return existing;
  } catch (error) {
    if (!(await canRepairPublicSnapshot(context))) {
      throw error;
    }
    await invalidatePublicSnapshotCheckpoint(context, publicServingData.snapshotId);
    throw new Error('STRICT_PUBLIC_SNAPSHOT_INVALIDATED', { cause: error });
  }
}

async function advanceStrictFinalizationJournal(
  context: StrictExecutionContext,
  finalization: StrictFinalizationStage
): Promise<void> {
  await advance(context.journal, 'G4_READY', { g4ReceiptHash: finalization.g4ReceiptHash });
  await advance(context.journal, 'SERVING_RECONCILED', {
    candidateDataManifestHash: finalization.candidateDataManifestHash,
  });
  await advance(context.journal, 'FINAL_COVERAGE_BOUND', {
    finalCoverageBindingHash: finalization.finalCoverage.receiptHash,
  });
  await advance(context.journal, 'SERVING_SNAPSHOT_VALIDATED', {
    servingSnapshotValidationHash: finalization.servingSnapshotValidation.receiptHash,
  });
  await advance(context.journal, 'SERVING_MANIFEST_READY', {
    servingSnapshotManifestHash: finalization.servingManifest.manifestHash,
  });
}

async function canRepairPublicSnapshot(context: StrictExecutionContext): Promise<boolean> {
  return (
    before(context.journal.resumePoint, 'PUBLIC_CAS_PREPARED') &&
    (await inspectPublicRoute(context.publicRoutePath)) === null
  );
}

async function invalidatePublicSnapshotCheckpoint(
  context: StrictExecutionContext,
  snapshotId: string
): Promise<void> {
  context.checkpoint.rejectedPublicSnapshotIds = [
    ...new Set([...(context.checkpoint.rejectedPublicSnapshotIds ?? []), snapshotId]),
  ];
  delete context.checkpoint.publicServingData;
  delete context.checkpoint.finalization;
  delete context.checkpoint.publicServingBundle;
  await writeCheckpoint(context.operationRoot, context.checkpoint);
}

function buildRuntimeReport(
  context: StrictExecutionContext,
  facts: StrictFactsStage,
  planning: StrictPlanningStage,
  analysis: StrictAnalysisStage,
  privateCorpus: StrictPrivateCorpusStage,
  finalization: NonNullable<StrictProductionCheckpointV1['finalization']>,
  routeHash: string
) {
  return Object.freeze({
    schemaVersion: 1,
    mode: 'strict-production',
    status: 'FINALIZED',
    runId: context.input.request.runId,
    runtimeLoad: {
      artifactReceipt: context.runtimeArtifactReceipt,
      configReceipt: context.runtimeConfigReceipt,
    },
    publicHandle: {
      routeHash,
      snapshotId: finalization.servingManifest.snapshotId,
      servingSnapshotManifestHash: finalization.servingManifest.manifestHash,
    },
    privateCorpusEvidence: {
      servingSnapshotValidationHash: finalization.servingSnapshotValidation.receiptHash,
      sealedCorpusVerificationHash: privateCorpus.sealedCorpusVerification.verificationHash,
      finalCoverageBindingHash: finalization.finalCoverage.receiptHash,
      activeRecipeCount: privateCorpus.activeRecipeIds.length,
      g1ReceiptCount: privateCorpus.g1Receipts.length,
    },
    analysisHandle: {
      factCount: analysis.facts.length,
      directFactCount: analysis.facts.filter((fact) => fact.kind === 'direct').length,
      derivedFactCount: analysis.facts.filter((fact) => fact.kind === 'derived').length,
      expressionSetCount: analysis.expressionSets.length,
      analysisFixpointHash: analysis.fixpoint.fixpointHash,
    },
    provenance: {
      certifiedProjectFactsHash: facts.carrier.certificationBindingHash,
      sourceRevisionVectorHash: facts.carrier.sourceVectorHash,
      planCognitionHash: planning.planCognitionHash,
      compiledPlanHash: planning.compiledPlan.canonicalPlanHash,
      analysisFixpointHash: analysis.fixpoint.fixpointHash,
      journalHeadHash: context.journal.entries.at(-1)?.entryHash,
    },
    compatibility: {
      legacyColdStartChanged: false,
      incrementalRescan: 'typed-unreachable-from-strict-cold-start',
      legacyReaders: 'unchanged-not-consumed-by-strict-route',
      privateHooks: 'not-installed',
      asyncFill: false,
      pluginServingImplemented: false,
      queryTimeWrites: false,
    },
  });
}

function assertSingleCaptureFacts(carrier: MainCertifiedProjectFactsState): void {
  const recipeReopens = carrier.instrumentation.filter(
    (event) => event.kind === 'consumer-reopen' && event.consumer === 'recipe-generation'
  );
  if (
    recipeReopens.length !== 1 ||
    carrier.counters.cappedModuleProjectionCount !== 0 ||
    carrier.counters.rawFilesystemFallbackCount !== 0 ||
    carrier.counters.synthesizedProjectScopeFactCount !== 0 ||
    carrier.counters.directProjectContextCallCount !== 0
  ) {
    throw new Error('STRICT_PROJECT_FACTS_SINGLE_CAPTURE_INVARIANT_FAILED');
  }
}

async function advance(
  journal: StrictProductionJournal,
  state: (typeof STRICT_PRODUCTION_STATES_V1)[number],
  payload: Readonly<Record<string, unknown>>
): Promise<void> {
  if (before(journal.resumePoint, state)) {
    await journal.append(state, payload);
  }
}

function before(
  current: (typeof STRICT_PRODUCTION_STATES_V1)[number] | null,
  target: (typeof STRICT_PRODUCTION_STATES_V1)[number]
): boolean {
  return (
    (current === null ? -1 : STRICT_PRODUCTION_STATES_V1.indexOf(current)) <
    STRICT_PRODUCTION_STATES_V1.indexOf(target)
  );
}

async function readCheckpoint(operationRoot: string): Promise<StrictProductionCheckpointV1> {
  const value = await readOptionalJson(path.join(operationRoot, CHECKPOINT_FILE));
  if (value === null) {
    return { schemaVersion: 2 };
  }
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 2
  ) {
    throw new Error('STRICT_CHECKPOINT_PUBLICATION_CONTRACT_MISMATCH');
  }
  return value as StrictProductionCheckpointV1;
}

async function writeCheckpoint(
  operationRoot: string,
  checkpoint: StrictProductionCheckpointV1
): Promise<void> {
  await writeJsonAtomic(path.join(operationRoot, CHECKPOINT_FILE), checkpoint);
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fsp.readFile(filePath, 'utf8')) as unknown;
}

async function readOptionalJson(filePath: string): Promise<unknown | null> {
  try {
    return await readJson(filePath);
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${randomUUID()}`;
  const handle = await fsp.open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
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

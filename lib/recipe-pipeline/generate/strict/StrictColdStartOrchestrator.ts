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
import type { ServiceContainer } from '../../../injection/ServiceContainer.js';
import {
  captureMainCertifiedProjectFacts,
  MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS,
  type MainCertifiedProjectFactsState,
  type MainCertifiedProjectionPayload,
  reopenMainCertifiedProjectFactsConsumer,
} from '../../../project-facts/CertifiedProjectFactsRuntime.js';
import type { ProjectScopeAnalysisContext } from '../../../project-scope/ProjectScopeAnalysis.js';
import { commitPreparedPublicRoute, inspectPublicRoute } from './PublicRouteCas.js';
import { executeStrictAnalysisAndProduction } from './StrictAnalysisRuntime.js';
import { confinedPath, loadStrictProductionAuthorization } from './StrictAuthorization.js';
import {
  buildStrictCandidateCoverage,
  finalizeStrictCandidate,
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

const CHECKPOINT_FILE = 'strict-production.checkpoint.json';
const RUNTIME_REPORT_FILE = 'strict-production.runtime-report.json';
const REVISION_INIT_FILE = 'strict-private-revision-init-receipt.json';

interface StrictProductionCheckpointV1 {
  schemaVersion: 1;
  facts?: {
    carrier: MainCertifiedProjectFactsState;
    projection: MainCertifiedProjectionPayload;
  };
  planning?: Awaited<ReturnType<typeof compileStrictColdStartPlanning>>;
  analysis?: Awaited<ReturnType<typeof executeStrictAnalysisAndProduction>>;
  privateCorpusContent?: Awaited<ReturnType<typeof persistStrictPrivateCorpusContent>>;
  candidateCoverage?: ReturnType<typeof buildStrictCandidateCoverage>;
  privateCorpus?: Awaited<ReturnType<typeof indexSealAndVerifyStrictPrivateCorpus>>;
  finalization?: ReturnType<typeof finalizeStrictCandidate>;
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

interface StrictExecutionContext {
  readonly input: StrictColdStartProductionInput;
  readonly authorization: Awaited<ReturnType<typeof loadStrictProductionAuthorization>>;
  readonly checkpoint: StrictProductionCheckpointV1;
  readonly dataRoot: string;
  readonly projectRoot: string;
  readonly operationRoot: string;
  readonly publicRoutePath: string;
  readonly journal: StrictProductionJournal;
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
  const operationRoot = confinedPath(dataRoot, authorization.operationRoot);
  const publicRoutePath = confinedPath(dataRoot, authorization.publicRoutePath);
  const journal = await StrictProductionJournal.open({
    operationRoot,
    ownerId: input.request.ownerId,
    resumeOwnerId: input.request.resumeOwnerId,
    runId: input.request.runId,
  });
  try {
    if (journal.resumePoint === 'FINALIZED') {
      return verifyFinalizedReplay(operationRoot, publicRoutePath);
    }
    const checkpoint = await readCheckpoint(operationRoot);
    const context: StrictExecutionContext = {
      input,
      authorization,
      checkpoint,
      dataRoot,
      projectRoot,
      operationRoot,
      publicRoutePath,
      journal,
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
}

async function verifyFinalizedReplay(
  operationRoot: string,
  publicRoutePath: string
): Promise<unknown> {
  const report = (await readJson(path.join(operationRoot, RUNTIME_REPORT_FILE))) as {
    publicHandle?: { routeHash?: unknown };
  };
  const currentRoute = await inspectPublicRoute(publicRoutePath);
  if (!currentRoute || currentRoute.hash !== report.publicHandle?.routeHash) {
    throw new Error('STRICT_FINALIZED_PUBLIC_ROUTE_DIVERGENCE');
  }
  return report;
}

async function prepareAuthorizedBlankState(context: StrictExecutionContext): Promise<void> {
  const { authorization, checkpoint, dataRoot, journal, operationRoot, publicRoutePath } = context;
  const database = context.input.container.get('database');
  await advance(journal, 'PC_F_ACCEPTED', {
    pcfBaselineReceiptHash: authorization.pcfBaselineReceiptHash,
  });
  await advance(journal, 'AUTHORIZED', { authorizationHash: authorization.authorizationHash });
  const observedPublicRoute = await inspectPublicRoute(publicRoutePath);
  const recoverablePreparedRouteHash = checkpoint.finalization
    ? hashCanonicalJson(checkpoint.finalization.preparedPublicRoute.route)
    : null;
  if (
    (observedPublicRoute?.hash ?? null) !== authorization.expectedPublicRouteHash &&
    (before(journal.resumePoint, 'SERVING_MANIFEST_READY') ||
      observedPublicRoute?.hash !== recoverablePreparedRouteHash)
  ) {
    throw new Error('STRICT_AUTHORIZATION_OBSERVED_POINTER_MISMATCH');
  }
  await advance(journal, 'JOURNAL_OPEN', {
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
    await advance(journal, 'BLANK', { resetReceiptHash: reset.receiptHash, blank: true });
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
  privateCorpus: StrictPrivateCorpusStage
): Promise<unknown> {
  let finalization = context.checkpoint.finalization;
  if (!finalization) {
    finalization = finalizeStrictCandidate({
      analysis,
      candidateCoverage,
      certifiedProjectFactsHash: facts.carrier.certificationBindingHash,
      committedAt: new Date().toISOString(),
      compiledPlan: planning.compiledPlan,
      expressionSets: analysis.expressionSets,
      planCognitionHash: planning.planCognitionHash,
      privateCorpus,
      runId: context.input.request.runId,
    });
    context.checkpoint.finalization = finalization;
    await writeCheckpoint(context.operationRoot, context.checkpoint);
  }
  await advance(context.journal, 'G4_READY', { g4ReceiptHash: finalization.g4ReceiptHash });
  await advance(context.journal, 'SERVING_RECONCILED', {
    candidateDataManifestHash: finalization.candidateDataManifestHash,
  });
  await advance(context.journal, 'FINAL_COVERAGE_BOUND', {
    finalCoverageBindingHash: finalization.finalCoverage.receiptHash,
  });
  await advance(context.journal, 'CANDIDATE_ORACLE_PASSED', {
    candidateOracleHash: finalization.candidateOracleHash,
  });
  await advance(context.journal, 'SERVING_MANIFEST_READY', {
    servingSnapshotManifestHash: finalization.servingManifest.manifestHash,
  });
  const route = await commitPreparedPublicRoute({
    expectedCurrentHash: context.authorization.expectedPublicRouteHash,
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
  });
  return report;
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
    publicHandle: {
      routeHash,
      snapshotId: finalization.servingManifest.snapshotId,
      servingSnapshotManifestHash: finalization.servingManifest.manifestHash,
    },
    candidateHandle: {
      revisionId: privateCorpus.revisionId,
      candidateDataManifestHash: finalization.candidateDataManifestHash,
      finalCoverageBindingHash: finalization.finalCoverage.receiptHash,
      vectorGenerationId: privateCorpus.vectorGenerationId,
      activeRecipeCount: privateCorpus.activeRecipeIds.length,
      g1ReceiptCount: privateCorpus.g1Receipts.length,
      candidateOracleHash: privateCorpus.candidateOracle.oracleHash,
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
  return (
    ((await readOptionalJson(
      path.join(operationRoot, CHECKPOINT_FILE)
    )) as StrictProductionCheckpointV1 | null) ?? { schemaVersion: 1 }
  );
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

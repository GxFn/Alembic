import {
  createFrozenEvidenceProjection,
  type FrozenEvidenceProjectionV1,
  type ReviewerIdentityV1,
} from '@alembic/agent/evaluation';
import {
  assertStrictTestDimensionAgentExecutionReceiptV1,
  bindStrictTestDimensionProductionRuntimePortV1,
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisEpochSnapshotV1,
  createStrictAnalysisExpansionPortV1,
  createStrictAnalysisFixpointV1,
  createStrictAnalysisGateOutcomeV1,
  createStrictProducerExpressionSetV1,
  createStrictProducerLineageReceiptV1,
  createStrictTestDimensionAgentAuthorityV1,
  createStrictTestDimensionAgentCellAnalysisEvidenceV1,
  createStrictTestDimensionAgentCellStageEvidenceV1,
  hashStrictTestDimensionAgentStageResultV1,
  type StrictAnalysisEpochSnapshotV1,
  type StrictAnalystEpochInputV1,
  type StrictAnalystEpochV1,
  type StrictProducerExpressionSetV1,
  type StrictProducerProposalV1,
  type StrictProductionRuntimePortV1,
  type StrictTestDimensionAgentAnalysisLineageV1,
  type StrictTestDimensionAgentAnalysisStageEvidenceV1,
  type StrictTestDimensionAgentCellDispositionInputV1,
  type StrictTestDimensionAgentExecutionReceiptV1,
  type StrictTestDimensionAgentReviewStageEvidenceV1,
  validateStrictAnalystEpochV1,
} from '@alembic/agent/production';
import type { AgentService } from '@alembic/agent/service';
import {
  assertCodeFactGenerationManifestV1,
  canonicalizeObservationPopulationV1,
  createFinalExpandedMiningScheduleReceiptV1,
  type FactRecordV1,
  type FinalExpandedMiningScheduleReceiptV1,
  type ObservationPopulationInputV1,
} from '@alembic/core/host-agent-workflows';
import type { CertifiedPlanningFactsV1, CompiledColdStartPlanV2 } from '@alembic/core/plans';
import {
  createAgentSemanticDispositionReviewRequestV1,
  createProductionActorIdentityV1,
  hashKnowledgeDispositionProposalV1,
  type StrictTestAutomaticSelectionReceiptV1,
  type StrictTestDimensionExecutionProjectionV1,
  type StrictTestPreflightBindingsV1,
  type StrictTestPreflightReceiptV1,
} from '@alembic/core/production';
import {
  type CertifiedProjectFactsArtifactV1,
  hashCanonicalJson,
} from '@alembic/core/project-context-foundation';
import type {
  MainCertifiedProjectionPayload,
  MainCertifiedSourceFile,
} from '../../../project-facts/CertifiedProjectFactsRuntime.js';
import type { StrictSemanticReviewSessionV1 } from '../../../service/semantic-review/StrictSemanticReviewRuntimeFactory.js';
import {
  createStrictSemanticReviewEvidenceV1,
  executeStrictDispositionReviewV5,
  type StrictSemanticReviewCheckpointPortV1,
} from './StrictDispositionReviewRuntime.js';
import {
  createMainStrictExpandedFactScheduleV1,
  createMainStrictExpansionRowV1,
  executeMainStrictFactScheduleV1,
  type MainStrictAnalysisExpansionRowV1,
  type MainStrictFactExecutionResultV1,
} from './StrictFactExecutionRuntime.js';

const STRICT_ANALYSIS_MAX_EPOCHS = 8;

export interface StrictAnalysisExecutionResultV1 {
  readonly expansionLedgerHeadHash: string;
  readonly facts: readonly FactRecordV1[];
  readonly factExecutionReceipts: MainStrictFactExecutionResultV1['receipts'];
  readonly factExecutionManifest: MainStrictFactExecutionResultV1['manifest'];
  readonly finalExpandedSchedule: FinalExpandedMiningScheduleReceiptV1;
  readonly epochs: readonly StrictAnalystEpochV1[];
  readonly epoch: StrictAnalystEpochV1;
  readonly fixpoint: ReturnType<typeof createStrictAnalysisFixpointV1>;
  readonly evidence: FrozenEvidenceProjectionV1;
  readonly expressionSets: readonly StrictProducerExpressionSetV1[];
  readonly agentRunId: string;
  readonly agentUsage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly iterations: number;
    readonly durationMs: number;
  };
  readonly strictTestExecutionReceipt?: StrictTestDimensionAgentExecutionReceiptV1;
}

export interface StrictAnalysisExecutionInput {
  readonly agentService: Pick<AgentService, 'run'>;
  readonly artifact: CertifiedProjectFactsArtifactV1;
  readonly certifiedPlanningFacts: CertifiedPlanningFactsV1;
  readonly compiledPlan: CompiledColdStartPlanV2;
  readonly journalId: string;
  readonly modelHash: string;
  readonly planCognitionHash: string;
  readonly projection: MainCertifiedProjectionPayload;
  readonly reviewer: {
    readonly calibrationReceiptHash: string;
    readonly identity: ReviewerIdentityV1;
  };
  readonly runId: string;
  readonly semanticReviewSession: StrictSemanticReviewSessionV1;
  readonly strictTest?: {
    readonly automaticSelection: StrictTestAutomaticSelectionReceiptV1;
    readonly clock: () => string;
    readonly currentBindings: StrictTestPreflightBindingsV1;
    readonly preflight: StrictTestPreflightReceiptV1;
    readonly projection: StrictTestDimensionExecutionProjectionV1;
    readonly semanticReviewCheckpoint: StrictSemanticReviewCheckpointPortV1;
  };
}

interface StrictAnalysisState {
  context: ReturnType<typeof createStrictAnalysisContextProjectionV1>;
  execution: MainStrictFactExecutionResultV1;
  schedule: CompiledColdStartPlanV2['schedule'];
  population: ReturnType<typeof canonicalizeObservationPopulationV1>;
  populations: ReturnType<typeof canonicalizeObservationPopulationV1>[];
  snapshot: StrictAnalysisEpochSnapshotV1;
  epochs: StrictAnalystEpochV1[];
  epoch: StrictAnalystEpochV1 | null;
  fixpoint: ReturnType<typeof createStrictAnalysisFixpointV1> | null;
  lineages: ReturnType<typeof createStrictProducerLineageReceiptV1>[];
  expressionSets: StrictProducerExpressionSetV1[];
  expressionSetByHypothesis: Map<string, StrictProducerExpressionSetV1>;
  producerReviewed: boolean;
  lastGateFailure: string | null;
  strictTestAnalysisStageEvidence: StrictTestDimensionAgentAnalysisStageEvidenceV1 | null;
  strictTestProducerStageResultHash: string | null;
  strictTestReviewStageEvidence: StrictTestDimensionAgentReviewStageEvidenceV1 | null;
}

interface StrictAnalystEnvelopeV1 {
  readonly epoch: StrictAnalystEpochInputV1;
  readonly expansions: readonly Omit<MainStrictAnalysisExpansionRowV1, 'obligationId'>[];
}

async function prepareStrictAnalysis(input: StrictAnalysisExecutionInput) {
  const evidenceEntries = input.semanticReviewSession.factEvidence.entries;
  if (evidenceEntries.length !== input.projection.files.length) {
    throw new Error('STRICT_ANALYSIS_EVIDENCE_LEDGER_COUNT_MISMATCH');
  }
  const evidence = createFrozenEvidenceProjection({
    sourceRevisionVectorHash: input.compiledPlan.execution.sourceRevisionVectorHash,
    entries: input.projection.files.map((file, index) => {
      const evidenceEntry = evidenceEntries[index];
      if (!evidenceEntry) {
        throw new Error(`STRICT_ANALYSIS_EVIDENCE_LEDGER_ENTRY_MISSING:${file.relativePath}`);
      }
      return toEvidenceEntry(file, evidenceEntry);
    }),
  });
  const execution = await executeMainStrictFactScheduleV1({
    artifact: input.artifact,
    certifiedPlanningFacts: input.certifiedPlanningFacts,
    projection: input.projection,
    schedule: input.compiledPlan.schedule,
    catalog: input.compiledPlan.factQueryCatalog,
    factEvidence: input.semanticReviewSession.factEvidence,
  });
  const population = canonicalizeObservationPopulationV1(
    buildPopulation(execution, input.compiledPlan, 1, null)
  );
  const expansionPort = createStrictAnalysisExpansionPortV1({
    baselineScheduleHash: input.compiledPlan.schedule.baselineScheduleHash,
    baselineObligationIds: input.compiledPlan.schedule.factHarvestObligations.map(
      (row) => row.obligationId
    ),
    knownFactFamilies: input.compiledPlan.factQueryCatalog.families,
    knownSubjectRefs: [
      ...new Set([
        ...input.certifiedPlanningFacts.modules.map((module) => module.scopeId),
        ...execution.facts.map((fact) => fact.canonicalSubjectRef),
      ]),
    ],
    obligationCap: input.compiledPlan.selection.resourceCaps.factQueryObligationCap,
  });
  const currentSchedule = previewExpandedSchedule(input, expansionPort.receipts);
  const context = createStrictAnalysisContextProjectionV1({
    runId: input.runId,
    journalId: input.journalId,
    manifestHash: execution.manifest.manifestHash,
    planCognitionHash: input.planCognitionHash,
    planHash: input.compiledPlan.canonicalPlanHash,
    // 生产 journal 保留既有 required-set 绑定；独立 strict-test 则必须与 Agent/Core
    // authority 的完整 applicability universe 逐字一致，避免 selected cell 偷换全量分母。
    requiredUniverseHash: input.strictTest
      ? input.compiledPlan.requiredFactApplicability.universeHash
      : input.compiledPlan.requiredFactApplicability.requiredHash,
    baselineScheduleHash: input.compiledPlan.schedule.baselineScheduleHash,
    expansionHeadHash: null,
    currentExpandedScheduleHash: currentSchedule.finalExpandedScheduleHash,
    finalExpandedScheduleHash: null,
    analysisFixpointHash: null,
    privateCorpusRevision: null,
    hypothesisExpressionSetHash: null,
    lensBindingsHash: input.compiledPlan.schedule.lensBindingsHash,
    sourceArtifactHash: input.compiledPlan.selection.sourceArtifactHash,
    sourceRevisionVectorHash: input.compiledPlan.execution.sourceRevisionVectorHash,
    questionIds: [
      ...new Set(
        input.compiledPlan.execution.orderedInvestigationActions.map((row) => row.questionId)
      ),
    ],
    factQueryObligationIds: currentSchedule.obligationIds,
    analysisUnitIds: input.compiledPlan.schedule.lensBindings.map((row) => row.bindingId),
    factIds: execution.facts.map((fact) => fact.factId),
    witnessIds: [...new Set(execution.facts.flatMap((fact) => fact.witnessIds))],
    populationHashes: [population.populationHash],
    clusterSetHashes: [],
    inductionReceiptHashes: [],
    hypothesisIds: [],
    falsificationReceiptHashes: [],
    dispositionReviewIds: [],
    evidenceEntryIds: evidence.entries.map((entry) => entry.evidenceEntryId),
    derivedFindingCount: 0,
  });
  const snapshot = createStrictAnalysisEpochSnapshotV1({
    epoch: 1,
    context,
    populations: [population],
    terminalObligationIds: execution.receipts.map((receipt) => receipt.obligationId),
    outstandingObligationIds: [],
  });
  return { evidence, execution, expansionPort, population, snapshot };
}

type PreparedStrictAnalysis = Awaited<ReturnType<typeof prepareStrictAnalysis>>;

function createStrictProductionRuntimePort(
  input: StrictAnalysisExecutionInput,
  prepared: PreparedStrictAnalysis,
  state: StrictAnalysisState
): StrictProductionRuntimePortV1 & {
  readonly eligibleCells?: ReturnType<typeof strictEligibleCells>;
  readonly eligibleSubjects?: readonly string[];
  readonly readAnalystAuthority?: () => {
    readonly executionReceipts: MainStrictFactExecutionResultV1['receipts'];
    readonly finalExpandedSchedule: FinalExpandedMiningScheduleReceiptV1;
    readonly terminalObligations: MainStrictFactExecutionResultV1['terminalObligations'];
  };
} {
  const eligibleCells = executionCells(input);
  const eligibleCellIds = new Set(eligibleCells.map((cell) => cell.cellId));
  // 现有 production Agent adapter 仍消费这三个宿主扩展字段；只有 strict-test 绑定必须保持
  // Agent canonical binder 规定的精确七键 runtime port，避免额外宿主字段进入 receipt authority。
  const productionCompatibility = input.strictTest
    ? {}
    : {
        eligibleCells,
        eligibleSubjects: strictEligibleSubjects(input.compiledPlan),
        readAnalystAuthority: () =>
          Object.freeze({
            executionReceipts: state.execution.receipts,
            finalExpandedSchedule: previewExpandedSchedule(input, prepared.expansionPort.receipts),
            terminalObligations: state.execution.terminalObligations,
          }),
      };
  return {
    ...productionCompatibility,
    enabled: true,
    analysisLimits: {
      maxEpochs: STRICT_ANALYSIS_MAX_EPOCHS,
      maxObligations: input.compiledPlan.selection.resourceCaps.factQueryObligationCap,
    },
    expansionPort: prepared.expansionPort,
    readAnalysisEpoch() {
      return state.snapshot;
    },
    buildProducerInput() {
      if (!state.epoch || !state.fixpoint) {
        throw new Error('STRICT_PRODUCER_FIXPOINT_REQUIRED');
      }
      const epoch = state.epoch;
      const analysisFixpoint = state.fixpoint;
      // Retry snapshots 保留 append-only population 历史；Producer lineage 只消费最终 epoch 的
      // Core authority 集，避免把历史 population 误当成当前 hypothesis 的并列来源。
      const producerContext = createStrictAnalysisContextProjectionV1({
        ...withoutContextIdentity(state.context),
        populationHashes: [epoch.population.populationHash],
        clusterSetHashes: [epoch.clusterSet.clusterSetHash],
        inductionReceiptHashes: epoch.inductions.map((receipt) => receipt.receiptHash),
        hypothesisIds: epoch.producerEligibleHypotheses.map((row) => row.hypothesisId),
        falsificationReceiptHashes: epoch.falsifications.map((receipt) => receipt.receiptHash),
        dispositionReviewIds: epoch.dispositionReviews.map((review) => review.reviewReceiptId),
      });
      state.lineages = epoch.producerEligibleHypotheses.map((hypothesis) =>
        createStrictProducerLineageReceiptV1({
          context: producerContext,
          epoch,
          analysisFixpoint,
          hypothesisId: hypothesis.hypothesisId,
          evidence: prepared.evidence,
        })
      );
      return Object.freeze({
        schemaVersion: 1,
        analysisFixpoint,
        evidence: prepared.evidence,
        lineages: state.lineages,
        cardinalityPolicy: 'zero-one-many-no-floor',
        semanticRepairLimit: 2,
      });
    },
    async validateAnalystResult(source, observedEpoch) {
      try {
        if (observedEpoch.snapshotHash !== state.snapshot.snapshotHash) {
          throw new Error('STRICT_ANALYSIS_GATE_EPOCH_MISMATCH');
        }
        const candidate = parseAnalystEnvelope(source);
        const validatedEpoch = validateStrictAnalystEpochV1({
          ...candidate.epoch,
          // population 与执行收据属于 Main/Core 权威，不接受模型回传的同名结构换绑。
          population: {
            ...state.population,
            executionReceipts: state.execution.receipts,
          },
          knownFactIds: state.execution.facts.map((fact) => fact.factId),
          enrolledObligationIds: state.schedule.factHarvestObligations.map(
            (row) => row.obligationId
          ),
        } as StrictAnalystEpochInputV1);
        state.epoch = validatedEpoch;
        if (candidate.expansions.length > 0) {
          return executeAnalysisExpansion(
            input,
            prepared,
            state,
            observedEpoch,
            candidate.expansions
          );
        }
        // 带 expansion 请求的中间 proposal 不具备最终 review context；只有 sealed schedule 上
        // 的终态 epoch 才进入 Core fixpoint receipt。
        state.epochs.push(validatedEpoch);
        return finalizeStrictAnalysisGate(input, prepared, state, observedEpoch, source);
      } catch (error: unknown) {
        state.lastGateFailure = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },
    reviewProducerResult(source) {
      return reviewStrictProducerResult(source, input, prepared, state, eligibleCellIds);
    },
  };
}

function strictEligibleCells(plan: CompiledColdStartPlanV2) {
  return plan.universe.cells
    .filter((cell) => cell.status === 'eligible')
    .map((cell) => ({
      cellId: cell.cellId,
      moduleId: cell.moduleId,
      dimensionId: cell.dimensionId,
    }));
}

function strictEligibleSubjects(plan: CompiledColdStartPlanV2): string[] {
  return [
    ...new Set(
      plan.schedule.factHarvestObligations.map((obligation) => obligation.canonicalSubjectRef)
    ),
  ];
}

function executionCells(input: StrictAnalysisExecutionInput) {
  const cells = strictEligibleCells(input.compiledPlan);
  if (!input.strictTest) {
    return cells;
  }
  const selected = new Set(input.strictTest.projection.executionCellIds);
  return cells.filter((cell) => selected.has(cell.cellId));
}

function finalizeStrictAnalysisGate(
  input: StrictAnalysisExecutionInput,
  prepared: PreparedStrictAnalysis,
  state: StrictAnalysisState,
  observedEpoch: StrictAnalysisEpochSnapshotV1,
  source: unknown
) {
  const finalSchedule = prepared.expansionPort.seal();
  state.fixpoint = createStrictAnalysisFixpointV1({
    finalExpandedSchedule: finalSchedule,
    terminalObligations: state.execution.terminalObligations,
    epochs: state.epochs,
  });
  state.context = createStrictAnalysisContextProjectionV1({
    ...withoutContextIdentity(state.context),
    currentExpandedScheduleHash: finalSchedule.finalExpandedScheduleHash,
    finalExpandedScheduleHash: finalSchedule.finalExpandedScheduleHash,
    analysisFixpointHash: state.fixpoint.fixpointHash,
    populationHashes: state.populations.map((population) => population.populationHash),
    clusterSetHashes: state.epochs.map((epoch) => epoch.clusterSet.clusterSetHash),
    inductionReceiptHashes: state.epochs.flatMap((epoch) =>
      epoch.inductions.map((receipt) => receipt.receiptHash)
    ),
    hypothesisIds: [
      ...new Set(
        state.epochs.flatMap((epoch) =>
          epoch.producerEligibleHypotheses.map((row) => row.hypothesisId)
        )
      ),
    ],
    // Context 是跨 epoch 的身份集合；epoch 本身仍完整保留重复出现的审查事实，
    // 但投影不能把同一 receipt/reviewer id 当成两个独立身份交给 Agent。
    falsificationReceiptHashes: [
      ...new Set(
        state.epochs.flatMap((epoch) => epoch.falsifications.map((receipt) => receipt.receiptHash))
      ),
    ],
    dispositionReviewIds: [
      ...new Set(
        state.epochs.flatMap((epoch) =>
          epoch.dispositionReviews.map((review) => review.reviewReceiptId)
        )
      ),
    ],
  });
  state.snapshot = createStrictAnalysisEpochSnapshotV1({
    epoch: observedEpoch.epoch,
    context: state.context,
    populations: state.populations,
    terminalObligationIds: state.execution.receipts.map((receipt) => receipt.obligationId),
    outstandingObligationIds: [],
  });
  const artifact = input.strictTest
    ? createStrictTestAnalysisStageEvidence(input, prepared, state, source)
    : state.fixpoint;
  if (input.strictTest) {
    state.strictTestAnalysisStageEvidence =
      artifact as StrictTestDimensionAgentAnalysisStageEvidenceV1;
  }
  return createStrictAnalysisGateOutcomeV1({
    action: 'pass',
    reasonCode: 'stable-analysis-fixpoint',
    observedEpochHash: observedEpoch.snapshotHash,
    artifact,
  });
}

async function executeAnalysisExpansion(
  input: StrictAnalysisExecutionInput,
  prepared: PreparedStrictAnalysis,
  state: StrictAnalysisState,
  observedEpoch: StrictAnalysisEpochSnapshotV1,
  requested: readonly Omit<MainStrictAnalysisExpansionRowV1, 'obligationId'>[]
) {
  if (observedEpoch.epoch >= STRICT_ANALYSIS_MAX_EPOCHS) {
    throw new Error('STRICT_ANALYSIS_EPOCH_LIMIT_REACHED');
  }
  const rows = requested.map((row) => createMainStrictExpansionRowV1(row));
  for (const row of rows) {
    prepared.expansionPort.enroll(row);
    prepared.expansionPort.assertExecutionAllowed(row.obligationId);
  }
  const allExpansionRows = prepared.expansionPort.receipts.flatMap((receipt) => receipt.rows);
  const schedule = createMainStrictExpandedFactScheduleV1(
    input.compiledPlan.schedule,
    allExpansionRows
  );
  const execution = await executeMainStrictFactScheduleV1({
    artifact: input.artifact,
    certifiedPlanningFacts: input.certifiedPlanningFacts,
    projection: input.projection,
    schedule,
    catalog: input.compiledPlan.factQueryCatalog,
    factEvidence: input.semanticReviewSession.factEvidence,
  });
  const population = canonicalizeObservationPopulationV1(
    buildPopulation(
      execution,
      input.compiledPlan,
      observedEpoch.epoch + 1,
      state.population.populationHash
    )
  );
  const currentSchedule = previewExpandedSchedule(input, prepared.expansionPort.receipts);
  state.execution = execution;
  state.schedule = schedule;
  state.population = population;
  state.populations.push(population);
  state.context = createStrictAnalysisContextProjectionV1({
    ...withoutContextIdentity(state.context),
    expansionHeadHash: prepared.expansionPort.receipts.at(-1)?.receiptHash ?? null,
    currentExpandedScheduleHash: currentSchedule.finalExpandedScheduleHash,
    factQueryObligationIds: schedule.factHarvestObligations.map((row) => row.obligationId),
    factIds: execution.facts.map((fact) => fact.factId),
    witnessIds: [...new Set(execution.facts.flatMap((fact) => fact.witnessIds))],
    populationHashes: state.populations.map((row) => row.populationHash),
  });
  state.snapshot = createStrictAnalysisEpochSnapshotV1({
    epoch: observedEpoch.epoch + 1,
    context: state.context,
    populations: state.populations,
    terminalObligationIds: execution.receipts.map((receipt) => receipt.obligationId),
    outstandingObligationIds: [],
  });
  return createStrictAnalysisGateOutcomeV1({
    action: 'analysis_retry',
    reasonCode: 'enrolled-expansion-executed',
    observedEpochHash: observedEpoch.snapshotHash,
    enrolledObligationIds: rows.map((row) => row.obligationId),
    executedObligationIds: rows.map((row) => row.obligationId),
    artifact: execution.manifest,
  });
}

function previewExpandedSchedule(
  input: StrictAnalysisExecutionInput,
  receipts: ReturnType<typeof createStrictAnalysisExpansionPortV1>['receipts']
) {
  return createFinalExpandedMiningScheduleReceiptV1({
    baselineScheduleHash: input.compiledPlan.schedule.baselineScheduleHash,
    baselineObligationIds: input.compiledPlan.schedule.factHarvestObligations.map(
      (row) => row.obligationId
    ),
    expansionReceipts: receipts,
  });
}

async function reviewStrictProducerResult(
  source: unknown,
  input: StrictAnalysisExecutionInput,
  prepared: PreparedStrictAnalysis,
  state: StrictAnalysisState,
  eligibleCellIds: ReadonlySet<string>
) {
  if (!state.fixpoint || !state.epoch) {
    throw new Error('STRICT_REVIEW_FIXPOINT_REQUIRED');
  }
  const output = parseProducerOutput(source);
  assertProducerEligibleCellScopes(output, eligibleCellIds);
  const byHypothesis = new Map(output.map((row) => [row.hypothesisId, row]));
  if (
    byHypothesis.size !== state.lineages.length ||
    state.lineages.some((lineage) => !byHypothesis.has(lineage.hypothesis.hypothesisId))
  ) {
    throw new Error('STRICT_PRODUCER_HYPOTHESIS_CONSERVATION_FAILED');
  }
  state.expressionSets = state.lineages.map((lineage) => {
    const row = byHypothesis.get(lineage.hypothesis.hypothesisId);
    if (!row) {
      throw new Error('STRICT_PRODUCER_HYPOTHESIS_CONSERVATION_FAILED');
    }
    return createStrictProducerExpressionSetV1({
      lineage,
      parentSet: state.expressionSetByHypothesis.get(lineage.hypothesis.hypothesisId) ?? null,
      proposals: row.proposals,
      zeroDisposition: row.zeroDisposition,
      modelHash: input.modelHash,
      reasonHash: hashCanonicalJson({ reason: 'initial-strict-authoring' }),
    });
  });
  for (const set of state.expressionSets) {
    state.expressionSetByHypothesis.set(set.hypothesis.hypothesisId, set);
  }
  state.context = createStrictAnalysisContextProjectionV1({
    ...withoutContextIdentity(state.context),
    hypothesisExpressionSetHash: hashCanonicalJson(state.expressionSets.map((set) => set.setHash)),
  });
  state.producerReviewed = true;
  if (input.strictTest) {
    return {
      pass: true as const,
      action: 'pass' as const,
      artifact: await createStrictTestReviewStageEvidence(input, prepared, state, source),
    };
  }
  return {
    pass: true as const,
    action: 'pass' as const,
    artifact: { expressionSets: state.expressionSets },
  };
}

export async function executeStrictAnalysisAndProduction(
  input: StrictAnalysisExecutionInput
): Promise<StrictAnalysisExecutionResultV1> {
  const prepared = await prepareStrictAnalysis(input);
  const state: StrictAnalysisState = {
    context: prepared.snapshot.context,
    execution: prepared.execution,
    schedule: input.compiledPlan.schedule,
    population: prepared.population,
    populations: [prepared.population],
    snapshot: prepared.snapshot,
    epochs: [],
    epoch: null,
    fixpoint: null,
    lineages: [],
    expressionSets: [],
    expressionSetByHypothesis: new Map(),
    producerReviewed: false,
    lastGateFailure: null,
    strictTestAnalysisStageEvidence: null,
    strictTestProducerStageResultHash: null,
    strictTestReviewStageEvidence: null,
  };
  const baseRuntimePort = createStrictProductionRuntimePort(input, prepared, state);
  const strictTestAuthority = input.strictTest
    ? createStrictTestDimensionAgentAuthorityV1({
        currentBindings: input.strictTest.currentBindings,
        preflight: input.strictTest.preflight,
        automaticSelection: input.strictTest.automaticSelection,
        projection: input.strictTest.projection,
        compiledPlan: input.compiledPlan,
      })
    : null;
  if (strictTestAuthority) {
    assertMainStrictTestRuntimeLineage(strictTestAuthority, state.snapshot.context);
  }
  const runtimePort = strictTestAuthority
    ? bindStrictTestDimensionProductionRuntimePortV1({
        authority: strictTestAuthority,
        runtimePort: baseRuntimePort,
        eligibleCells: executionCells(input),
      })
    : baseRuntimePort;
  const result = await input.agentService.run({
    profile: { id: 'generate-dimension' },
    params: { dimensionId: 'strict-production' },
    message: {
      role: 'internal',
      content:
        'Execute the strict Analyst and Producer stages. Return typed analysis epochs; include expansions when exploration or counterevidence is required.',
      metadata: { task: 'strict-production', runId: input.runId },
    },
    context: {
      source: 'system-workflow',
      runtimeSource: 'system',
      strategyContext: { strictProduction: runtimePort },
    },
    execution: { toolChoiceOverride: 'none' },
    presentation: { responseShape: 'system-task-result' },
  });
  const { epoch, fixpoint } = state;
  const finalExpandedSchedule = prepared.expansionPort.finalSchedule;
  if (
    result.status !== 'success' ||
    result.toolCalls.length > 0 ||
    !epoch ||
    !fixpoint ||
    !finalExpandedSchedule ||
    !state.producerReviewed
  ) {
    // strict-test 的 AgentService 会把 receipt 校验失败收敛为 error result；Main 必须保留
    // 该精确诊断，才能证明 drift 是在私有 corpus 写入前由同链 authority 门禁拒绝的。
    const failureDetail =
      state.lastGateFailure ??
      (strictTestAuthority && result.status !== 'success' ? result.reply : null);
    const failure = new Error(
      `STRICT_PRODUCTION_AGENT_FAILED:${result.status}${failureDetail ? `:${failureDetail}` : ''}`
    );
    if (strictTestAuthority && state.fixpoint) {
      Object.assign(failure, { failedStage: 'ANALYSIS_FIXPOINT_CLOSED' as const });
    }
    throw failure;
  }
  let strictTestExecutionReceipt: StrictTestDimensionAgentExecutionReceiptV1 | undefined;
  if (input.strictTest) {
    try {
      strictTestExecutionReceipt = requireStrictTestExecutionReceipt(
        result.strictTestExecutionReceipt,
        strictTestAuthority,
        state
      );
    } catch (error: unknown) {
      if (error instanceof Error) {
        Object.assign(error, { failedStage: 'ANALYSIS_FIXPOINT_CLOSED' as const });
      }
      throw error;
    }
  }
  const expansionLedgerHeadHash = resolveStrictExpansionLedgerHeadHashV1(finalExpandedSchedule);
  return Object.freeze({
    expansionLedgerHeadHash,
    facts: state.execution.facts,
    factExecutionReceipts: state.execution.receipts,
    factExecutionManifest: state.execution.manifest,
    finalExpandedSchedule,
    epochs: state.epochs,
    epoch,
    fixpoint,
    evidence: prepared.evidence,
    expressionSets: state.expressionSets,
    agentRunId: result.runId,
    agentUsage: result.usage,
    ...(strictTestExecutionReceipt ? { strictTestExecutionReceipt } : {}),
  });
}

function assertMainStrictTestRuntimeLineage(
  authority: ReturnType<typeof createStrictTestDimensionAgentAuthorityV1>,
  context: StrictAnalysisEpochSnapshotV1['context']
): void {
  const mismatches = [
    ['runId', context.runId, authority.runId],
    ['planCognitionHash', context.planCognitionHash, authority.planCognitionHash],
    ['planHash', context.planHash, authority.compiledPlanHash],
    ['requiredUniverseHash', context.requiredUniverseHash, authority.fullApplicabilityUniverseHash],
    ['baselineScheduleHash', context.baselineScheduleHash, authority.fullBaselineScheduleHash],
    [
      'lensBindingsHash',
      context.lensBindingsHash,
      authority.compiledPlan.schedule.lensBindingsHash,
    ],
    [
      'sourceArtifactHash',
      context.sourceArtifactHash,
      authority.certifiedProjectFactsSourceArtifactHash,
    ],
    [
      'sourceRevisionVectorHash',
      context.sourceRevisionVectorHash,
      authority.sourceRevisionVectorHash,
    ],
  ].filter(([, observed, expected]) => observed !== expected);
  if (mismatches.length > 0) {
    throw new Error(
      `STRICT_TEST_RUNTIME_AUTHORITY_LINEAGE_MISMATCH:${mismatches
        .map(([field]) => field)
        .join(',')}`
    );
  }
}

function strictTestAnalysisLineage(
  input: StrictAnalysisExecutionInput,
  prepared: PreparedStrictAnalysis,
  state: StrictAnalysisState
): StrictTestDimensionAgentAnalysisLineageV1 {
  if (!state.fixpoint || !prepared.expansionPort.finalSchedule) {
    throw new Error('STRICT_TEST_ANALYSIS_LINEAGE_NOT_READY');
  }
  return Object.freeze({
    baselineObligationIds: input.compiledPlan.schedule.factHarvestObligations.map(
      (row) => row.obligationId
    ),
    expansionReceipts: prepared.expansionPort.receipts,
    finalExpandedSchedule: prepared.expansionPort.finalSchedule,
    finalFactSchedule: state.schedule,
    analysisFixpoint: state.fixpoint,
    clusterSets: state.epochs.map((epoch) => epoch.clusterSet),
  });
}

function createStrictTestAnalysisStageEvidence(
  input: StrictAnalysisExecutionInput,
  prepared: PreparedStrictAnalysis,
  state: StrictAnalysisState,
  source: unknown
): StrictTestDimensionAgentAnalysisStageEvidenceV1 {
  if (!input.strictTest) {
    throw new Error('STRICT_TEST_ANALYSIS_AUTHORITY_REQUIRED');
  }
  const authority = createStrictTestDimensionAgentAuthorityV1({
    currentBindings: input.strictTest.currentBindings,
    preflight: input.strictTest.preflight,
    automaticSelection: input.strictTest.automaticSelection,
    projection: input.strictTest.projection,
    compiledPlan: input.compiledPlan,
  });
  const analysis = strictTestAnalysisLineage(input, prepared, state);
  const cells = executionCells(input).map((cell) =>
    createStrictTestDimensionAgentCellAnalysisEvidenceV1({
      cellId: cell.cellId,
      factReceiptHashes: state.execution.receipts
        .filter(
          (receipt) =>
            receipt.canonicalSubjectRef ===
            input.compiledPlan.universe.cells.find((candidate) => candidate.cellId === cell.cellId)
              ?.scopeId
        )
        .map((receipt) => receipt.receiptHash as `sha256:${string}`),
      analysis,
    })
  );
  const semantic = {
    kind: 'StrictTestDimensionAgentAnalysisStageEvidenceV1' as const,
    schemaVersion: 1 as const,
    runId: authority.runId,
    authorityHash: authority.authorityHash,
    selectedCellIds: authority.selectedCellIds,
    selectedCellSetHash: authority.selectedCellSetHash,
    analystStageResultHash: hashStrictTestDimensionAgentStageResultV1(source),
    factExecution: state.execution,
    analysis,
    cells,
  };
  return Object.freeze({
    ...semantic,
    analysisStageEvidenceHash: hashCanonicalJson(semantic) as `sha256:${string}`,
  });
}

async function createStrictTestReviewStageEvidence(
  input: StrictAnalysisExecutionInput,
  prepared: PreparedStrictAnalysis,
  state: StrictAnalysisState,
  source: unknown
): Promise<StrictTestDimensionAgentReviewStageEvidenceV1> {
  if (!input.strictTest || !state.strictTestAnalysisStageEvidence || !state.epoch) {
    throw new Error('STRICT_TEST_ANALYSIS_STAGE_EVIDENCE_REQUIRED');
  }
  const authority = createStrictTestDimensionAgentAuthorityV1({
    currentBindings: input.strictTest.currentBindings,
    preflight: input.strictTest.preflight,
    automaticSelection: input.strictTest.automaticSelection,
    projection: input.strictTest.projection,
    compiledPlan: input.compiledPlan,
  });
  const producerStageResultHash = hashStrictTestDimensionAgentStageResultV1(source);
  state.strictTestProducerStageResultHash = producerStageResultHash;
  const analysisByCell = new Map(
    state.strictTestAnalysisStageEvidence.cells.map((cell) => [cell.cellId, cell] as const)
  );
  const investigatedEmpty =
    state.expressionSets.length === 0 && state.epoch.population.observations.length === 0;
  const cellDispositions = await Promise.all(
    authority.selectedCellIds.map(async (cellId) => {
      const analysisCellEvidence = analysisByCell.get(cellId);
      if (!analysisCellEvidence) {
        throw new Error(`STRICT_TEST_ANALYSIS_CELL_EVIDENCE_MISSING:${cellId}`);
      }
      const emptyAttestation = investigatedEmpty
        ? await executeStrictTestInvestigatedEmptyReview(input, prepared, state, cellId)
        : null;
      // 有完整负证据时，G2 在同一 Agent pipeline 内先取得 durable review，再把 cell 关闭为
      // investigated-empty；其余无 attestation 的输出只能 rejected，绝不越权写入私有 corpus。
      const disposition: StrictTestDimensionAgentCellDispositionInputV1 = {
        cellId,
        disposition: emptyAttestation ? 'investigated-empty' : 'rejected',
        expressionSetReceipts: [],
        semanticReviewAttestations: [],
        dispositionReviewAttestations: emptyAttestation ? [emptyAttestation] : [],
        reasonCode: emptyAttestation ? null : 'strict-test-private-review-pending',
        evidenceRefs: analysisCellEvidence.analysisEvidenceRefs,
      };
      return {
        ...disposition,
        stageEvidence: createStrictTestDimensionAgentCellStageEvidenceV1({
          authority,
          analysisCellEvidence,
          producerStageResultHash,
          disposition,
        }),
      };
    })
  );
  const semantic = {
    kind: 'StrictTestDimensionAgentReviewStageEvidenceV1' as const,
    schemaVersion: 1 as const,
    runId: authority.runId,
    authorityHash: authority.authorityHash,
    selectedCellIds: authority.selectedCellIds,
    selectedCellSetHash: authority.selectedCellSetHash,
    analysisStageEvidenceHash: state.strictTestAnalysisStageEvidence.analysisStageEvidenceHash,
    producerStageResultHash,
    cellDispositions,
    expectedTrustPolicies: investigatedEmpty ? [input.semanticReviewSession.policy] : [],
    completedAt: input.strictTest.clock(),
  };
  const evidence = Object.freeze({
    ...semantic,
    reviewStageEvidenceHash: hashCanonicalJson(semantic) as `sha256:${string}`,
  });
  // Main 后续只能用同一个 G2 artifact 中冻结的 policy 与 receipt 对照，不能把
  // investigated-empty 所需的 durable trust authority 降成空数组。
  state.strictTestReviewStageEvidence = evidence;
  return evidence;
}

async function executeStrictTestInvestigatedEmptyReview(
  input: StrictAnalysisExecutionInput,
  prepared: PreparedStrictAnalysis,
  state: StrictAnalysisState,
  cellId: string
) {
  if (!input.strictTest || !state.fixpoint || !state.epoch) {
    throw new Error('STRICT_TEST_INVESTIGATED_EMPTY_AUTHORITY_REQUIRED');
  }
  const finalExpandedSchedule = prepared.expansionPort.finalSchedule;
  if (!finalExpandedSchedule) {
    throw new Error('STRICT_TEST_INVESTIGATED_EMPTY_SCHEDULE_REQUIRED');
  }
  const executionReceipts = [...state.execution.receipts].sort((left, right) =>
    left.obligationId.localeCompare(right.obligationId)
  );
  const evidenceEntryIds = prepared.evidence.entries.map((entry) => entry.evidenceEntryId);
  const proposal = {
    reviewKind: 'investigated-empty' as const,
    populationHash: state.epoch.population.populationHash,
    sourceRevisionVectorHash: input.compiledPlan.execution.sourceRevisionVectorHash,
    finalExpandedScheduleHash: finalExpandedSchedule.finalExpandedScheduleHash,
    currentAnalysisFixpointHash: state.fixpoint.fixpointHash,
    expectedObligationIds: [...finalExpandedSchedule.obligationIds],
    executionBindings: executionReceipts.map((receipt) => ({
      obligationId: receipt.obligationId,
      executionReceiptHash: receipt.receiptHash,
      executionOutputHash: receipt.outputHash,
      denominatorHash: receipt.denominatorHash,
      disposition: receipt.disposition,
      terminalReceiptId: receipt.terminalReceiptId,
    })),
    evidenceEntryIds,
  };
  const proposedDispositionHash = hashKnowledgeDispositionProposalV1(proposal);
  const producer = createProductionActorIdentityV1({
    providerId: 'alembic-agent',
    modelId: input.modelHash,
    modelVersion: 'strict-test-dimension-v1',
    promptHash: hashCanonicalJson({
      kind: 'strict-test-investigated-empty-v1',
      cellId,
      analysisFixpointHash: state.fixpoint.fixpointHash,
    }),
    runId: input.runId,
    invocationId: `strict-test-investigated-empty:${input.runId}:${cellId}`,
    loadReceiptHash: input.modelHash,
    outputHash: proposedDispositionHash,
  });
  const semanticRequest = createAgentSemanticDispositionReviewRequestV1({
    strictWorkflowRunId: input.runId,
    sourceRevisionVectorHash: prepared.evidence.sourceRevisionVectorHash,
    currentAnalysisFixpointHash: state.fixpoint.fixpointHash,
    populationHash: state.epoch.population.populationHash,
    proposedDispositionHash,
    finalExpandedSchedule,
    executionReceipts,
    evidence: createStrictSemanticReviewEvidenceV1({
      evidenceEntryIds,
      executionReceipts,
      session: input.semanticReviewSession,
      sourceRevisionVectorHash: prepared.evidence.sourceRevisionVectorHash,
      semanticRole: 'investigated-empty-complete-denominator',
    }),
    calibration: input.semanticReviewSession.calibration('investigated-empty'),
    producer,
    context: {
      reviewKind: 'investigated-empty',
      analysisFixpoint: state.fixpoint,
      population: state.epoch.population,
      proposal,
      negativeEvidenceSufficiency: {
        claim: `Selected strict-test cell ${cellId} has no content-ready candidate.`,
        requiredAbsencePredicates: [
          'no-content-ready-binding',
          'no-unresolved-hypothesis-or-suppressed-expression',
        ],
        inspectedEvidenceEntryIds: evidenceEntryIds,
        reasonCode: 'COMPLETE_STRICT_DENOMINATOR_INSPECTED',
      },
    },
  });
  const reviewed = await executeStrictDispositionReviewV5({
    checkpoint: input.strictTest.semanticReviewCheckpoint,
    semanticRequest,
    session: input.semanticReviewSession,
  });
  if (reviewed.dispositionReview.verdict !== 'pass') {
    throw new Error(`STRICT_TEST_INVESTIGATED_EMPTY_REJECTED:${cellId}`);
  }
  return reviewed.attestation;
}

function requireStrictTestExecutionReceipt(
  receipt: StrictTestDimensionAgentExecutionReceiptV1 | undefined,
  authority: ReturnType<typeof createStrictTestDimensionAgentAuthorityV1> | null,
  state: StrictAnalysisState
): StrictTestDimensionAgentExecutionReceiptV1 {
  if (!receipt || !authority || !state.strictTestAnalysisStageEvidence) {
    throw new Error('STRICT_TEST_AGENT_EXECUTION_RECEIPT_REQUIRED');
  }
  const reviewStage = state.strictTestReviewStageEvidence;
  if (!reviewStage) {
    throw new Error('STRICT_TEST_AGENT_REVIEW_STAGE_EVIDENCE_REQUIRED');
  }
  assertStrictTestDimensionAgentExecutionReceiptV1(receipt, reviewStage.expectedTrustPolicies);
  const authorityFields = [
    'demandKey',
    'runId',
    'authorityHash',
    'currentBindingsHash',
    'preflightHash',
    'bindingHash',
    'driftInvalidationHash',
    'automaticSelectionHash',
    'projectionHash',
    'compiledPlanHash',
    'planCognitionHash',
    'fullCatalogHash',
    'fullCatalogSourceArtifactHash',
    'fullCellUniverseHash',
    'fullEligibleCellsHash',
    'fullExcludedCellsHash',
    'fullApplicabilityUniverseHash',
    'fullFactQueryCatalogHash',
    'fullBaselineScheduleHash',
    'selectedDimensionId',
    'selectedCellSetHash',
  ] as const;
  const authorityDrift = authorityFields.filter((field) => receipt[field] !== authority[field]);
  if (
    receipt.segmentStatus !== 'completed' ||
    authorityDrift.length > 0 ||
    hashCanonicalJson(receipt.authority) !== hashCanonicalJson(authority) ||
    receipt.factExecutionManifestHash !== state.execution.manifest.manifestHash ||
    receipt.factHarvestScheduleHash !== state.schedule.factHarvestScheduleHash ||
    receipt.finalExpandedScheduleHash !== state.fixpoint?.finalExpandedScheduleHash ||
    receipt.analysisFixpointHash !== state.fixpoint?.fixpointHash ||
    receipt.pipelineExecution?.analysisStageEvidence.analysisStageEvidenceHash !==
      state.strictTestAnalysisStageEvidence.analysisStageEvidenceHash ||
    receipt.pipelineExecution?.reviewStageEvidence.reviewStageEvidenceHash !==
      reviewStage.reviewStageEvidenceHash ||
    receipt.pipelineExecution?.reviewStageEvidence.producerStageResultHash !==
      state.strictTestProducerStageResultHash ||
    hashCanonicalJson(receipt.selectedCellIds) !== hashCanonicalJson(authority.selectedCellIds)
  ) {
    throw new Error('STRICT_TEST_AGENT_EXECUTION_RECEIPT_LINEAGE_MISMATCH');
  }
  return receipt;
}

export function resolveStrictExpansionLedgerHeadHashV1(
  finalExpandedSchedule: FinalExpandedMiningScheduleReceiptV1
): string {
  const { finalExpandedScheduleHash, ...semantic } = finalExpandedSchedule;
  if (
    finalExpandedSchedule.schemaVersion !== 1 ||
    hashCanonicalJson(semantic) !== finalExpandedScheduleHash
  ) {
    throw new Error('STRICT_FINAL_EXPANDED_SCHEDULE_INVALID');
  }
  // Core 的 sealed receipt 是 ledger 身份的唯一来源：有扩展时取最后一个 receipt，
  // 无扩展时以 Core receipt 中规范化的空 receipt-hash 集合生成基准身份。
  return (
    finalExpandedSchedule.expansionReceiptHashes.at(-1) ??
    hashCanonicalJson(finalExpandedSchedule.expansionReceiptHashes)
  );
}

export function resolveStrictAnalysisPublicLineageV1(input: {
  readonly analysis: StrictAnalysisExecutionResultV1;
  readonly baselineScheduleHash: string;
}): {
  readonly expansionLedgerHeadHash: string;
  readonly finalCodeFactGenerationManifestHash: string;
  readonly finalExpandedScheduleHash: string;
} {
  const finalExpandedSchedule = input.analysis.finalExpandedSchedule;
  if (!finalExpandedSchedule) {
    throw new Error('STRICT_ANALYSIS_PUBLIC_LINEAGE_MISSING');
  }
  const expansionLedgerHeadHash = resolveStrictExpansionLedgerHeadHashV1(finalExpandedSchedule);
  if (
    finalExpandedSchedule.baselineScheduleHash !== input.baselineScheduleHash ||
    finalExpandedSchedule.finalExpandedScheduleHash !==
      input.analysis.fixpoint.finalExpandedScheduleHash ||
    expansionLedgerHeadHash !== input.analysis.expansionLedgerHeadHash ||
    hashCanonicalJson(finalExpandedSchedule.obligationIds) !==
      hashCanonicalJson(
        input.analysis.factExecutionReceipts.map((receipt) => receipt.obligationId).sort()
      )
  ) {
    throw new Error('STRICT_ANALYSIS_PUBLIC_LINEAGE_DIVERGENCE');
  }
  try {
    assertCodeFactGenerationManifestV1({
      facts: input.analysis.facts,
      receipts: input.analysis.factExecutionReceipts,
      manifest: input.analysis.factExecutionManifest,
    });
  } catch (error: unknown) {
    throw new Error('STRICT_ANALYSIS_FACT_MANIFEST_LINEAGE_INVALID', { cause: error });
  }
  return Object.freeze({
    expansionLedgerHeadHash: input.analysis.expansionLedgerHeadHash,
    finalExpandedScheduleHash: finalExpandedSchedule.finalExpandedScheduleHash,
    finalCodeFactGenerationManifestHash: input.analysis.factExecutionManifest.manifestHash,
  });
}

function assertProducerEligibleCellScopes(
  output: readonly {
    readonly proposals: readonly StrictProducerExpressionSetV1['proposals'][number][];
  }[],
  eligibleCellIds: ReadonlySet<string>
): void {
  for (const row of output) {
    for (const proposal of row.proposals) {
      if (
        proposal.authored.scope.moduleIds.length !== 1 ||
        proposal.authored.scope.dimensionIds.length !== 1
      ) {
        throw new Error('STRICT_PRODUCER_CELL_SCOPE_CARDINALITY_INVALID');
      }
      const cellId = `${proposal.authored.scope.moduleIds[0]}::${proposal.authored.scope.dimensionIds[0]}`;
      if (!eligibleCellIds.has(cellId)) {
        throw new Error(`STRICT_PRODUCER_CELL_SCOPE_INELIGIBLE:${cellId}`);
      }
    }
  }
}

function buildPopulation(
  execution: MainStrictFactExecutionResultV1,
  plan: CompiledColdStartPlanV2,
  revision: number,
  parentPopulationHash: string | null
): ObservationPopulationInputV1 {
  const receiptByFactId = new Map(
    execution.receipts.flatMap((receipt) =>
      receipt.emittedFactIds.map((factId) => [factId, receipt] as const)
    )
  );
  const observations = execution.facts.map((fact) => {
    const receipt = receiptByFactId.get(fact.factId);
    if (!receipt) {
      throw new Error(`STRICT_POPULATION_FACT_EXECUTION_RECEIPT_MISSING:${fact.factId}`);
    }
    return {
      observationId: `observation:${fact.factId.slice(-32)}`,
      factIds: [fact.factId],
      obligationIds: [receipt.obligationId],
      mechanismKey: `${fact.factFamilyId}:${fact.canonicalSubjectRef}`,
      canonicalSubjectRefs: [fact.canonicalSubjectRef],
      parentSubjectRefs: [],
      variantKeys: [fact.primaryScale],
      outlierReasonCodes: [],
      negativeControl: false,
    };
  });
  const inspectedNoPatternObservations = execution.receipts
    .filter((receipt) => receipt.disposition === 'inspected-no-pattern')
    .map((receipt) => ({
      observationId: `observation:no-pattern:${receipt.obligationId.slice(-32)}`,
      obligationId: receipt.obligationId,
      canonicalSubjectRef: receipt.canonicalSubjectRef,
      parentSubjectRefs: [],
      executionReceiptHash: receipt.receiptHash,
      outputHash: receipt.outputHash,
      denominatorHash: receipt.denominatorHash,
    }));
  return {
    populationId: `population:${plan.schedule.baselineScheduleHash.slice(-32)}`,
    revision,
    parentPopulationHash,
    sourceRevisionVectorHash: plan.execution.sourceRevisionVectorHash,
    denominator: {
      kind: 'frozen-complete-subjects',
      expectedObservationIds: [
        ...observations.map((row) => row.observationId),
        ...inspectedNoPatternObservations.map((row) => row.observationId),
      ],
      expectedObligationIds: execution.receipts.map((receipt) => receipt.obligationId),
      executionReceiptHashes: [
        ...new Set(execution.receipts.map((receipt) => receipt.receiptHash)),
      ],
      outputHashes: [...new Set(execution.receipts.map((receipt) => receipt.outputHash))],
      denominatorHashes: [...new Set(execution.receipts.map((receipt) => receipt.denominatorHash))],
      complete: true,
      truncated: false,
      continuation: null,
      omittedObservationIds: [],
    },
    executionReceipts: execution.receipts,
    observations,
    duplicateObservations: [],
    excludedObservations: [],
    errorObservations: [],
    inspectedNoPatternObservations,
  };
}

function toEvidenceEntry(
  file: MainCertifiedSourceFile,
  evidenceEntry: StrictSemanticReviewSessionV1['factEvidence']['entries'][number]
) {
  const content = Buffer.from(file.contentBase64, 'base64').toString('utf8');
  if (
    evidenceEntry.file !== file.relativePath ||
    evidenceEntry.content !== content ||
    evidenceEntry.contentHash !== `sha256:${hashText(content)}`
  ) {
    throw new Error(`STRICT_ANALYSIS_EVIDENCE_LEDGER_REBOUND:${file.relativePath}`);
  }
  return {
    evidenceEntryId: evidenceEntry.id,
    relativePath: file.relativePath,
    blobHash: file.blobHash,
    contentHash: evidenceEntry.contentHash.slice(7),
    startLine: 1,
    endLine: Math.max(1, content.split('\n').length),
    content,
  };
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseAnalystEnvelope(source: unknown): StrictAnalystEnvelopeV1 {
  const value = parseStageJson(source, 'STRICT_ANALYST_OUTPUT_INVALID');
  const epoch =
    value.epoch && typeof value.epoch === 'object'
      ? (value.epoch as StrictAnalystEpochInputV1)
      : (value as unknown as StrictAnalystEpochInputV1);
  const expansions = Array.isArray(value.expansions) ? value.expansions.map(parseExpansion) : [];
  return { epoch, expansions };
}

function parseExpansion(value: unknown): Omit<MainStrictAnalysisExpansionRowV1, 'obligationId'> {
  const row = asRecord(value, 'STRICT_ANALYSIS_EXPANSION_INVALID');
  if (
    !['exploration', 'counterexample'].includes(String(row.purpose)) ||
    !['source-range', 'symbol', 'file', 'module', 'package', 'repository', 'project'].includes(
      String(row.analysisScale)
    ) ||
    !['factFamilyId', 'capabilityId', 'canonicalSubjectRef', 'reasonCode'].every(
      (field) => typeof row[field] === 'string' && String(row[field]).trim().length > 0
    )
  ) {
    throw new Error('STRICT_ANALYSIS_EXPANSION_INVALID');
  }
  return {
    purpose: row.purpose as 'exploration' | 'counterexample',
    factFamilyId: String(row.factFamilyId),
    capabilityId: String(row.capabilityId),
    canonicalSubjectRef: String(row.canonicalSubjectRef),
    analysisScale: row.analysisScale as MainStrictAnalysisExpansionRowV1['analysisScale'],
    reasonCode: String(row.reasonCode),
  };
}

function parseStageJson(value: unknown, code: string): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    // PipelineStrategy 的 gate 接收真实 StageResult（strict-test 下还是 seal 内的不可变
    // snapshot），业务 JSON 位于 reply；仅当完整 stage envelope 特征存在时解包，避免把
    // 普通含 reply 字段的领域对象误判为 transport。
    if (
      typeof record.reply === 'string' &&
      Array.isArray(record.toolCalls) &&
      record.tokenUsage &&
      typeof record.tokenUsage === 'object' &&
      typeof record.iterations === 'number'
    ) {
      return parseStageJson(record.reply, code);
    }
    return record;
  }
  if (typeof value !== 'string') {
    throw new Error(code);
  }
  const match = value.match(/\{[\s\S]*\}/u);
  if (!match) {
    throw new Error(code);
  }
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    throw new Error(code);
  }
}

function parseProducerOutput(source: unknown): Array<{
  hypothesisId: string;
  proposals: readonly StrictProducerProposalV1[];
  zeroDisposition: StrictProducerExpressionSetV1['zeroDisposition'];
}> {
  const value = parseStageJson(source, 'STRICT_PRODUCER_OUTPUT_INVALID');
  const rows = Array.isArray(value.expressionSets) ? value.expressionSets : [];
  return rows.map((raw) => {
    const row = asRecord(raw, 'STRICT_PRODUCER_OUTPUT_INVALID');
    if (typeof row.hypothesisId !== 'string' || !Array.isArray(row.proposals)) {
      throw new Error('STRICT_PRODUCER_OUTPUT_INVALID');
    }
    return {
      hypothesisId: row.hypothesisId,
      proposals: row.proposals as StrictProducerProposalV1[],
      zeroDisposition:
        row.zeroDisposition && typeof row.zeroDisposition === 'object'
          ? (row.zeroDisposition as StrictProducerExpressionSetV1['zeroDisposition'])
          : null,
    };
  });
}

function asRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(code);
  }
  return value as Record<string, unknown>;
}

function withoutContextIdentity(
  context: ReturnType<typeof createStrictAnalysisContextProjectionV1>
) {
  const { schemaVersion: _schemaVersion, contextHash: _contextHash, ...input } = context;
  return input;
}

import { createHash } from 'node:crypto';

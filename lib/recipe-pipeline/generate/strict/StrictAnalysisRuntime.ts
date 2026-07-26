import { createHash } from 'node:crypto';
import {
  createFrozenEvidenceProjection,
  type FrozenEvidenceProjectionV1,
  type ReviewerIdentityV1,
} from '@alembic/agent/evaluation';
import {
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisEpochSnapshotV1,
  createStrictAnalysisExpansionPortV1,
  createStrictAnalysisFixpointV1,
  createStrictAnalysisGateOutcomeV1,
  createStrictProducerExpressionSetV1,
  createStrictProducerLineageReceiptV1,
  type StrictAnalysisEpochSnapshotV1,
  type StrictAnalystEpochInputV1,
  type StrictAnalystEpochV1,
  type StrictProducerExpressionSetV1,
  type StrictProducerProposalV1,
  type StrictProductionRuntimePortV1,
  validateStrictAnalystEpochV1,
} from '@alembic/agent/production';
import type { AgentService } from '@alembic/agent/service';
import {
  canonicalizeObservationPopulationV1,
  createFinalExpandedMiningScheduleReceiptV1,
  type FactRecordV1,
  type ObservationPopulationInputV1,
} from '@alembic/core/host-agent-workflows';
import type { CertifiedPlanningFactsV1, CompiledColdStartPlanV2 } from '@alembic/core/plans';
import {
  type CertifiedProjectFactsArtifactV1,
  hashCanonicalJson,
} from '@alembic/core/project-context-foundation';
import type {
  MainCertifiedProjectionPayload,
  MainCertifiedSourceFile,
} from '../../../project-facts/CertifiedProjectFactsRuntime.js';
import {
  createMainStrictExpandedFactScheduleV1,
  createMainStrictExpansionRowV1,
  executeMainStrictFactScheduleV1,
  type MainStrictAnalysisExpansionRowV1,
  type MainStrictFactExecutionResultV1,
} from './StrictFactExecutionRuntime.js';

const STRICT_ANALYSIS_MAX_EPOCHS = 8;

export interface StrictAnalysisExecutionResultV1 {
  readonly facts: readonly FactRecordV1[];
  readonly factExecutionReceipts: MainStrictFactExecutionResultV1['receipts'];
  readonly factExecutionManifest: MainStrictFactExecutionResultV1['manifest'];
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
}

interface StrictAnalysisExecutionInput {
  readonly agentService: Pick<AgentService, 'run'>;
  readonly artifact: CertifiedProjectFactsArtifactV1;
  readonly certifiedPlanningFacts: CertifiedPlanningFactsV1;
  readonly compiledPlan: CompiledColdStartPlanV2;
  readonly journalId: string;
  readonly modelHash: string;
  readonly planCognitionHash: string;
  readonly projection: MainCertifiedProjectionPayload;
  readonly projectRoot: string;
  readonly reviewer: {
    readonly calibrationReceiptHash: string;
    readonly identity: ReviewerIdentityV1;
  };
  readonly runId: string;
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
}

interface StrictAnalystEnvelopeV1 {
  readonly epoch: StrictAnalystEpochInputV1;
  readonly expansions: readonly Omit<MainStrictAnalysisExpansionRowV1, 'obligationId'>[];
}

async function prepareStrictAnalysis(input: StrictAnalysisExecutionInput) {
  const evidenceEntryIds = new Map(
    input.projection.files.map((file, index) => [file, `E-${index + 1}`] as const)
  );
  const evidence = createFrozenEvidenceProjection({
    sourceRevisionVectorHash: input.compiledPlan.execution.sourceRevisionVectorHash,
    entries: input.projection.files.map((file) =>
      toEvidenceEntry(file, requireEvidenceEntryId(evidenceEntryIds, file))
    ),
  });
  const execution = await executeMainStrictFactScheduleV1({
    artifact: input.artifact,
    certifiedPlanningFacts: input.certifiedPlanningFacts,
    projection: input.projection,
    projectRoot: input.projectRoot,
    schedule: input.compiledPlan.schedule,
    catalog: input.compiledPlan.factQueryCatalog,
    evidenceSessionId: input.runId,
  });
  const population = canonicalizeObservationPopulationV1(
    buildPopulation(execution.facts, input.compiledPlan, 1, null)
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
    requiredUniverseHash: input.compiledPlan.requiredFactApplicability.requiredHash,
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
  readonly eligibleCells: readonly {
    readonly cellId: string;
    readonly moduleId: string;
    readonly dimensionId: string;
  }[];
  readonly eligibleSubjects: readonly string[];
} {
  const eligibleCells = strictEligibleCells(input.compiledPlan);
  const eligibleCellIds = new Set(eligibleCells.map((cell) => cell.cellId));
  return {
    enabled: true,
    analysisLimits: {
      maxEpochs: STRICT_ANALYSIS_MAX_EPOCHS,
      maxObligations: input.compiledPlan.selection.resourceCaps.factQueryObligationCap,
    },
    expansionPort: prepared.expansionPort,
    eligibleCells,
    eligibleSubjects: strictEligibleSubjects(input.compiledPlan),
    readAnalysisEpoch() {
      return state.snapshot;
    },
    buildProducerInput() {
      if (!state.epoch || !state.fixpoint) {
        throw new Error('STRICT_PRODUCER_FIXPOINT_REQUIRED');
      }
      const epoch = state.epoch;
      const analysisFixpoint = state.fixpoint;
      state.lineages = epoch.producerEligibleHypotheses.map((hypothesis) =>
        createStrictProducerLineageReceiptV1({
          context: state.context,
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
      if (observedEpoch.snapshotHash !== state.snapshot.snapshotHash) {
        throw new Error('STRICT_ANALYSIS_GATE_EPOCH_MISMATCH');
      }
      const candidate = parseAnalystEnvelope(source);
      const validatedEpoch = validateStrictAnalystEpochV1({
        ...candidate.epoch,
        knownFactIds: state.execution.facts.map((fact) => fact.factId),
        enrolledObligationIds: state.schedule.factHarvestObligations.map((row) => row.obligationId),
      } as StrictAnalystEpochInputV1);
      state.epoch = validatedEpoch;
      state.epochs.push(validatedEpoch);
      if (candidate.expansions.length > 0) {
        return executeAnalysisExpansion(
          input,
          prepared,
          state,
          observedEpoch,
          candidate.expansions
        );
      }
      return finalizeStrictAnalysisGate(prepared, state, observedEpoch);
    },
    reviewProducerResult(source) {
      return reviewStrictProducerResult(source, input, state, eligibleCellIds);
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

function finalizeStrictAnalysisGate(
  prepared: PreparedStrictAnalysis,
  state: StrictAnalysisState,
  observedEpoch: StrictAnalysisEpochSnapshotV1
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
          epoch.hypothesisDispositions.map((row) => row.reviewerReceiptId)
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
  return createStrictAnalysisGateOutcomeV1({
    action: 'pass',
    reasonCode: 'stable-analysis-fixpoint',
    observedEpochHash: observedEpoch.snapshotHash,
    artifact: state.fixpoint,
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
    projectRoot: input.projectRoot,
    schedule,
    catalog: input.compiledPlan.factQueryCatalog,
    evidenceSessionId: input.runId,
  });
  const population = canonicalizeObservationPopulationV1(
    buildPopulation(
      execution.facts,
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

function reviewStrictProducerResult(
  source: unknown,
  input: StrictAnalysisExecutionInput,
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
  return {
    pass: true as const,
    action: 'continue' as const,
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
  };
  const runtimePort = createStrictProductionRuntimePort(input, prepared, state);
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
  if (
    result.status !== 'success' ||
    result.toolCalls.length > 0 ||
    !epoch ||
    !fixpoint ||
    !state.producerReviewed
  ) {
    throw new Error(`STRICT_PRODUCTION_AGENT_FAILED:${result.status}`);
  }
  return Object.freeze({
    facts: state.execution.facts,
    factExecutionReceipts: state.execution.receipts,
    factExecutionManifest: state.execution.manifest,
    epochs: state.epochs,
    epoch,
    fixpoint,
    evidence: prepared.evidence,
    expressionSets: state.expressionSets,
    agentRunId: result.runId,
    agentUsage: result.usage,
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
  facts: readonly FactRecordV1[],
  plan: CompiledColdStartPlanV2,
  revision: number,
  parentPopulationHash: string | null
): ObservationPopulationInputV1 {
  const observations = facts.map((fact) => ({
    observationId: `observation:${fact.factId.slice(-32)}`,
    factIds: [fact.factId],
    mechanismKey: `${fact.factFamilyId}:${fact.canonicalSubjectRef}`,
    canonicalSubjectRefs: [fact.canonicalSubjectRef],
  }));
  return {
    populationId: `population:${plan.schedule.baselineScheduleHash.slice(-32)}`,
    revision,
    parentPopulationHash,
    sourceRevisionVectorHash: plan.execution.sourceRevisionVectorHash,
    denominator: {
      kind: 'frozen-complete-subjects',
      expectedObservationIds: observations.map((row) => row.observationId),
    },
    observations,
    duplicateObservations: [],
    excludedObservations: [],
    errorObservations: [],
  };
}

function toEvidenceEntry(file: MainCertifiedSourceFile, evidenceEntryId: string) {
  const content = Buffer.from(file.contentBase64, 'base64').toString('utf8');
  return {
    evidenceEntryId,
    relativePath: file.relativePath,
    blobHash: file.blobHash,
    contentHash: hashText(content),
    startLine: 1,
    endLine: Math.max(1, content.split('\n').length),
    content,
  };
}

function requireEvidenceEntryId(
  evidenceEntryIds: ReadonlyMap<MainCertifiedSourceFile, string>,
  file: MainCertifiedSourceFile
): string {
  const evidenceEntryId = evidenceEntryIds.get(file);
  if (!evidenceEntryId) {
    throw new Error('STRICT_EVIDENCE_ENTRY_ID_MISSING');
  }
  return evidenceEntryId;
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
    return value as Record<string, unknown>;
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

import { createHash } from 'node:crypto';
import {
  createFrozenEvidenceProjection,
  type IndependentReviewDecisionV1,
  IndependentValueReviewer,
  type ReviewerIdentityV1,
} from '@alembic/agent/evaluation';
import {
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisExpansionPortV1,
  createStrictAnalysisFixpointV1,
  createStrictProducerExpressionSetV1,
  createStrictProducerLineageReceiptV1,
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
  createFactRecordV1,
  type FactRecordV1,
  type ObservationPopulationInputV1,
  validateFactRecordGraphV1,
} from '@alembic/core/host-agent-workflows';
import type { CompiledColdStartPlanV2 } from '@alembic/core/plans';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import type {
  MainCertifiedProjectionPayload,
  MainCertifiedSourceFile,
} from '../../../project-facts/CertifiedProjectFactsRuntime.js';
import { qualifyMainCertifiedPath } from '../../../project-facts/CertifiedProjectFactsRuntime.js';

export interface StrictAnalysisExecutionResultV1 {
  readonly facts: readonly FactRecordV1[];
  readonly epoch: StrictAnalystEpochV1;
  readonly fixpoint: ReturnType<typeof createStrictAnalysisFixpointV1>;
  readonly expressionSets: readonly StrictProducerExpressionSetV1[];
  readonly independentReviews: readonly IndependentReviewDecisionV1[];
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
}

interface StrictAnalysisState {
  context: ReturnType<typeof createStrictAnalysisContextProjectionV1>;
  epoch: StrictAnalystEpochV1 | null;
  fixpoint: ReturnType<typeof createStrictAnalysisFixpointV1> | null;
  lineages: ReturnType<typeof createStrictProducerLineageReceiptV1>[];
  expressionSets: StrictProducerExpressionSetV1[];
  expressionSetByHypothesis: Map<string, StrictProducerExpressionSetV1>;
  independentReviews: IndependentReviewDecisionV1[];
}

function prepareStrictAnalysis(input: StrictAnalysisExecutionInput) {
  const evidenceEntryIds = new Map(
    input.projection.files.map((file, index) => [file, `E-${index + 1}`] as const)
  );
  const harvested = harvestFrozenFacts(input.compiledPlan, input.projection, evidenceEntryIds);
  const populationInput = buildPopulation(harvested.facts, input.compiledPlan);
  const population = canonicalizeObservationPopulationV1(populationInput);
  const expansion = createStrictAnalysisExpansionPortV1({
    baselineScheduleHash: input.compiledPlan.schedule.baselineScheduleHash,
    baselineObligationIds: input.compiledPlan.schedule.factHarvestObligations.map(
      (row) => row.obligationId
    ),
    knownFactFamilies: input.compiledPlan.factQueryCatalog.families,
    knownSubjectRefs: [
      ...new Set(
        input.compiledPlan.schedule.factHarvestObligations.map((row) => row.canonicalSubjectRef)
      ),
    ],
    obligationCap: input.compiledPlan.selection.resourceCaps.factQueryObligationCap,
  });
  const finalSchedule = expansion.seal();
  const evidence = createFrozenEvidenceProjection({
    sourceRevisionVectorHash: input.compiledPlan.execution.sourceRevisionVectorHash,
    entries: input.projection.files.map((file) =>
      toEvidenceEntry(file, requireEvidenceEntryId(evidenceEntryIds, file))
    ),
  });
  const context = createStrictAnalysisContextProjectionV1({
    runId: input.runId,
    journalId: input.journalId,
    manifestHash: input.compiledPlan.execution.factsBindingHash,
    planCognitionHash: input.planCognitionHash,
    planHash: input.compiledPlan.canonicalPlanHash,
    requiredUniverseHash: input.compiledPlan.requiredFactApplicability.requiredHash,
    baselineScheduleHash: input.compiledPlan.schedule.baselineScheduleHash,
    expansionHeadHash: null,
    currentExpandedScheduleHash: finalSchedule.finalExpandedScheduleHash,
    finalExpandedScheduleHash: finalSchedule.finalExpandedScheduleHash,
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
    factQueryObligationIds: finalSchedule.obligationIds,
    analysisUnitIds: input.compiledPlan.schedule.lensBindings.map((row) => row.bindingId),
    factIds: harvested.facts.map((fact) => fact.factId),
    witnessIds: [...new Set(harvested.facts.flatMap((fact) => fact.witnessIds))],
    populationHashes: [population.populationHash],
    clusterSetHashes: [],
    inductionReceiptHashes: [],
    hypothesisIds: [],
    falsificationReceiptHashes: [],
    dispositionReviewIds: [],
    evidenceEntryIds: evidence.entries.map((entry) => entry.evidenceEntryId),
    derivedFindingCount: 0,
  });
  return { context, evidence, finalSchedule, harvested, population };
}

type PreparedStrictAnalysis = ReturnType<typeof prepareStrictAnalysis>;

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
} {
  const { evidence, finalSchedule, harvested, population } = prepared;

  const eligibleCells = input.compiledPlan.universe.cells
    .filter((cell) => cell.status === 'eligible')
    .map((cell) => ({
      cellId: cell.cellId,
      moduleId: cell.moduleId,
      dimensionId: cell.dimensionId,
    }));
  const eligibleCellIds = new Set(eligibleCells.map((cell) => cell.cellId));
  return {
    enabled: true,
    eligibleCells,
    get context() {
      return state.context;
    },
    populations: [population],
    buildProducerInput() {
      if (!state.epoch || !state.fixpoint) {
        throw new Error('STRICT_PRODUCER_FIXPOINT_REQUIRED');
      }
      const currentEpoch = state.epoch;
      const currentFixpoint = state.fixpoint;
      state.lineages = currentEpoch.producerEligibleHypotheses.map((hypothesis) =>
        createStrictProducerLineageReceiptV1({
          context: state.context,
          epoch: currentEpoch,
          analysisFixpoint: currentFixpoint,
          hypothesisId: hypothesis.hypothesisId,
          evidence,
        })
      );
      return Object.freeze({
        schemaVersion: 1,
        analysisFixpoint: currentFixpoint,
        evidence,
        lineages: state.lineages,
        cardinalityPolicy: 'zero-one-many-no-floor',
        semanticRepairLimit: 2,
      });
    },
    validateAnalystResult(source) {
      const candidate = parseStageJson(source, 'STRICT_ANALYST_OUTPUT_INVALID') as
        | StrictAnalystEpochInputV1
        | { epoch?: StrictAnalystEpochInputV1 };
      const epochInput = 'epoch' in candidate && candidate.epoch ? candidate.epoch : candidate;
      state.epoch = validateStrictAnalystEpochV1({
        ...epochInput,
        knownFactIds: harvested.facts.map((fact) => fact.factId),
        enrolledObligationIds: finalSchedule.obligationIds,
      } as StrictAnalystEpochInputV1);
      state.fixpoint = createStrictAnalysisFixpointV1({
        finalExpandedSchedule: finalSchedule,
        terminalObligations: harvested.terminalObligations,
        epochs: [state.epoch],
      });
      state.context = createStrictAnalysisContextProjectionV1({
        ...withoutContextIdentity(state.context),
        analysisFixpointHash: state.fixpoint.fixpointHash,
        populationHashes: [state.epoch.population.populationHash],
        clusterSetHashes: [state.epoch.clusterSet.clusterSetHash],
        inductionReceiptHashes: state.epoch.inductions.map((receipt) => receipt.receiptHash),
        hypothesisIds: state.epoch.producerEligibleHypotheses.map((row) => row.hypothesisId),
        falsificationReceiptHashes: state.epoch.falsifications.map(
          (receipt) => receipt.receiptHash
        ),
        dispositionReviewIds: state.epoch.hypothesisDispositions.map(
          (row) => row.reviewerReceiptId
        ),
      });
      return { pass: true, action: 'continue', artifact: state.fixpoint };
    },
    reviewProducerResult(source) {
      return reviewStrictProducerResult(source, input, prepared, state, eligibleCellIds);
    },
  };
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
  const reviewer = createStrictIndependentReviewer(input);
  state.independentReviews = [];
  for (const set of state.expressionSets) {
    for (const proposal of set.proposals) {
      state.independentReviews.push(
        await reviewer.review({
          authored: proposal.authored,
          evidence: prepared.evidence,
          expectedSourceRevisionVectorHash: prepared.evidence.sourceRevisionVectorHash,
          producerIdentity: `producer/${input.modelHash}`,
          admissionReceiptId: hashCanonicalJson({
            expressionId: proposal.expressionId,
            kind: 'non-persisting-admission',
          }),
          calibrationReceiptHash: input.reviewer.calibrationReceiptHash,
          repairAttempt: set.version - 1,
        })
      );
    }
  }
  if (state.independentReviews.some((review) => review.verdict !== 'pass')) {
    return {
      pass: false as const,
      action: 'reject' as const,
      reason: 'STRICT_INDEPENDENT_REVIEW_REJECTED',
    };
  }
  state.context = createStrictAnalysisContextProjectionV1({
    ...withoutContextIdentity(state.context),
    hypothesisExpressionSetHash: hashCanonicalJson(state.expressionSets.map((set) => set.setHash)),
  });
  return {
    pass: true as const,
    action: 'continue' as const,
    artifact: {
      expressionSets: state.expressionSets,
      independentReviews: state.independentReviews,
    },
  };
}

function createStrictIndependentReviewer(input: StrictAnalysisExecutionInput) {
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

export async function executeStrictAnalysisAndProduction(
  input: StrictAnalysisExecutionInput
): Promise<StrictAnalysisExecutionResultV1> {
  const prepared = prepareStrictAnalysis(input);
  const state: StrictAnalysisState = {
    context: prepared.context,
    epoch: null,
    fixpoint: null,
    lineages: [],
    expressionSets: [],
    expressionSetByHypothesis: new Map(),
    independentReviews: [],
  };
  const runtimePort = createStrictProductionRuntimePort(input, prepared, state);

  const result = await input.agentService.run({
    profile: { id: 'generate-dimension' },
    params: { dimensionId: 'strict-production' },
    message: {
      role: 'internal',
      content:
        'Execute the strict Analyst and Producer stages from the supplied immutable runtime port.',
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
  if (result.status !== 'success' || result.toolCalls.length > 0 || !epoch || !fixpoint) {
    throw new Error(`STRICT_PRODUCTION_AGENT_FAILED:${result.status}`);
  }
  return Object.freeze({
    facts: prepared.harvested.facts,
    epoch,
    fixpoint,
    expressionSets: state.expressionSets,
    independentReviews: state.independentReviews,
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

function harvestFrozenFacts(
  plan: CompiledColdStartPlanV2,
  projection: MainCertifiedProjectionPayload,
  evidenceEntryIds: ReadonlyMap<MainCertifiedSourceFile, string>
): {
  facts: FactRecordV1[];
  terminalObligations: Array<{
    obligationId: string;
    disposition: 'matched' | 'inspected-no-pattern';
    terminalReceiptId: string;
  }>;
} {
  const moduleByScope = new Map(
    projection.modules.map((module) => [`repo:${module.repoId}:module:${module.moduleId}`, module])
  );
  const fileByPath = new Map(
    projection.files.map((file) => [qualifyMainCertifiedPath(file), file])
  );
  const factsById = new Map<string, FactRecordV1>();
  const terminalObligations: Array<{
    obligationId: string;
    disposition: 'matched' | 'inspected-no-pattern';
    terminalReceiptId: string;
  }> = [];
  for (const obligation of plan.schedule.factHarvestObligations) {
    const module = moduleByScope.get(obligation.canonicalSubjectRef);
    if (!module) {
      throw new Error(`STRICT_FACT_SUBJECT_UNAVAILABLE:${obligation.obligationId}`);
    }
    const files = module.ownedFiles
      .map((file) => fileByPath.get(file))
      .filter(Boolean) as MainCertifiedSourceFile[];
    if (files.length !== module.ownedFiles.length || files.length === 0) {
      throw new Error(`STRICT_FACT_DENOMINATOR_INCOMPLETE:${obligation.obligationId}`);
    }
    const primary = files[0];
    if (!primary) {
      throw new Error(`STRICT_FACT_DENOMINATOR_INCOMPLETE:${obligation.obligationId}`);
    }
    const scan = scanFrozenFamily(obligation.factFamilyId, files);
    const content = Buffer.from(primary.contentBase64, 'base64').toString('utf8');
    const fact = createFactRecordV1({
      factFamilyId: obligation.factFamilyId,
      canonicalSubjectRef: obligation.canonicalSubjectRef,
      primaryScale: obligation.analysisScale,
      sourceRevisionVectorHash: plan.execution.sourceRevisionVectorHash,
      value: {
        denominator: files.map((file) => ({ path: file.relativePath, blobHash: file.blobHash })),
        matchedAnchors: scan,
      },
      witnesses: [
        {
          kind: 'direct',
          evidenceEntryId: requireEvidenceEntryId(evidenceEntryIds, primary),
          evidenceSessionId: plan.execution.factsBindingHash,
          evidenceContentHash: hashText(content),
          sourceRevisionVectorHash: plan.execution.sourceRevisionVectorHash,
          projectContextRefId: obligation.obligationId,
          canonicalSubjectRef: obligation.canonicalSubjectRef,
          anchor: {
            relativePath: primary.relativePath,
            blobHash: primary.blobHash,
            range: { startLine: 1, endLine: Math.max(1, content.split('\n').length) },
          },
        },
      ],
    });
    factsById.set(fact.factId, fact);
    terminalObligations.push({
      obligationId: obligation.obligationId,
      disposition: scan.length > 0 ? 'matched' : 'inspected-no-pattern',
      terminalReceiptId: fact.factId,
    });
  }
  const directFacts = [...factsById.values()];
  const directBySubject = new Map<string, FactRecordV1[]>();
  for (const fact of directFacts) {
    const rows = directBySubject.get(fact.canonicalSubjectRef) ?? [];
    rows.push(fact);
    directBySubject.set(fact.canonicalSubjectRef, rows);
  }
  for (const [canonicalSubjectRef, premises] of directBySubject) {
    const premiseFactIds = premises.map((fact) => fact.factId).sort();
    const derived = createFactRecordV1({
      factFamilyId: 'synthesis-cross-cutting',
      canonicalSubjectRef,
      primaryScale: 'module',
      sourceRevisionVectorHash: plan.execution.sourceRevisionVectorHash,
      value: {
        kind: 'strict-cross-family-derived-summary',
        premiseFactIds,
      },
      witnesses: [
        {
          kind: 'derived',
          derivationRuleId: 'strict-cross-family-summary-v1',
          orderedPremiseFactIds: premiseFactIds,
          sourceRevisionVectorHash: plan.execution.sourceRevisionVectorHash,
        },
      ],
    });
    factsById.set(derived.factId, derived);
  }
  const facts = [...factsById.values()];
  validateFactRecordGraphV1(facts);
  return { facts, terminalObligations };
}

function buildPopulation(
  facts: readonly FactRecordV1[],
  plan: CompiledColdStartPlanV2
): ObservationPopulationInputV1 {
  const observations = facts.map((fact) => ({
    observationId: `observation:${fact.factId.slice(-32)}`,
    factIds: [fact.factId],
    mechanismKey: `${fact.factFamilyId}:${fact.canonicalSubjectRef}`,
    canonicalSubjectRefs: [fact.canonicalSubjectRef],
  }));
  return {
    populationId: `population:${plan.schedule.baselineScheduleHash.slice(-32)}`,
    revision: 1,
    parentPopulationHash: null,
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

function scanFrozenFamily(familyId: string, files: readonly MainCertifiedSourceFile[]) {
  const patterns: Record<string, RegExp> = {
    'syntax-idiom': /\b(import|export|class|interface|function|const|let|async|await)\b/gu,
    'architecture-dependency': /\b(import|export|require|adapter|gateway|facade|repository)\b/giu,
    'api-protocol': /\b(route|handler|request|response|public|export|command|tool)\b/giu,
    'lifecycle-error-invariant':
      /\b(try|catch|finally|throw|transaction|lock|state|status|resume)\b/giu,
    'config-build-test-migration': /\b(config|build|test|migration|schema|environment)\b/giu,
    'history-fix-pattern': /\b(fix|compat|legacy|deprecated|migration|version|rework)\b/giu,
    'synthesis-cross-cutting': /\b(logging|security|error|cache|event|signal|auth|trace)\b/giu,
  };
  const pattern = patterns[familyId];
  if (!pattern) {
    throw new Error(`STRICT_FACT_QUERY_FAMILY_UNIMPLEMENTED:${familyId}`);
  }
  return files.flatMap((file) => {
    const content = Buffer.from(file.contentBase64, 'base64').toString('utf8');
    return [...content.matchAll(pattern)].slice(0, 256).map((match) => ({
      relativePath: file.relativePath,
      token: match[0],
      offset: match.index,
      blobHash: file.blobHash,
    }));
  });
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
    const row = raw as Record<string, unknown>;
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

function withoutContextIdentity(
  context: ReturnType<typeof createStrictAnalysisContextProjectionV1>
) {
  const { schemaVersion: _schemaVersion, contextHash: _contextHash, ...input } = context;
  return input;
}

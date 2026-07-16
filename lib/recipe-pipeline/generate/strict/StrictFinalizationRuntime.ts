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
} from './StrictPrivateCorpusRuntime.js';

export interface StrictFinalizationResultV1 {
  readonly candidateCoverage: CandidateCoverageReceiptV1;
  readonly candidateDataManifestHash: string;
  readonly candidateOracleHash: string;
  readonly finalCoverage: FinalCoverageBindingReceiptV1;
  readonly g4ReceiptHash: string;
  readonly preparedPublicRoute: PreparedPublicKnowledgeRouteV1;
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
  });
  const g4ReceiptHash = hashCanonicalJson({
    gate: 'G4',
    verdict: 'pass',
    candidateCoverageHash: candidateCoverage.receiptHash,
    candidateDataManifestHash,
    vectorManifestHash: input.privateCorpus.vectorManifestHash,
    servingReconciliation: 'exact-candidate-root',
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
  const candidateOracleHash = input.privateCorpus.candidateOracle.oracleHash;
  const snapshotId = `snapshot:${candidateDataManifestHash.slice(-32)}`;
  const servingManifest = createServingSnapshotManifestV1({
    sessionId: input.runId,
    snapshotId,
    candidateDataManifestHash,
    finalCoverageBindingHash: finalCoverage.receiptHash,
    candidateOracleHash,
    vectorGenerationId: input.privateCorpus.vectorGenerationId,
    vectorManifestHash: input.privateCorpus.vectorManifestHash,
    certifiedProjectFactsHash: input.certifiedProjectFactsHash,
    sourceRevisionVectorHash: input.compiledPlan.execution.sourceRevisionVectorHash,
    analysisFixpointHash: input.analysis.fixpoint.fixpointHash,
  });
  const preparedPublicRoute = preparePublicKnowledgeRouteV1({
    schemaVersion: 1,
    sessionId: input.runId,
    snapshotId,
    servingSnapshotManifestHash: servingManifest.manifestHash,
    vectorGenerationId: input.privateCorpus.vectorGenerationId,
    vectorManifestHash: input.privateCorpus.vectorManifestHash,
    certifiedProjectFactsHash: input.certifiedProjectFactsHash,
    sourceRevisionVectorHash: input.compiledPlan.execution.sourceRevisionVectorHash,
    planCognitionLineageHash: input.planCognitionHash,
    compiledPlanHash: input.compiledPlan.canonicalPlanHash,
    factQueryCatalogHash: input.compiledPlan.factQueryCatalog.catalogHash,
    requiredApplicabilityUniverseHash: input.compiledPlan.requiredFactApplicability.universeHash,
    baselineScheduleHash: input.compiledPlan.schedule.baselineScheduleHash,
    expansionLedgerHeadHash: hashCanonicalJson([]),
    finalExpandedScheduleHash: input.analysis.fixpoint.finalExpandedScheduleHash,
    analysisFixpointHash: input.analysis.fixpoint.fixpointHash,
    hypothesisExpressionSetManifestHash: hashCanonicalJson(
      input.expressionSets.map((set) => set.setHash)
    ),
    finalCodeFactGenerationManifestHash: hashCanonicalJson(
      input.analysis.facts.map((fact) => fact.factId)
    ),
    committedAt: input.committedAt,
  });
  return Object.freeze({
    candidateCoverage,
    candidateDataManifestHash,
    candidateOracleHash,
    finalCoverage,
    g4ReceiptHash,
    preparedPublicRoute,
    servingManifest,
  });
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

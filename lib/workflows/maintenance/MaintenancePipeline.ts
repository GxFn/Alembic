import type { ProposalExecutionResult } from '#service/evolution/ProposalExecutor.js';
import type { ReconcileReport, RepairReport } from '#service/knowledge/SourceRefReconciler.js';
import type {
  MaintenanceWorkflowOptions,
  MaintenanceWorkflowResult,
} from '#workflows/scan/ScanTypes.js';

interface SourceRefReconcilerLike {
  reconcile: (opts?: { force?: boolean }) => Promise<ReconcileReport>;
  repairRenames: () => Promise<RepairReport>;
}

interface ProposalExecutorLike {
  checkAndExecute: () => Promise<ProposalExecutionResult>;
}

interface SearchEngineLike {
  refreshIndex?: (opts?: { force?: boolean }) => void;
  buildIndex?: () => void;
}

interface AnalyzerLike {
  scanAll?: () => Promise<unknown[]>;
  analyzeAll?: () => Promise<unknown[]>;
}

export interface MaintenanceWorkflowDependencies {
  sourceRefReconciler?: SourceRefReconcilerLike | null;
  proposalExecutor?: ProposalExecutorLike | null;
  searchEngine?: SearchEngineLike | null;
  decayDetector?: AnalyzerLike | null;
  enhancementSuggester?: AnalyzerLike | null;
  redundancyAnalyzer?: AnalyzerLike | null;
}

export class MaintenanceWorkflow {
  readonly #sourceRefReconciler: SourceRefReconcilerLike | null;
  readonly #proposalExecutor: ProposalExecutorLike | null;
  readonly #searchEngine: SearchEngineLike | null;
  readonly #decayDetector: AnalyzerLike | null;
  readonly #enhancementSuggester: AnalyzerLike | null;
  readonly #redundancyAnalyzer: AnalyzerLike | null;

  constructor(dependencies: MaintenanceWorkflowDependencies = {}) {
    this.#sourceRefReconciler = dependencies.sourceRefReconciler ?? null;
    this.#proposalExecutor = dependencies.proposalExecutor ?? null;
    this.#searchEngine = dependencies.searchEngine ?? null;
    this.#decayDetector = dependencies.decayDetector ?? null;
    this.#enhancementSuggester = dependencies.enhancementSuggester ?? null;
    this.#redundancyAnalyzer = dependencies.redundancyAnalyzer ?? null;
  }

  async run(options: MaintenanceWorkflowOptions): Promise<MaintenanceWorkflowResult> {
    const warnings: string[] = [];
    const sourceRefs = this.#sourceRefReconciler
      ? await this.#sourceRefReconciler.reconcile({ force: options.forceSourceRefReconcile })
      : emptyReconcileReport(warnings);
    const repairedRenames = this.#sourceRefReconciler
      ? await this.#sourceRefReconciler.repairRenames()
      : emptyRepairReport();
    const proposals = this.#proposalExecutor
      ? await this.#proposalExecutor.checkAndExecute()
      : emptyProposalResult(warnings);

    let indexRefreshed = false;
    if (options.refreshSearchIndex !== false && this.#searchEngine) {
      if (this.#searchEngine.refreshIndex) {
        this.#searchEngine.refreshIndex();
      } else {
        this.#searchEngine.buildIndex?.();
      }
      indexRefreshed = true;
    }

    const decaySignals =
      options.includeDecay === false ? 0 : ((await this.#decayDetector?.scanAll?.())?.length ?? 0);
    const enhancementSuggestions =
      options.includeEnhancements === false
        ? 0
        : ((await this.#enhancementSuggester?.analyzeAll?.())?.length ?? 0);
    const redundancyFindings =
      options.includeRedundancy === true
        ? ((await this.#redundancyAnalyzer?.analyzeAll?.())?.length ?? 0)
        : 0;

    return {
      mode: 'maintenance',
      sourceRefs,
      repairedRenames,
      proposals,
      decaySignals,
      enhancementSuggestions,
      redundancyFindings,
      indexRefreshed,
      recommendedRuns: buildRecommendedRuns(sourceRefs, enhancementSuggestions),
      warnings,
    };
  }
}

export class MaintenancePipeline extends MaintenanceWorkflow {}

function buildRecommendedRuns(
  sourceRefs: ReconcileReport,
  enhancementSuggestions: number
): MaintenanceWorkflowResult['recommendedRuns'] {
  const runs: MaintenanceWorkflowResult['recommendedRuns'] = [];
  if (sourceRefs.stale > 0) {
    runs.push({
      mode: 'incremental-correction',
      reason: `${sourceRefs.stale} source refs are stale`,
      scope: {},
      priority: sourceRefs.stale > 10 ? 'high' : 'medium',
    });
  }
  if (enhancementSuggestions > 0) {
    runs.push({
      mode: 'deep-mining',
      reason: `${enhancementSuggestions} enhancement suggestions found`,
      scope: {},
      priority: enhancementSuggestions > 10 ? 'high' : 'medium',
    });
  }
  return runs;
}

function emptyReconcileReport(warnings: string[]): ReconcileReport {
  warnings.push('source ref reconciler unavailable');
  return { inserted: 0, active: 0, stale: 0, skipped: 0, recipesProcessed: 0 };
}

function emptyRepairReport(): RepairReport {
  return { renamed: 0, stillStale: 0 };
}

function emptyProposalResult(warnings: string[]): ProposalExecutionResult {
  warnings.push('proposal executor unavailable');
  return { executed: [], rejected: [], expired: [], skipped: [] };
}

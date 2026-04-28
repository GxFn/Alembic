import type { ScanEvidencePackRecord } from '#repo/scan/ScanEvidencePackRepository.js';
import type { ScanRecommendationRecord } from '#repo/scan/ScanRecommendationRepository.js';
import type { ScanRunRecord } from '#repo/scan/ScanRunRepository.js';
import type { DimensionDef, ProjectSnapshot } from '#types/project-snapshot.js';
import type { PipelineFillView } from '#types/snapshot-views.js';
import { fillDimensionsV3 } from '#workflows/bootstrap/BootstrapWorkflow.js';
import type {
  BootstrapProjectAnalysisResult,
  RunBootstrapProjectAnalysisOptions,
} from '#workflows/bootstrap/pipeline/BootstrapProjectAnalysisPipeline.js';
import { ColdStartBaselinePipeline } from '#workflows/scan/lifecycle/ColdStartBaselinePipeline.js';
import {
  type ColdStartLifecycleResult,
  completeColdStartLifecycleRun,
  runColdStartLifecycleFill,
} from '#workflows/scan/lifecycle/ColdStartLifecycleRunner.js';
import {
  buildColdStartScanContext,
  type ColdStartScanContext,
  type ColdStartScanContextOptions,
  projectColdStartScanContextSummary,
} from '#workflows/scan/lifecycle/ColdStartScanContext.js';
import {
  projectScanBaselineRef,
  resolveScanBaselineAnchor,
} from '#workflows/scan/lifecycle/ScanBaselineResolver.js';
import { ScanRecommendationScheduler } from '#workflows/scan/lifecycle/ScanRecommendationScheduler.js';
import {
  ScanRunTracker,
  type ScanRunTrackerLogger,
  type TrackedScanRunResult,
} from '#workflows/scan/lifecycle/ScanRunTracker.js';
import {
  collectChangeSetFiles,
  eventsToChangeSet,
} from '#workflows/scan/normalization/ScanChangeSetNormalizer.js';
import type { ScanJobQueue, ScanJobRecord } from '#workflows/scan/ScanJobQueue.js';
import type {
  DeepMiningRequest,
  DeepMiningResult,
  IncrementalCorrectionResult,
  IncrementalCorrectionRunInput,
  KnowledgeEvidencePack,
  MaintenanceWorkflowOptions,
  MaintenanceWorkflowResult,
  ScanBaselineRef,
  ScanBudget,
  ScanDepth,
  ScanFileEvidenceInput,
  ScanPlan,
  ScanScope,
} from '#workflows/scan/ScanTypes.js';
import type { DeepMiningWorkflow } from '#workflows/scan/workflows/DeepMiningWorkflow.js';
import type { IncrementalCorrectionWorkflow } from '#workflows/scan/workflows/IncrementalCorrectionWorkflow.js';
import type { MaintenanceWorkflow } from '#workflows/scan/workflows/MaintenanceWorkflow.js';
import type { KnowledgeRetrievalPipeline } from '../retrieval/KnowledgeRetrievalPipeline.js';

export interface ScanLifecycleRunnerContainer {
  singletons?: Record<string, unknown>;
  get?: (name: string) => unknown;
}

export interface ScanLifecycleRunOptions {
  reason?: string;
  signal?: AbortSignal;
}

export interface ScanLifecycleQueueOptions {
  label?: string;
  reason?: string;
  maxAttempts?: number;
}

export type ScanLifecycleTrackedResult<T> = TrackedScanRunResult<T> & {
  recommendations: ScanRecommendationRecord[];
};

export interface ColdStartContextPreparationResult {
  scanContext: ColdStartScanContext | null;
  summary: Record<string, unknown> | null;
}

export interface ColdStartBaselinePreparationResult extends BootstrapProjectAnalysisResult {
  scanContext: ColdStartScanContext | null;
  scanSummary: Record<string, unknown> | null;
}

export interface ColdStartHandlerCompletionResult {
  scanContext: ColdStartScanContext | null;
  summary: Record<string, unknown> | null;
}

type ColdStartProjectAnalyzer = Pick<ColdStartBaselinePipeline, 'analyzeProject'>;

export interface ScanDimensionFillContext {
  plan: ScanPlan;
  evidencePack: KnowledgeEvidencePack | null;
  evidenceSummary: Record<string, unknown> | null;
  run: ScanRunRecord | null;
  evidencePackRecord: ScanEvidencePackRecord | null;
}

export interface DeepMiningGapFillContextOptions {
  baselineRunId?: string | null;
  baselineSnapshotId?: string | null;
  dimensions?: string[];
  modules?: string[];
  query?: string;
  reason?: string;
  depth?: Extract<ScanDepth, 'deep' | 'exhaustive'>;
  budget?: ScanBudget;
  retrieveEvidence?: boolean;
}

export interface DeepMiningGapFillContextPreparationResult {
  scanContext: ScanDimensionFillContext | null;
  summary: Record<string, unknown> | null;
}

export interface ScanDimensionFillResult {
  mode: 'deep-mining';
  execution: Awaited<ReturnType<typeof fillDimensionsV3>>;
  run: ScanRunRecord | null;
}

export class ScanLifecycleBaselineRequiredError extends Error {
  constructor(message = 'Deep-mining requires an existing cold-start baseline') {
    super(message);
    this.name = 'ScanLifecycleBaselineRequiredError';
  }
}

export class ScanLifecycleServiceUnavailableError extends Error {
  readonly serviceName: string;

  constructor(serviceName: string) {
    super(`${serviceName} unavailable`);
    this.name = 'ScanLifecycleServiceUnavailableError';
    this.serviceName = serviceName;
  }
}

export class ScanLifecycleRunner {
  readonly #container: ScanLifecycleRunnerContainer;
  readonly #logger: ScanRunTrackerLogger | null;

  constructor(container: ScanLifecycleRunnerContainer, logger?: ScanRunTrackerLogger | null) {
    this.#container = container;
    this.#logger = logger ?? null;
  }

  static fromContainer(
    container: ScanLifecycleRunnerContainer,
    logger?: ScanRunTrackerLogger | null
  ): ScanLifecycleRunner {
    return new ScanLifecycleRunner(container, logger);
  }

  analyzeColdStartProject(
    options: RunBootstrapProjectAnalysisOptions
  ): Promise<BootstrapProjectAnalysisResult> {
    return this.#coldStartProjectAnalyzer().analyzeProject(options);
  }

  async prepareColdStartBaseline(
    analysisOptions: RunBootstrapProjectAnalysisOptions,
    scanOptions: ColdStartScanContextOptions | undefined
  ): Promise<ColdStartBaselinePreparationResult> {
    const analysis = await this.analyzeColdStartProject(analysisOptions);
    if (analysis.snapshot.isEmpty) {
      return { ...analysis, scanContext: null, scanSummary: null };
    }
    const prepared = await this.prepareColdStartContext(analysis.snapshot, scanOptions);
    return {
      ...analysis,
      scanContext: prepared.scanContext,
      scanSummary: prepared.summary,
    };
  }

  async buildColdStartContext(
    snapshot: ProjectSnapshot,
    options: ColdStartScanContextOptions | undefined
  ): Promise<ColdStartScanContext | null> {
    return buildColdStartScanContext({ container: this.#container }, snapshot, options);
  }

  async prepareColdStartContext(
    snapshot: ProjectSnapshot,
    options: ColdStartScanContextOptions | undefined
  ): Promise<ColdStartContextPreparationResult> {
    const scanContext = await this.buildColdStartContext(snapshot, options);
    return {
      scanContext,
      summary: this.projectColdStartContextSummary(scanContext),
    };
  }

  completeColdStartRun(
    scanContext: ColdStartScanContext | null,
    summary: Record<string, unknown>
  ): ColdStartScanContext | null {
    return completeColdStartLifecycleRun(
      { container: this.#container, logger: this.#logger ?? undefined },
      scanContext,
      summary
    );
  }

  projectColdStartContextSummary(
    scanContext: ColdStartScanContext | null
  ): Record<string, unknown> | null {
    return projectColdStartScanContextSummary(scanContext);
  }

  runColdStartFill(
    view: PipelineFillView,
    dimensions: DimensionDef[]
  ): Promise<ColdStartLifecycleResult> {
    return runColdStartLifecycleFill(view, dimensions);
  }

  async prepareDeepMiningGapFillContext(
    snapshot: ProjectSnapshot,
    options: DeepMiningGapFillContextOptions = {}
  ): Promise<DeepMiningGapFillContextPreparationResult> {
    if (snapshot.isEmpty) {
      return { scanContext: null, summary: null };
    }
    const anchor = resolveScanBaselineAnchor(this.#container, {
      projectRoot: snapshot.projectRoot,
      requestedRunId: options.baselineRunId,
      requestedSnapshotId: options.baselineSnapshotId,
    });
    const baseline = projectScanBaselineRef(anchor);
    if (!baseline) {
      throw new ScanLifecycleBaselineRequiredError(anchor.reason ?? undefined);
    }

    const depth = options.depth ?? 'deep';
    const activeDimensions = resolveActiveDimensions(snapshot, options.dimensions);
    const scope: ScanScope = {
      dimensions: activeDimensions,
      modules: options.modules,
      query: options.query,
    };
    const plan = buildDeepMiningGapFillPlan({
      baseline,
      activeDimensions,
      scope,
      depth,
      reason: options.reason ?? 'Deep-mining gap fill',
      budget: options.budget,
    });

    let evidencePack: KnowledgeEvidencePack | null = null;
    let evidenceSummary: Record<string, unknown> | null = null;
    if (options.retrieveEvidence !== false) {
      const retrieval = readService<KnowledgeRetrievalPipeline>(
        this.#container,
        'knowledgeRetrievalPipeline'
      );
      if (retrieval) {
        evidencePack = await retrieval.retrieve({
          projectRoot: snapshot.projectRoot,
          mode: 'deep-mining',
          intent: 'fill-coverage-gap',
          baseline,
          depth,
          scope,
          files: toScanFiles(snapshot),
          budget: {
            ...options.budget,
            maxFiles: options.budget?.maxFiles ?? plan.budgets.maxFiles,
            maxKnowledgeItems: options.budget?.maxKnowledgeItems ?? plan.budgets.maxKnowledgeItems,
            maxTotalChars: options.budget?.maxTotalChars ?? plan.budgets.maxTotalChars,
          },
          primaryLang: snapshot.language.primaryLang,
        });
        evidenceSummary = summarizeEvidencePack(evidencePack);
      } else {
        evidenceSummary = { unavailable: true };
      }
    }

    const persisted = this.#tracker().create(
      {
        projectRoot: snapshot.projectRoot,
        mode: 'deep-mining',
        depth,
        reason: plan.reason,
        activeDimensions,
        scope,
        budgets: projectScanBudget(plan),
        parentSnapshotId: baseline.snapshotId ?? null,
        baselineSnapshotId: baseline.snapshotId ?? null,
      },
      evidencePack
        ? {
            packKind: 'deep-mining',
            pack: evidencePack,
            summary: evidenceSummary ?? undefined,
          }
        : null
    );
    const scanContext = { plan, evidencePack, evidenceSummary, ...persisted };
    return {
      scanContext,
      summary: projectScanDimensionFillContextSummary(scanContext),
    };
  }

  bindColdStartFillView<T extends PipelineFillView>(
    view: T,
    scanContext: ColdStartScanContext | null
  ): T {
    return {
      ...view,
      scanPlan: scanContext?.plan ?? null,
      scanRunId: scanContext?.run?.id ?? null,
      scanEvidencePack: scanContext?.evidencePack ?? null,
    };
  }

  bindScanDimensionFillView<T extends PipelineFillView>(
    view: T,
    scanContext: ScanDimensionFillContext | null
  ): T {
    return {
      ...view,
      scanPlan: scanContext?.plan ?? null,
      scanRunId: scanContext?.run?.id ?? null,
      scanEvidencePack: scanContext?.evidencePack ?? null,
    };
  }

  runDeepMiningFill(
    view: PipelineFillView,
    dimensions: DimensionDef[]
  ): Promise<ScanDimensionFillResult> {
    return this.#runTrackedDimensionFill(view, dimensions);
  }

  completeDeepMiningBriefingRun(
    scanContext: ScanDimensionFillContext | null,
    summary: Record<string, unknown>
  ): DeepMiningGapFillContextPreparationResult {
    if (!scanContext) {
      return { scanContext: null, summary: null };
    }

    const projectedSummary = {
      mode: 'deep-mining',
      executionStatus: 'mission-briefing',
      evidence: scanContext.evidenceSummary,
      ...summary,
    };
    const completedRun = this.#tracker().complete(scanContext.run?.id, projectedSummary);
    const completedContext = completedRun ? { ...scanContext, run: completedRun } : scanContext;
    const contextSummary = projectScanDimensionFillContextSummary(completedContext);
    return {
      scanContext: completedContext,
      summary: contextSummary ? { ...contextSummary, completion: projectedSummary } : null,
    };
  }

  completeAndProjectColdStartRun(
    scanContext: ColdStartScanContext | null,
    summary: Record<string, unknown>
  ): ColdStartHandlerCompletionResult {
    const projectedSummary = { ...summary };
    if (projectedSummary.evidence === undefined && scanContext?.evidenceSummary) {
      projectedSummary.evidence = scanContext.evidenceSummary;
    }
    const completedContext = this.completeColdStartRun(scanContext, projectedSummary);
    return {
      scanContext: completedContext,
      summary: this.projectColdStartContextSummary(completedContext),
    };
  }

  async runIncrementalCorrection(
    request: IncrementalCorrectionRunInput,
    options: ScanLifecycleRunOptions = {}
  ): Promise<ScanLifecycleTrackedResult<IncrementalCorrectionResult>> {
    const workflow = this.#requireIncrementalCorrectionWorkflow();
    const depth = request.depth ?? 'standard';
    const changeSet = eventsToChangeSet(request.events);
    const tracked = await this.#tracker().track({
      input: {
        projectRoot: request.projectRoot,
        mode: 'incremental-correction',
        depth,
        reason: options.reason ?? 'Scan lifecycle incremental correction',
        scope: { files: collectChangeSetFiles(changeSet) },
        changeSet,
        budgets: request.budget,
      },
      execute: () => workflow.run(request),
      summarize: summarizeIncrementalResult,
      evidencePack: (result) => result.evidencePack,
      evidenceKind: 'incremental-correction',
      signal: options.signal,
    });
    return { ...tracked, recommendations: [] };
  }

  enqueueIncrementalCorrection(
    request: IncrementalCorrectionRunInput,
    options: ScanLifecycleQueueOptions = {}
  ): ScanJobRecord<
    IncrementalCorrectionRunInput,
    ScanLifecycleTrackedResult<IncrementalCorrectionResult>
  > {
    return this.#queue().enqueue({
      mode: 'incremental-correction',
      label: options.label ?? 'incremental-correction scan',
      request,
      maxAttempts: options.maxAttempts,
      execute: (context) =>
        this.runIncrementalCorrection(request, {
          reason: options.reason,
          signal: context.signal,
        }),
    });
  }

  resolveDeepMiningRequest(request: DeepMiningRequest): DeepMiningRequest | null {
    const anchor = resolveScanBaselineAnchor(this.#container, {
      projectRoot: request.projectRoot,
      requestedRunId: request.baselineRunId,
      requestedSnapshotId: request.baselineSnapshotId,
    });
    const baseline = projectScanBaselineRef(anchor);
    if (!baseline) {
      return null;
    }
    return {
      ...request,
      baseline,
      baselineRunId: baseline.runId,
      baselineSnapshotId: baseline.snapshotId,
    };
  }

  async runDeepMining(
    request: DeepMiningRequest,
    options: ScanLifecycleRunOptions = {}
  ): Promise<ScanLifecycleTrackedResult<DeepMiningResult>> {
    const workflow = this.#requireDeepMiningWorkflow();
    const resolved = this.resolveDeepMiningRequest(request);
    if (!resolved) {
      throw new ScanLifecycleBaselineRequiredError();
    }
    const tracked = await this.#tracker().track({
      input: {
        projectRoot: resolved.projectRoot,
        mode: 'deep-mining',
        depth: resolved.depth ?? 'deep',
        reason: options.reason ?? 'Scan lifecycle deep mining',
        activeDimensions: resolved.dimensions ?? [],
        scope: {
          dimensions: resolved.dimensions,
          modules: resolved.modules,
          query: resolved.query,
        },
        budgets: { maxKnowledgeItems: resolved.maxNewCandidates },
        parentSnapshotId: resolved.baselineSnapshotId ?? null,
        baselineSnapshotId: resolved.baselineSnapshotId ?? null,
      },
      execute: () => workflow.run(resolved),
      summarize: summarizeDeepMiningResult,
      evidencePack: (result) => result.evidencePack,
      evidenceKind: 'deep-mining',
      signal: options.signal,
    });
    return { ...tracked, recommendations: [] };
  }

  enqueueDeepMining(
    request: DeepMiningRequest,
    options: ScanLifecycleQueueOptions = {}
  ): ScanJobRecord<DeepMiningRequest, ScanLifecycleTrackedResult<DeepMiningResult>> {
    const resolved = this.resolveDeepMiningRequest(request);
    if (!resolved) {
      throw new ScanLifecycleBaselineRequiredError();
    }
    return this.#queue().enqueue({
      mode: 'deep-mining',
      label: options.label ?? 'deep-mining scan',
      request: resolved,
      maxAttempts: options.maxAttempts,
      execute: (context) =>
        this.runDeepMining(resolved, {
          reason: options.reason,
          signal: context.signal,
        }),
    });
  }

  async runMaintenance(
    request: MaintenanceWorkflowOptions,
    options: ScanLifecycleRunOptions = {}
  ): Promise<ScanLifecycleTrackedResult<MaintenanceWorkflowResult>> {
    const workflow = this.#requireMaintenanceWorkflow();
    const tracked = await this.#tracker().track({
      input: {
        projectRoot: request.projectRoot,
        mode: 'maintenance',
        depth: 'light',
        reason: options.reason ?? 'Scan lifecycle maintenance',
        scope: {},
      },
      execute: () => workflow.run(request),
      summarize: summarizeMaintenanceResult,
      signal: options.signal,
    });
    const recommendations = ScanRecommendationScheduler.fromContainer(
      this.#container
    ).persistPending({
      projectRoot: request.projectRoot,
      sourceRunId: tracked.run?.id ?? null,
      recommendedRuns: tracked.result.recommendedRuns,
    });
    return { ...tracked, recommendations };
  }

  enqueueMaintenance(
    request: MaintenanceWorkflowOptions,
    options: ScanLifecycleQueueOptions = {}
  ): ScanJobRecord<
    MaintenanceWorkflowOptions,
    ScanLifecycleTrackedResult<MaintenanceWorkflowResult>
  > {
    return this.#queue().enqueue({
      mode: 'maintenance',
      label: options.label ?? 'maintenance scan',
      request,
      maxAttempts: options.maxAttempts,
      execute: (context) =>
        this.runMaintenance(request, {
          reason: options.reason,
          signal: context.signal,
        }),
    });
  }

  #tracker(): ScanRunTracker {
    return ScanRunTracker.fromContainer(this.#container, this.#logger);
  }

  #coldStartProjectAnalyzer(): ColdStartProjectAnalyzer {
    const pipeline = readService<ColdStartProjectAnalyzer>(
      this.#container,
      'coldStartBaselinePipeline'
    );
    return isColdStartProjectAnalyzer(pipeline) ? pipeline : new ColdStartBaselinePipeline();
  }

  #queue(): ScanJobQueue {
    return requireService<ScanJobQueue>(this.#container, 'scanJobQueue', isScanJobQueue);
  }

  #requireIncrementalCorrectionWorkflow(): IncrementalCorrectionWorkflow {
    return requireService<IncrementalCorrectionWorkflow>(
      this.#container,
      'incrementalCorrectionWorkflow',
      isWorkflow
    );
  }

  #requireDeepMiningWorkflow(): DeepMiningWorkflow {
    return requireService<DeepMiningWorkflow>(this.#container, 'deepMiningWorkflow', isWorkflow);
  }

  #requireMaintenanceWorkflow(): MaintenanceWorkflow {
    return requireService<MaintenanceWorkflow>(this.#container, 'maintenanceWorkflow', isWorkflow);
  }

  async #runTrackedDimensionFill(
    view: PipelineFillView,
    dimensions: DimensionDef[]
  ): Promise<ScanDimensionFillResult> {
    const tracker = this.#tracker();
    const scanRunId = view.scanRunId ?? null;
    try {
      const execution = await fillDimensionsV3(view, dimensions);
      if (execution.status === 'ai-unavailable') {
        const run = tracker.fail(scanRunId, 'AI Provider not available', execution.summary);
        return { mode: 'deep-mining', execution, run };
      }
      const run = tracker.complete(scanRunId, {
        mode: 'deep-mining',
        executionStatus: execution.status,
        evidence: summarizeOptionalEvidence(view.scanEvidencePack),
        ...execution.summary,
      });
      return { mode: 'deep-mining', execution, run };
    } catch (err: unknown) {
      tracker.fail(scanRunId, err, {
        stage: 'deep-mining-dimension-fill',
        dimensions: dimensions.length,
      });
      throw err;
    }
  }
}

export function summarizeIncrementalResult(
  result: IncrementalCorrectionResult
): Record<string, unknown> {
  return {
    fixed: result.reactiveReport.fixed,
    deprecated: result.reactiveReport.deprecated,
    skipped: result.reactiveReport.skipped,
    needsReview: result.reactiveReport.needsReview,
    suggestReview: result.reactiveReport.suggestReview,
    impactedRecipeCount: result.evidencePack.changes?.impactedRecipeIds.length ?? 0,
    auditExecuted: Boolean(result.auditResult),
    skippedAgentReason: result.skippedAgentReason,
    evidence: summarizeEvidencePack(result.evidencePack),
  };
}

export function summarizeDeepMiningResult(result: DeepMiningResult): Record<string, unknown> {
  return {
    baseline: result.baseline,
    scanExecuted: Boolean(result.scanResult),
    skippedAgentReason: result.skippedAgentReason,
    evidence: summarizeEvidencePack(result.evidencePack),
  };
}

export function summarizeMaintenanceResult(
  result: MaintenanceWorkflowResult
): Record<string, unknown> {
  return {
    staleSourceRefs: result.sourceRefs.stale,
    repairedRenames: result.repairedRenames.renamed,
    proposalsExecuted: result.proposals.executed.length,
    proposalsExpired: result.proposals.expired.length,
    decaySignals: result.decaySignals,
    enhancementSuggestions: result.enhancementSuggestions,
    redundancyFindings: result.redundancyFindings,
    indexRefreshed: result.indexRefreshed,
    recommendedRuns: result.recommendedRuns.length,
    warnings: result.warnings,
  };
}

export function summarizeEvidencePack(pack: KnowledgeEvidencePack): Record<string, unknown> {
  return {
    fileCount: pack.files.length,
    knowledgeCount: pack.knowledge.length,
    graphEdgeCount: pack.graph.edges.length,
    gapCount: pack.gaps.length,
    truncated: pack.diagnostics.truncated,
    warnings: pack.diagnostics.warnings.length,
    retrievalMs: pack.diagnostics.retrievalMs,
  };
}

export function projectScanDimensionFillContextSummary(
  scanContext: ScanDimensionFillContext | null
): Record<string, unknown> | null {
  if (!scanContext) {
    return null;
  }
  return {
    plan: {
      mode: scanContext.plan.mode,
      depth: scanContext.plan.depth,
      reason: scanContext.plan.reason,
      baseline: scanContext.plan.baseline ?? null,
      activeDimensions: scanContext.plan.activeDimensions,
      skippedDimensions: scanContext.plan.skippedDimensions,
      budgets: scanContext.plan.budgets,
    },
    evidence: scanContext.evidenceSummary,
    run: scanContext.run
      ? {
          id: scanContext.run.id,
          status: scanContext.run.status,
          startedAt: scanContext.run.startedAt,
          completedAt: scanContext.run.completedAt,
          durationMs: scanContext.run.durationMs,
        }
      : null,
    evidencePackRecord: scanContext.evidencePackRecord
      ? {
          id: scanContext.evidencePackRecord.id,
          packKind: scanContext.evidencePackRecord.packKind,
          charCount: scanContext.evidencePackRecord.charCount,
          truncated: scanContext.evidencePackRecord.truncated,
        }
      : null,
  };
}

function requireService<T>(
  container: ScanLifecycleRunnerContainer,
  serviceName: string,
  guard: (value: unknown) => value is T
): T {
  const service = container.get?.(serviceName);
  if (!guard(service)) {
    throw new ScanLifecycleServiceUnavailableError(serviceName);
  }
  return service;
}

function readService<T>(container: ScanLifecycleRunnerContainer, serviceName: string): T | null {
  try {
    return (container.get?.(serviceName) as T | undefined) ?? null;
  } catch {
    return null;
  }
}

function resolveActiveDimensions(
  snapshot: ProjectSnapshot,
  dimensions: string[] | undefined
): string[] {
  const allDimensionIds = snapshot.activeDimensions.map((dimension) => dimension.id);
  return dimensions?.length
    ? allDimensionIds.filter((dimension) => dimensions.includes(dimension))
    : allDimensionIds;
}

function buildDeepMiningGapFillPlan({
  baseline,
  activeDimensions,
  scope,
  depth,
  reason,
  budget,
}: {
  baseline: ScanBaselineRef;
  activeDimensions: string[];
  scope: ScanScope;
  depth: Extract<ScanDepth, 'deep' | 'exhaustive'>;
  reason: string;
  budget?: ScanBudget;
}): ScanPlan {
  return {
    mode: 'deep-mining',
    depth,
    reason,
    baseline,
    activeDimensions,
    skippedDimensions: [],
    scope,
    fallback: null,
    budgets: {
      maxFiles: budget?.maxFiles ?? 80,
      maxKnowledgeItems: budget?.maxKnowledgeItems ?? 60,
      maxTotalChars: budget?.maxTotalChars ?? 100_000,
      maxAgentIterations: depth === 'exhaustive' ? 40 : 30,
    },
  };
}

function toScanFiles(snapshot: ProjectSnapshot): ScanFileEvidenceInput[] {
  return snapshot.allFiles.map((file) => ({
    relativePath: file.relativePath || file.name,
    path: file.path,
    name: file.name,
    language: file.language,
    content: file.content,
  }));
}

function projectScanBudget(plan: ScanPlan): ScanBudget {
  return {
    maxFiles: plan.budgets.maxFiles,
    maxKnowledgeItems: plan.budgets.maxKnowledgeItems,
    maxTotalChars: plan.budgets.maxTotalChars,
  };
}

function summarizeOptionalEvidence(
  pack: KnowledgeEvidencePack | null | undefined
): Record<string, unknown> | null {
  return pack ? summarizeEvidencePack(pack) : null;
}

function isWorkflow<T extends { run: unknown }>(value: unknown): value is T {
  return Boolean(
    value && typeof value === 'object' && typeof (value as { run?: unknown }).run === 'function'
  );
}

function isScanJobQueue(value: unknown): value is ScanJobQueue {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { enqueue?: unknown }).enqueue === 'function'
  );
}

function isColdStartProjectAnalyzer(value: unknown): value is ColdStartProjectAnalyzer {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { analyzeProject?: unknown }).analyzeProject === 'function'
  );
}

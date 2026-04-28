import type { DimensionDef } from '#types/project-snapshot.js';
import type { PipelineFillView } from '#types/snapshot-views.js';
import type { BootstrapDimensionFillResult } from '#workflows/bootstrap/BootstrapWorkflow.js';
import {
  type BootstrapProjectAnalysisResult,
  type RunBootstrapProjectAnalysisOptions,
  runBootstrapProjectAnalysis,
} from '#workflows/bootstrap/pipeline/BootstrapProjectAnalysisPipeline.js';
import {
  type ColdStartBaselineResult,
  projectColdStartBaselineResult,
} from '#workflows/scan/lifecycle/ColdStartBaselineProjection.js';
import type { ColdStartScanContext } from '#workflows/scan/lifecycle/ColdStartScanContext.js';
import type { ScanPlan } from '#workflows/scan/ScanTypes.js';
import {
  ColdStartWorkflow,
  type ColdStartWorkflowResult,
} from '#workflows/scan/workflows/ColdStartWorkflow.js';

export interface ColdStartDimensionExecutionInput {
  view: PipelineFillView;
  dimensions: DimensionDef[];
  plan?: ScanPlan;
}

export type ColdStartDimensionExecutionResult = ColdStartWorkflowResult;

export interface ColdStartBaselineProjectionInput {
  scanRunId?: string | null;
  scanContext?: ColdStartScanContext | null;
  execution?: BootstrapDimensionFillResult | null;
  summary?: Record<string, unknown> | null;
}

export class ColdStartBaselinePipeline {
  readonly #workflow: ColdStartWorkflow;

  constructor(workflow: ColdStartWorkflow = new ColdStartWorkflow()) {
    this.#workflow = workflow;
  }

  analyzeProject(
    options: RunBootstrapProjectAnalysisOptions
  ): Promise<BootstrapProjectAnalysisResult> {
    return runBootstrapProjectAnalysis(options);
  }

  executeDimensions(
    input: ColdStartDimensionExecutionInput
  ): Promise<ColdStartDimensionExecutionResult> {
    return this.#workflow.run(input);
  }

  projectBaseline(input: ColdStartBaselineProjectionInput): ColdStartBaselineResult {
    return projectColdStartBaselineResult(input);
  }
}

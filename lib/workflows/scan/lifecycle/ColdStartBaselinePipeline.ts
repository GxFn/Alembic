import type { DimensionDef } from '#types/project-snapshot.js';
import type { PipelineFillView } from '#types/snapshot-views.js';
import {
  ColdStartWorkflow,
  type ColdStartWorkflowResult,
} from '#workflows/cold-start/dimension-execution/ColdStartWorkflow.js';
import type { BootstrapDimensionFillResult } from '#workflows/deprecated-cold-start/BootstrapWorkflow.js';
import {
  type BootstrapProjectAnalysisResult,
  type RunBootstrapProjectAnalysisOptions,
  runBootstrapProjectAnalysis,
} from '#workflows/deprecated-cold-start/pipeline/BootstrapProjectAnalysisPipeline.js';
import {
  type ColdStartBaselineResult,
  projectColdStartBaselineResult,
} from '#workflows/scan/lifecycle/ColdStartBaselineProjection.js';
import type { ColdStartScanContext } from '#workflows/scan/lifecycle/ColdStartScanContext.js';
import type { ScanPlan } from '#workflows/scan/ScanTypes.js';

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

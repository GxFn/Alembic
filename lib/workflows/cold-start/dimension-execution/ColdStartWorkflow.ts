import type { DimensionDef } from '#types/project-snapshot.js';
import type { PipelineFillView } from '#types/snapshot-views.js';
import {
  type BootstrapDimensionFillResult,
  fillDimensionsV3,
} from '#workflows/deprecated-cold-start/BootstrapWorkflow.js';
import type { ScanPlan } from '#workflows/scan/ScanTypes.js';

export interface ColdStartWorkflowRunInput {
  view: PipelineFillView;
  dimensions: DimensionDef[];
  plan?: ScanPlan;
}

export interface ColdStartWorkflowResult {
  mode: 'cold-start';
  plan?: ScanPlan;
  execution: BootstrapDimensionFillResult;
}

export class ColdStartWorkflow {
  async run(input: ColdStartWorkflowRunInput): Promise<ColdStartWorkflowResult> {
    const execution = await fillDimensionsV3(input.view, input.dimensions);
    return { mode: 'cold-start', plan: input.plan, execution };
  }
}

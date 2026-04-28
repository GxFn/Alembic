import type { DimensionDef } from '#types/project-snapshot.js';
import type { FileChangeEvent } from '#types/reactive-evolution.js';
import type { PipelineFillView } from '#types/snapshot-views.js';
import type {
  ColdStartWorkflow,
  ColdStartWorkflowResult,
} from '#workflows/cold-start/dimension-execution/ColdStartWorkflow.js';
import type { DeepMiningWorkflow } from '#workflows/deep-mining/DeepMiningPipeline.js';
import type { IncrementalCorrectionWorkflow } from '#workflows/incremental-correction/IncrementalCorrectionPipeline.js';
import type { MaintenanceWorkflow } from '#workflows/maintenance/MaintenancePipeline.js';
import type { ScanPlanService } from '#workflows/scan/ScanPlanService.js';
import type { ScanPlan, ScanPlanRequest } from '#workflows/scan/ScanTypes.js';
import type {
  DeepMiningRequest,
  DeepMiningResult,
  IncrementalCorrectionResult,
  MaintenanceWorkflowOptions,
  MaintenanceWorkflowResult,
} from './ScanTypes.js';

export interface ScanOrchestratorDependencies {
  scanPlanService: ScanPlanService;
  coldStartWorkflow: ColdStartWorkflow;
  deepMiningWorkflow: DeepMiningWorkflow;
  incrementalCorrectionWorkflow: IncrementalCorrectionWorkflow;
  maintenanceWorkflow: MaintenanceWorkflow;
}

export interface ScanOrchestratorRunRequest {
  plan?: ScanPlan;
  planRequest?: ScanPlanRequest;
  coldStart?: { view: PipelineFillView; dimensions: DimensionDef[] };
  events?: FileChangeEvent[];
  deepMining?: DeepMiningRequest;
  maintenance?: MaintenanceWorkflowOptions;
}

export type ScanOrchestratorResult =
  | ColdStartWorkflowResult
  | DeepMiningResult
  | IncrementalCorrectionResult
  | MaintenanceWorkflowResult;

export class ScanOrchestrator {
  readonly #scanPlanService: ScanPlanService;
  readonly #coldStartWorkflow: ColdStartWorkflow;
  readonly #deepMiningWorkflow: DeepMiningWorkflow;
  readonly #incrementalCorrectionWorkflow: IncrementalCorrectionWorkflow;
  readonly #maintenanceWorkflow: MaintenanceWorkflow;

  constructor(dependencies: ScanOrchestratorDependencies) {
    this.#scanPlanService = dependencies.scanPlanService;
    this.#coldStartWorkflow = dependencies.coldStartWorkflow;
    this.#deepMiningWorkflow = dependencies.deepMiningWorkflow;
    this.#incrementalCorrectionWorkflow = dependencies.incrementalCorrectionWorkflow;
    this.#maintenanceWorkflow = dependencies.maintenanceWorkflow;
  }

  async run(request: ScanOrchestratorRunRequest): Promise<ScanOrchestratorResult> {
    const plan =
      request.plan ??
      (request.planRequest ? this.#scanPlanService.plan(request.planRequest) : null);
    if (!plan) {
      throw new Error('ScanOrchestrator requires a plan or planRequest');
    }

    switch (plan.mode) {
      case 'cold-start': {
        if (!request.coldStart) {
          throw new Error('Cold-start scan requires view and dimensions');
        }
        return this.#coldStartWorkflow.run({ ...request.coldStart, plan });
      }
      case 'deep-mining': {
        if (!request.deepMining) {
          throw new Error('Deep-mining scan requires deepMining request');
        }
        return this.#deepMiningWorkflow.run(request.deepMining);
      }
      case 'incremental-correction': {
        if (!request.events || !request.planRequest) {
          throw new Error('Incremental correction requires events and planRequest');
        }
        return this.#incrementalCorrectionWorkflow.run({
          projectRoot: request.planRequest.projectRoot,
          events: request.events,
          depth: plan.depth,
          budget: request.planRequest.budget,
        });
      }
      case 'maintenance': {
        if (!request.maintenance) {
          throw new Error('Maintenance scan requires maintenance options');
        }
        return this.#maintenanceWorkflow.run(request.maintenance);
      }
    }
  }
}

import { ColdStartWorkflow } from './dimension-execution/ColdStartWorkflow.js';

export class ColdStartPipeline extends ColdStartWorkflow {}

export { ColdStartWorkflow };
export type {
  ColdStartWorkflowResult,
  ColdStartWorkflowRunInput,
} from './dimension-execution/ColdStartWorkflow.js';

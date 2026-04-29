import { runInternalDimensionExecution } from './InternalDimensionExecutionPipeline.js';

export type {
  InternalDimensionExecutionContainer as BootstrapWorkflowContainer,
  InternalDimensionExecutionContext as BootstrapWorkflowContext,
} from './InternalDimensionExecutionPipeline.js';
export { clearCheckpoints, clearSnapshots } from './InternalDimensionExecutionPipeline.js';

export const fillDimensionsV3 = runInternalDimensionExecution;
export default runInternalDimensionExecution;

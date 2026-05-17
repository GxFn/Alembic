/**
 * Compatibility exports for the internal cold-start path.
 *
 * The workflow implementation lives in the outer cold-start adapter.
 */

export { runInternalColdStartWorkflow as bootstrapKnowledge } from '../../../workflows/cold-start/internal/InternalColdStartWorkflow.js';
export { bootstrapRefine } from './bootstrap/refine.js';

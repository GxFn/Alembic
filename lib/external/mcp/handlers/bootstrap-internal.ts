/**
 * Compatibility exports for the internal cold-start path.
 *
 * The workflow implementation lives in `#workflows/cold-start/internal`.
 */

export { runInternalColdStartWorkflow as bootstrapKnowledge } from '#workflows/cold-start/internal/InternalColdStartWorkflow.js';
export { bootstrapRefine } from './bootstrap/refine.js';

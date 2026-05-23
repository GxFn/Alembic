/**
 * Alembic resident bootstrap tool handler surface.
 *
 * The long-running workflow remains in workflows/cold-start; this file gives
 * Alembic-owned CLI, daemon, and HTTP consumers a non-MCP import path.
 */

export { runInternalColdStartWorkflow as bootstrapKnowledge } from '../../workflows/cold-start/internal/InternalColdStartWorkflow.js';
export { bootstrapRefine } from './bootstrap/refine.js';

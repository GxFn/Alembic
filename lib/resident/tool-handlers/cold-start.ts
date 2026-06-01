/**
 * Alembic resident bootstrap tool handler surface.
 *
 * The long-running workflow remains in workflows/cold-start; this file gives
 * Alembic-owned CLI, daemon, and HTTP consumers a non-MCP import path.
 */

export { runColdStartWorkflow as bootstrapKnowledge } from '../../workflows/cold-start/ColdStartWorkflow.js';
export { bootstrapRefine } from './bootstrap/refine.js';

/**
 * Legacy compatibility alias.
 *
 * Alembic resident tool schema conversion now lives in
 * `lib/resident/tool-schema/zodToMcpSchema.ts`. This historical path remains
 * only for old `external/mcp` imports.
 */

export * from '../../resident/tool-schema/zodToMcpSchema.js';

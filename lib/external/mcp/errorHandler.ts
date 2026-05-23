/**
 * Legacy compatibility alias.
 *
 * Alembic resident tool error handling now lives in
 * `lib/resident/tool-schema/errorHandler.ts`. This historical path is retained
 * until old `external/mcp` imports are fully retired.
 */

export * from '../../resident/tool-schema/errorHandler.js';
export { default } from '../../resident/tool-schema/errorHandler.js';

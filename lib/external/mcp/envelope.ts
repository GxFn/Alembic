/**
 * Legacy compatibility alias.
 *
 * Alembic resident tool envelope now lives in `lib/resident/tool-schema/envelope.ts`.
 * This path remains only for historical `external/mcp` imports.
 */

export * from '../../resident/tool-schema/envelope.js';
export { default } from '../../resident/tool-schema/envelope.js';

/**
 * Legacy compatibility alias.
 *
 * Alembic resident tool declarations now live in `lib/resident/tool-schema/tools.ts`.
 * Keep this historical path until downstream imports and boundary tests no longer
 * need the `external/mcp` spelling.
 */

export * from '../../resident/tool-schema/tools.js';

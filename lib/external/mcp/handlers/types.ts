/**
 * Legacy compatibility alias.
 *
 * Resident tool handler types now live in `lib/resident/tool-schema/types.ts`.
 * The historical `Mcp*` type names remain part of the transitional contract so
 * old route/test imports do not force a broad rename in this first slice.
 */

export * from '../../../resident/tool-schema/types.js';

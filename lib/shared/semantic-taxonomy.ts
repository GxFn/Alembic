/**
 * Alembic main-repo semantic taxonomy.
 *
 * This module is intentionally internal. It gives code and tests stable names
 * for modes and lifecycle causes without changing resident MCP input schemas.
 */

export const HOST_INTENT_CONTEXT_MODES = [
  'host-intent-frame',
  'mixed-host-intent-and-legacy-args',
  'legacy-args-only',
] as const;

export type HostIntentContextMode = (typeof HOST_INTENT_CONTEXT_MODES)[number];

export const HOST_INTENT_LEGACY_COMPATIBILITY = {
  cleanupTrigger:
    'Remove legacy userQuery/activeFile/language fallback after the Plugin host-intent frame is the only current consumer input path.',
  consumer: 'alembic-plugin',
  owner: 'alembic-main',
} as const;

export type KnownSearchMode =
  | 'auto'
  | 'keyword'
  | 'weighted'
  | 'bm25'
  | 'semantic'
  | 'context'
  | 'prime'
  | 'legacy-fallback'
  | `auto(${string})`;

export type SearchModeLabel = KnownSearchMode | (string & {});

export const SEARCH_MODE_FIELD_TAXONOMY = {
  actualMode: 'The engine route that actually produced the returned search result.',
  degradedMode: 'A mode that could not satisfy its requested capability and must explain why.',
  hookMode: 'A local hook or test harness mode that must not be reported as engine execution.',
  legacyFallbackMode: 'A compatibility route used when the primary search engine is unavailable.',
  requestedMode:
    'The caller requested mode before routing, fallback, or compatibility translation.',
  runtimeMode: 'The daemon or resident runtime mode that owns process-level capability.',
} as const;

export const DEPRECATED_LIFECYCLE_CAUSES = [
  {
    cause: 'manual-curation',
    meaning: 'A developer or dashboard action intentionally retired the entry.',
  },
  {
    cause: 'evolution-decay',
    meaning: 'Automated evolution concluded the entry decayed or was superseded.',
  },
  {
    cause: 'source-orphan-cleanup',
    meaning: 'Source sync or cleanup found that the backing artifact disappeared.',
  },
] as const;

export type DeprecatedLifecycleCause = (typeof DEPRECATED_LIFECYCLE_CAUSES)[number]['cause'];

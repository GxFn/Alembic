/**
 * @module tools/v2
 *
 * Alembic Tool System V2 — 公共 API。
 *
 * 使用方式:
 *   import { ToolRouterV2, TOOL_REGISTRY } from '#tools/v2/index.js';
 */

// Cache
export { DeltaCache } from './cache/DeltaCache.js';
export { SearchCache } from './cache/SearchCache.js';
// Capabilities
export {
  BootstrapAnalyze,
  BootstrapProduce,
  CapabilityV2,
  ConversationV2,
  Evolution,
  ScanAnalyze,
  ScanProduce,
  SystemV2,
} from './capabilities/index.js';
// Compressor
export { OutputCompressor } from './compressor/OutputCompressor.js';
// Registry
export {
  generateLightweightSchemas,
  getActionNames,
  getToolNames,
  TOOL_REGISTRY,
} from './registry.js';
export type { RouterConfig } from './router.js';
// Router
export { ToolRouterV2 } from './router.js';
// Core types
export type {
  ActionHandler,
  CapabilityV2Def,
  CompressOpts,
  DeltaCacheLike,
  OutputCompressorLike,
  SearchCacheLike,
  SessionStoreLike,
  ToolAction,
  ToolCallV2,
  ToolContext,
  ToolRegistry,
  ToolResult,
  ToolResultMeta,
  ToolSpec,
} from './types.js';
export { estimateTokens, fail, ok } from './types.js';

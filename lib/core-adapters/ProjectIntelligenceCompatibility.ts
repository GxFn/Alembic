/**
 * Compatibility adapter for retired Core project-intelligence consumers.
 *
 * The old `@alembic/core/project-intelligence` facade was removed from Core.
 * Alembic still keeps a few benchmark and legacy fixture tests that exercise
 * Core discovery/AST internals directly, so the non-stable imports are
 * concentrated here and covered by the Core import-boundary adapter allowlist.
 */
export {
  analyzeFile,
  analyzeProject,
  isAvailable as isProjectAstAvailable,
} from '@alembic/core/core';
export {
  analyzeSourceFile,
  ensureProjectGrammarResources,
  loadPlugins as loadProjectAstPlugins,
} from '@alembic/core/core/ast';
export {
  CustomConfigDiscoverer,
  detectConflict,
  extractXcodeGenDependencyEdges,
  getDiscovererRegistry,
  parseBoxfile,
  parseGradleProject,
  parseModuleSpec,
  parseStarlarkBuildFile,
  parseXcodeGenProject,
  resetDiscovererRegistry,
} from '@alembic/core/core/discovery';
export { initEnhancementRegistry } from '@alembic/core/core/enhancement';
export { DimensionCopy } from '@alembic/core/dimensions';
export { LanguageService } from '@alembic/core/shared';

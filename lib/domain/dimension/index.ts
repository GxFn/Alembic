/**
 * dimension domain — 统一维度体系
 *
 * @module domain/dimension
 */

export { DimensionCopy } from './DimensionCopy.js';
export {
  buildTierPlan,
  classifyRecipeToDimension,
  DIMENSION_DISPLAY_GROUP,
  DIMENSION_REGISTRY,
  getDimension,
  getDimensionsByLayer,
  resolveActiveDimensions,
} from './DimensionRegistry.js';
export {
  getDimensionFocusKeywords,
  getDimensionSOP,
  PRE_SUBMIT_CHECKLIST,
  sopToCompactText,
} from './DimensionSop.js';
export type {
  DimensionId,
  FrameworkDimId,
  LanguageDimId,
  UnifiedDimension,
  UniversalDimId,
} from './UnifiedDimension.js';
export {
  ALL_DIMENSION_IDS,
  FRAMEWORK_DIM_IDS,
  LANGUAGE_DIM_IDS,
  UNIVERSAL_DIM_IDS,
} from './UnifiedDimension.js';

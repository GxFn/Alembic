/**
 * engineering dimension — 统一维度体系
 *
 * @module engineering/dimension
 */

export { DimensionCopy } from "./copy.js";
export {
  dimensionTags,
  isKnownDimensionId,
  recipeBelongsToDimension,
  recipeDimensionIdOrUnknown,
  recipeStorageBucket,
  resolveRecipeDimensionId,
} from "./recipe.js";
export {
  buildTierPlan,
  classifyRecipeToDimension,
  DIMENSION_DISPLAY_GROUP,
  DIMENSION_REGISTRY,
  getDimension,
  getDimensionsByLayer,
  resolveActiveDimensions,
} from "./registry.js";
export {
  getDimensionFocusKeywords,
  getDimensionSOP,
  PRE_SUBMIT_CHECKLIST,
  sopToCompactText,
} from "./sop.js";
export type {
  DimensionId,
  FrameworkDimId,
  LanguageDimId,
  UnifiedDimension,
  UniversalDimId,
} from "./unified.js";
export {
  ALL_DIMENSION_IDS,
  FRAMEWORK_DIM_IDS,
  LANGUAGE_DIM_IDS,
  UNIVERSAL_DIM_IDS,
} from "./unified.js";

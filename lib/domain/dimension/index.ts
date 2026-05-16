/**
 * dimension domain — 统一维度体系
 *
 * @module domain/dimension
 */

export { DimensionCopy } from '@alembic/core/domain/dimension/DimensionCopy';
export {
  buildTierPlan,
  classifyRecipeToDimension,
  DIMENSION_DISPLAY_GROUP,
  DIMENSION_REGISTRY,
  getDimension,
  getDimensionsByLayer,
  resolveActiveDimensions,
} from '@alembic/core/domain/dimension/DimensionRegistry';
export {
  getDimensionFocusKeywords,
  getDimensionSOP,
  PRE_SUBMIT_CHECKLIST,
  sopToCompactText,
} from '@alembic/core/domain/dimension/DimensionSop';
export {
  dimensionTags,
  isKnownDimensionId,
  recipeBelongsToDimension,
  recipeDimensionIdOrUnknown,
  recipeStorageBucket,
  resolveRecipeDimensionId,
} from '@alembic/core/domain/dimension/RecipeDimension';
export type {
  DimensionId,
  FrameworkDimId,
  LanguageDimId,
  UnifiedDimension,
  UniversalDimId,
} from '@alembic/core/domain/dimension/UnifiedDimension';
export {
  ALL_DIMENSION_IDS,
  FRAMEWORK_DIM_IDS,
  LANGUAGE_DIM_IDS,
  UNIVERSAL_DIM_IDS,
} from '@alembic/core/domain/dimension/UnifiedDimension';

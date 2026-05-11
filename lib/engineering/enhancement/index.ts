import { LEGACY_ENHANCEMENT_PACKS } from "../workflow/optional/EnhancementPackCatalog.js";
import type { EngineeringEnhancementPackDefinition } from "./EngineeringEnhancementPack.js";
import { EngineeringEnhancementPack } from "./EngineeringEnhancementPack.js";
import { EngineeringEnhancementRegistry } from "./EngineeringEnhancementRegistry.js";

export const CURRENT_ENGINEERING_ENHANCEMENT_PACKS: readonly EngineeringEnhancementPackDefinition[] =
  LEGACY_ENHANCEMENT_PACKS;

let registryInstance: EngineeringEnhancementRegistry | null = null;

export function initEngineeringEnhancementRegistry(): EngineeringEnhancementRegistry {
  if (registryInstance && registryInstance.all().length > 0) {
    return registryInstance;
  }

  registryInstance = new EngineeringEnhancementRegistry();
  for (const definition of CURRENT_ENGINEERING_ENHANCEMENT_PACKS) {
    registryInstance.register(new EngineeringEnhancementPack(definition));
  }
  return registryInstance;
}

export function getEngineeringEnhancementRegistry(): EngineeringEnhancementRegistry {
  return registryInstance ?? initEngineeringEnhancementRegistry();
}

export type {
  AstClassInfo,
  AstMethodInfo,
  AstPatternInfo,
  AstProtocolInfo,
  AstSummary,
  DetectedPattern,
  EngineeringEnhancementConditions,
  EngineeringEnhancementDimensionDefinition,
  EngineeringEnhancementGuardRuleDefinition,
  EngineeringEnhancementPackDefinition,
  ExtraDimension,
  GuardRule,
} from "./EngineeringEnhancementPack.js";
export { EngineeringEnhancementPack } from "./EngineeringEnhancementPack.js";
export { EngineeringEnhancementRegistry } from "./EngineeringEnhancementRegistry.js";

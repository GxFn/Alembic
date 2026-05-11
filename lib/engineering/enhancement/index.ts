import { ENGINEERING_ENHANCEMENT_PACKS } from "./packs/index.js";
import { EngineeringEnhancementRegistry } from "./registry.js";

export const CURRENT_ENGINEERING_ENHANCEMENT_PACKS = ENGINEERING_ENHANCEMENT_PACKS;

let registryInstance: EngineeringEnhancementRegistry | null = null;

export function initEngineeringEnhancementRegistry(): EngineeringEnhancementRegistry {
  if (registryInstance && registryInstance.all().length > 0) {
    return registryInstance;
  }

  registryInstance = new EngineeringEnhancementRegistry();
  for (const pack of CURRENT_ENGINEERING_ENHANCEMENT_PACKS) {
    registryInstance.register(pack);
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
  ExtraDimension,
  GuardRule,
  PreprocessedEnhancementFile,
} from "./pack.js";
export { EngineeringEnhancementPack, EnhancementPack } from "./pack.js";
export { ENGINEERING_ENHANCEMENT_PACKS } from "./packs/index.js";
export { EngineeringEnhancementRegistry, EnhancementRegistry } from "./registry.js";

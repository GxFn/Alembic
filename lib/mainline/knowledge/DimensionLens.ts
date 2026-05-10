import type { EvidencePackage } from "./EvidencePackage.js";

/**
 * DimensionLens 是挖掘镜头，不是永久分类法。
 * 编译期可以根据证据激活镜头，但真正持久的知识对象仍然是 Recipe 和 RecipeEdge。
 */
export type CoreDimensionLensId =
  | "project-shape"
  | "coding-contract"
  | "agent-guidelines"
  | "quality-safety"
  | "recipe-relations";

export type ConditionalDimensionLensId =
  | "ui-interaction"
  | "networking-api"
  | "persistence-data"
  | "concurrency-async"
  | "security-auth"
  | "performance"
  | "observability"
  | "release-deploy";

export type DimensionLensId = CoreDimensionLensId | ConditionalDimensionLensId | string;

export interface DimensionLensActivation {
  lensId: DimensionLensId;
  reason: string;
  confidence: number;
}

export interface DimensionLens {
  id: DimensionLensId;
  title: string;
  core: boolean;
  appliesTo(evidencePackage: EvidencePackage): DimensionLensActivation | null;
}

import type { SourceRef } from "./SourceRef.js";

/**
 * EvidencePackage 是编译期的交接对象。
 * 它避免扫描器、diff reader、Guard feedback、手动 capture
 * 各自发明一套不同的 payload 形态。
 */
export type EvidenceOrigin = "snapshot" | "diff" | "guard" | "capture" | "manual";

export interface EvidencePackage {
  id: string;
  origin: EvidenceOrigin;
  projectRoot: string;
  changedFiles: string[];
  sourceRefs: SourceRef[];
  notes: string[];
  createdAt: number;
  metadata?: Record<string, unknown> | undefined;
}

export interface EvidencePackageInput {
  id: string;
  origin: EvidenceOrigin;
  projectRoot: string;
  changedFiles?: readonly string[] | undefined;
  sourceRefs?: readonly SourceRef[] | undefined;
  notes?: readonly string[] | undefined;
  createdAt: number;
  metadata?: Record<string, unknown> | undefined;
}

/** 对 changed files 去重，同时保留原始 evidence refs。 */
export function createEvidencePackage(input: EvidencePackageInput): EvidencePackage {
  return {
    id: input.id,
    origin: input.origin,
    projectRoot: input.projectRoot,
    changedFiles: [...new Set(input.changedFiles ?? [])],
    sourceRefs: [...(input.sourceRefs ?? [])],
    notes: [...(input.notes ?? [])],
    createdAt: input.createdAt,
    metadata: input.metadata,
  };
}

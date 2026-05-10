import { epochSecondsNow } from "../core/time.js";
import { createEvidencePackage, type EvidencePackage, type SourceRef } from "../knowledge/index.js";

export interface BuildEvidencePackageRequest {
  readonly id: string;
  readonly projectRoot: string;
  readonly changedFiles?: readonly string[];
  readonly sourceRefs?: readonly SourceRef[];
  readonly notes?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

/**
 * EvidencePackageBuilder 是原始项目材料进入编译期的入口。
 * 中文注释：它不挖掘 Recipe，不调用 AI，只把 scanner/diff/manual capture
 * 归一成后续 miner 可以消费的 EvidencePackage。
 */
export class EvidencePackageBuilder {
  buildSnapshot(request: BuildEvidencePackageRequest): EvidencePackage {
    return createEvidencePackage({
      id: request.id,
      origin: "snapshot",
      projectRoot: request.projectRoot,
      changedFiles: request.changedFiles,
      sourceRefs: request.sourceRefs,
      notes: request.notes,
      createdAt: epochSecondsNow(),
      metadata: request.metadata,
    });
  }

  buildDiff(request: BuildEvidencePackageRequest): EvidencePackage {
    return createEvidencePackage({
      id: request.id,
      origin: "diff",
      projectRoot: request.projectRoot,
      changedFiles: request.changedFiles,
      sourceRefs: request.sourceRefs,
      notes: request.notes,
      createdAt: epochSecondsNow(),
      metadata: request.metadata,
    });
  }
}

import type {
  SourceRefReconcileReport,
  SourceRefRenameCandidate,
} from "./SourceRefReconcileReport.js";

export interface SourceRefRepairPlanOptions {
  readonly minConfidence?: number;
}

export interface SourceRefRepairRename {
  readonly sourceRefId: string;
  readonly candidateSourceRefId: string;
  readonly recipeIds: readonly string[];
  readonly oldPath: string;
  readonly newPath: string;
  readonly confidence: number;
  readonly reason: string;
}

export interface SourceRefRepairSkipped {
  readonly sourceRefId: string;
  readonly reason: "low-confidence" | "ambiguous" | "same-path" | "missing-path";
  readonly candidates: readonly SourceRefRenameCandidate[];
}

export interface SourceRefRepairPlan {
  readonly renames: readonly SourceRefRepairRename[];
  readonly skipped: readonly SourceRefRepairSkipped[];
  readonly summary: {
    readonly candidateCount: number;
    readonly renameCount: number;
    readonly skippedCount: number;
    readonly highConfidenceCount: number;
    readonly mediumConfidenceCount: number;
  };
}

const DEFAULT_MIN_CONFIDENCE = 0.65;

/**
 * 把 SourceRefReconcileReporter 的 rename 候选收敛成显式修复计划。
 * 这里仍然不写 Recipe/Markdown，只选出可以交给 repairer 的高置信路径替换。
 */
export function buildMainlineSourceRefRepairPlan(
  report: SourceRefReconcileReport,
  options: SourceRefRepairPlanOptions = {},
): SourceRefRepairPlan {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const bySourceRef = groupRenameCandidates(report.renamedCandidates);
  const renames: SourceRefRepairRename[] = [];
  const skipped: SourceRefRepairSkipped[] = [];

  for (const [sourceRefId, candidates] of bySourceRef) {
    const sorted = [...candidates].sort(compareRenameCandidates);
    const best = sorted[0];
    if (!best?.oldPath || !best.newPath) {
      skipped.push({ sourceRefId, reason: "missing-path", candidates: sorted });
      continue;
    }
    if (best.oldPath === best.newPath) {
      skipped.push({ sourceRefId, reason: "same-path", candidates: sorted });
      continue;
    }
    if (best.confidence < minConfidence) {
      skipped.push({ sourceRefId, reason: "low-confidence", candidates: sorted });
      continue;
    }
    if (isAmbiguous(best, sorted[1])) {
      skipped.push({ sourceRefId, reason: "ambiguous", candidates: sorted });
      continue;
    }

    renames.push({
      sourceRefId: best.sourceRefId,
      candidateSourceRefId: best.candidateSourceRefId,
      recipeIds: [...new Set(best.recipeIds)].sort(),
      oldPath: best.oldPath,
      newPath: best.newPath,
      confidence: best.confidence,
      reason: best.reason,
    });
  }

  return {
    renames: renames.sort(
      (left, right) =>
        right.confidence - left.confidence || left.sourceRefId.localeCompare(right.sourceRefId),
    ),
    skipped: skipped.sort((left, right) => left.sourceRefId.localeCompare(right.sourceRefId)),
    summary: {
      candidateCount: report.renamedCandidates.length,
      renameCount: renames.length,
      skippedCount: skipped.length,
      highConfidenceCount: renames.filter((rename) => rename.confidence >= 0.9).length,
      mediumConfidenceCount: renames.filter(
        (rename) => rename.confidence >= 0.65 && rename.confidence < 0.9,
      ).length,
    },
  };
}

function groupRenameCandidates(
  candidates: readonly SourceRefRenameCandidate[],
): Map<string, SourceRefRenameCandidate[]> {
  const bySourceRef = new Map<string, SourceRefRenameCandidate[]>();
  for (const candidate of candidates) {
    bySourceRef.set(candidate.sourceRefId, [
      ...(bySourceRef.get(candidate.sourceRefId) ?? []),
      candidate,
    ]);
  }
  return bySourceRef;
}

function isAmbiguous(
  best: SourceRefRenameCandidate,
  next: SourceRefRenameCandidate | undefined,
): boolean {
  return Boolean(next && next.newPath !== best.newPath && next.confidence === best.confidence);
}

function compareRenameCandidates(
  left: SourceRefRenameCandidate,
  right: SourceRefRenameCandidate,
): number {
  return (
    right.confidence - left.confidence ||
    left.newPath.localeCompare(right.newPath) ||
    left.candidateSourceRefId.localeCompare(right.candidateSourceRefId)
  );
}

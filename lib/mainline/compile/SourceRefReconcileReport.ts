import type { ContextIndexSnapshot } from "../data/index.js";
import type { MainlineProjectIntelligenceArtifact } from "../graph/index.js";
import type { Recipe, SourceRef } from "../knowledge/index.js";
import { sourceRefsFromProjectIntelligence } from "./ProjectIntelligenceMaterializer.js";

export interface SourceRefReconcileInput {
  readonly recipes?: readonly Recipe[];
  readonly sourceRefs?: readonly SourceRef[];
  readonly projectIntelligence?: MainlineProjectIntelligenceArtifact;
  readonly contextSnapshot?: Partial<ContextIndexSnapshot>;
}

export interface SourceRefReconcileFinding {
  readonly sourceRefId: string;
  readonly recipeIds: string[];
  readonly path?: string;
  readonly symbol?: string;
  readonly reason: string;
}

export interface SourceRefRenameCandidate {
  readonly sourceRefId: string;
  readonly candidateSourceRefId: string;
  readonly recipeIds: string[];
  readonly oldPath?: string;
  readonly newPath: string;
  readonly confidence: number;
  readonly reason: string;
}

export interface SourceRefReconcileReport {
  readonly recipeCount: number;
  readonly sourceRefCount: number;
  readonly missing: SourceRefReconcileFinding[];
  readonly stale: SourceRefReconcileFinding[];
  readonly renamedCandidates: SourceRefRenameCandidate[];
}

/**
 * SourceRefReconcileReporter 只做主线编译期报告，不删除用户文件，也不改 Recipe。
 * 它把 Recipe 引用、已编译 SourceRef 和 ProjectIntelligence 事实轻量对齐。
 */
export class SourceRefReconcileReporter {
  report(input: SourceRefReconcileInput): SourceRefReconcileReport {
    const recipes = uniqueRecipes([
      ...(input.contextSnapshot?.recipes ?? []),
      ...(input.recipes ?? []),
    ]);
    const sourceRefs = uniqueSourceRefs([
      ...(input.contextSnapshot?.sourceRefs ?? []),
      ...(input.sourceRefs ?? []),
    ]);
    const currentSourceRefs = input.projectIntelligence
      ? sourceRefsFromProjectIntelligence(input.projectIntelligence)
      : [];
    const knownSourceRefById = new Map(sourceRefs.map((sourceRef) => [sourceRef.id, sourceRef]));
    const currentSourceRefById = new Map(
      currentSourceRefs.map((sourceRef) => [sourceRef.id, sourceRef]),
    );
    const currentPaths = new Set(currentSourceRefs.map((sourceRef) => sourceRef.location.path));
    const recipeIdsBySourceRefId = collectRecipeIdsBySourceRefId(recipes);

    const missing = new Map<string, SourceRefReconcileFinding>();
    const stale = new Map<string, SourceRefReconcileFinding>();

    for (const [sourceRefId, recipeIds] of recipeIdsBySourceRefId) {
      const sourceRef = knownSourceRefById.get(sourceRefId);
      if (!sourceRef) {
        missing.set(
          sourceRefId,
          finding(
            sourceRefId,
            recipeIds,
            undefined,
            "Recipe references a SourceRef that is not compiled.",
          ),
        );
        continue;
      }
      if (sourceRef.status === "missing") {
        missing.set(
          sourceRefId,
          finding(sourceRefId, recipeIds, sourceRef, "SourceRef status is missing."),
        );
        continue;
      }
      if (isStale(sourceRef, currentSourceRefById, currentPaths)) {
        stale.set(sourceRefId, finding(sourceRefId, recipeIds, sourceRef, staleReason(sourceRef)));
      }
    }

    for (const sourceRef of sourceRefs) {
      if (!recipeIdsBySourceRefId.has(sourceRef.id) && sourceRef.status !== "missing") {
        continue;
      }
      if (sourceRef.status === "missing") {
        missing.set(
          sourceRef.id,
          finding(
            sourceRef.id,
            recipeIdsBySourceRefId.get(sourceRef.id) ?? [],
            sourceRef,
            "SourceRef status is missing.",
          ),
        );
      } else if (sourceRef.status === "stale") {
        stale.set(
          sourceRef.id,
          finding(
            sourceRef.id,
            recipeIdsBySourceRefId.get(sourceRef.id) ?? [],
            sourceRef,
            "SourceRef status is stale.",
          ),
        );
      }
    }

    const renamedCandidates = [...missing.values(), ...stale.values()]
      .flatMap((entry) => renameCandidatesFor(entry, knownSourceRefById, currentSourceRefs))
      .sort(
        (left, right) =>
          right.confidence - left.confidence ||
          left.sourceRefId.localeCompare(right.sourceRefId) ||
          left.candidateSourceRefId.localeCompare(right.candidateSourceRefId),
      );

    return {
      recipeCount: recipes.length,
      sourceRefCount: sourceRefs.length,
      missing: [...missing.values()].sort(compareFindings),
      stale: [...stale.values()].sort(compareFindings),
      renamedCandidates,
    };
  }
}

function collectRecipeIdsBySourceRefId(recipes: readonly Recipe[]): Map<string, string[]> {
  const recipeIdsBySourceRefId = new Map<string, string[]>();
  for (const recipe of recipes) {
    for (const sourceRefId of recipe.sourceRefIds) {
      const recipeIds = recipeIdsBySourceRefId.get(sourceRefId) ?? [];
      recipeIds.push(recipe.id);
      recipeIdsBySourceRefId.set(sourceRefId, recipeIds);
    }
  }
  return recipeIdsBySourceRefId;
}

function isStale(
  sourceRef: SourceRef,
  currentSourceRefById: ReadonlyMap<string, SourceRef>,
  currentPaths: ReadonlySet<string>,
): boolean {
  if (sourceRef.status === "stale" || sourceRef.status === "unknown") {
    return true;
  }
  const current = currentSourceRefById.get(sourceRef.id);
  if (
    current?.contentHash &&
    sourceRef.contentHash &&
    current.contentHash !== sourceRef.contentHash
  ) {
    return true;
  }
  return currentPaths.size > 0 && !currentPaths.has(sourceRef.location.path);
}

function staleReason(sourceRef: SourceRef): string {
  if (sourceRef.status === "stale") {
    return "SourceRef status is stale.";
  }
  if (sourceRef.status === "unknown") {
    return "SourceRef has not been verified.";
  }
  return "SourceRef does not match current ProjectIntelligence facts.";
}

function finding(
  sourceRefId: string,
  recipeIds: readonly string[],
  sourceRef: SourceRef | undefined,
  reason: string,
): SourceRefReconcileFinding {
  return {
    sourceRefId,
    recipeIds: [...new Set(recipeIds)].sort(),
    ...(sourceRef?.location.path === undefined ? {} : { path: sourceRef.location.path }),
    ...(sourceRef?.location.symbol === undefined ? {} : { symbol: sourceRef.location.symbol }),
    reason,
  };
}

function renameCandidatesFor(
  finding: SourceRefReconcileFinding,
  knownSourceRefById: ReadonlyMap<string, SourceRef>,
  currentSourceRefs: readonly SourceRef[],
): SourceRefRenameCandidate[] {
  const sourceRef = knownSourceRefById.get(finding.sourceRefId);
  if (!sourceRef || currentSourceRefs.length === 0) {
    return [];
  }
  const oldPath = stringMetadata(sourceRef.metadata, "oldPath") ?? sourceRef.location.path;
  const symbol = sourceRef.location.symbol;
  const candidates = currentSourceRefs.flatMap((candidate) => {
    if (candidate.id === sourceRef.id) {
      return [];
    }
    const confidence = renameConfidence(sourceRef, candidate, oldPath, symbol);
    if (confidence <= 0) {
      return [];
    }
    return [
      {
        sourceRefId: sourceRef.id,
        candidateSourceRefId: candidate.id,
        recipeIds: finding.recipeIds,
        oldPath,
        newPath: candidate.location.path,
        confidence,
        reason:
          confidence >= 0.9
            ? "SourceRef metadata.oldPath matches a current ProjectIntelligence path."
            : "SourceRef has a likely path or symbol rename candidate.",
      },
    ];
  });
  return candidates.sort((left, right) => right.confidence - left.confidence).slice(0, 3);
}

function renameConfidence(
  sourceRef: SourceRef,
  candidate: SourceRef,
  oldPath: string,
  symbol: string | undefined,
): number {
  if (stringMetadata(candidate.metadata, "oldPath") === oldPath) {
    return 0.95;
  }
  if (symbol && candidate.location.symbol === symbol) {
    return 0.85;
  }
  if (basename(sourceRef.location.path) === basename(candidate.location.path)) {
    return 0.65;
  }
  return 0;
}

function uniqueRecipes(recipes: readonly Recipe[]): Recipe[] {
  return [...new Map(recipes.map((recipe) => [recipe.id, recipe])).values()];
}

function uniqueSourceRefs(sourceRefs: readonly SourceRef[]): SourceRef[] {
  return [...new Map(sourceRefs.map((sourceRef) => [sourceRef.id, sourceRef])).values()];
}

function stringMetadata(
  metadata: SourceRef["metadata"] | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function basename(filePath: string): string {
  const index = filePath.lastIndexOf("/");
  return index >= 0 ? filePath.slice(index + 1) : filePath;
}

function compareFindings(
  left: SourceRefReconcileFinding,
  right: SourceRefReconcileFinding,
): number {
  return left.sourceRefId.localeCompare(right.sourceRefId);
}

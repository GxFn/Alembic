import { normalizeMainlinePosixPath, uniqueMainlinePosixPaths } from "../core/index.js";
import {
  createSourceRef,
  type Recipe,
  type SourceRef,
  type SourceRefInput,
} from "../knowledge/index.js";

export interface MainlineSourceRefMovedFile {
  readonly fromPath: string;
  readonly toPath: string;
  readonly contentHash?: string;
}

export type MainlineSourceRefRepairReason = "file-moved" | "file-removed";

export type MainlineSourceRefRepairAction = "mark-repaired" | "mark-stale";

export interface MainlineSourceRefRepairPlanItem {
  readonly recipeId: string;
  readonly recipeTitle: string;
  readonly sourceRefId: string;
  readonly previousPath: string;
  readonly action: MainlineSourceRefRepairAction;
  readonly status: SourceRef["status"];
  readonly reason: MainlineSourceRefRepairReason;
  readonly nextPath?: string;
}

export interface MainlineSourceRefRepairPlanSummary {
  readonly movedFileCount: number;
  readonly removedFileCount: number;
  readonly repairedSourceRefCount: number;
  readonly staleSourceRefCount: number;
  readonly affectedRecipeCount: number;
}

export interface MainlineSourceRefRepairPlan {
  readonly movedFiles: readonly MainlineSourceRefMovedFile[];
  readonly removedFiles: readonly string[];
  readonly repairs: readonly MainlineSourceRefRepairPlanItem[];
  readonly sourceRefs: readonly SourceRef[];
  readonly summary: MainlineSourceRefRepairPlanSummary;
  readonly warnings: readonly string[];
}

export interface RecipePathRepairerRequest {
  readonly recipes: readonly Recipe[];
  readonly sourceRefs?: readonly SourceRef[];
  readonly movedFiles?: readonly MainlineSourceRefMovedFile[];
  readonly removedFiles?: readonly string[];
  readonly generatedAt?: number;
}

/**
 * RecipePathRepairer 只生成 SourceRef 修复计划。
 * 中文注释：SourceRef repair 属于增量编译链路，它不会发布 active Recipe，
 * 也不会把移动/删除文件自动写成可运行知识；上层必须显式审查 repair plan。
 */
export class RecipePathRepairer {
  plan(request: RecipePathRepairerRequest): MainlineSourceRefRepairPlan {
    const movedFiles = normalizeMovedFiles(request.movedFiles ?? []);
    const movedByFrom = new Map(movedFiles.map((move) => [move.fromPath, move]));
    const movedFromPaths = new Set(movedFiles.map((move) => move.fromPath));
    const removedFiles = uniqueMainlinePosixPaths(request.removedFiles ?? []).filter(
      (filePath) => !movedFromPaths.has(filePath),
    );
    const removedSet = new Set(removedFiles);
    const sourceRefById = new Map(
      (request.sourceRefs ?? []).map((sourceRef) => [sourceRef.id, sourceRef]),
    );
    const repairedSourceRefs = new Map<string, SourceRef>();
    const repairs: MainlineSourceRefRepairPlanItem[] = [];
    const warnings: string[] = [];

    for (const recipe of request.recipes) {
      if (!isRepairTrackableRecipe(recipe)) {
        continue;
      }

      for (const sourceRefId of recipe.sourceRefIds) {
        const sourceRef = sourceRefById.get(sourceRefId);
        const previousPath = sourceRefPathForRecipeRef(sourceRefId, sourceRef);
        if (!previousPath) {
          warnings.push(`SourceRef ${sourceRefId} on Recipe ${recipe.id} has no repairable path.`);
          continue;
        }

        const movedFile = movedByFrom.get(previousPath);
        if (movedFile) {
          const repaired = repairedSourceRef({
            sourceRefId,
            sourceRef,
            previousPath,
            movedFile,
            ...(request.generatedAt === undefined ? {} : { generatedAt: request.generatedAt }),
          });
          repairedSourceRefs.set(repaired.id, repaired);
          repairs.push({
            recipeId: recipe.id,
            recipeTitle: recipe.title,
            sourceRefId,
            previousPath,
            nextPath: movedFile.toPath,
            action: "mark-repaired",
            status: "repaired",
            reason: "file-moved",
          });
          continue;
        }

        if (removedSet.has(previousPath)) {
          const stale = staleSourceRef({
            sourceRefId,
            sourceRef,
            previousPath,
            ...(request.generatedAt === undefined ? {} : { generatedAt: request.generatedAt }),
          });
          repairedSourceRefs.set(stale.id, stale);
          repairs.push({
            recipeId: recipe.id,
            recipeTitle: recipe.title,
            sourceRefId,
            previousPath,
            action: "mark-stale",
            status: "stale",
            reason: "file-removed",
          });
        }
      }
    }

    const sortedRepairs = [...repairs].sort(compareRepairItems);
    const sortedSourceRefs = [...repairedSourceRefs.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );

    return {
      movedFiles,
      removedFiles,
      repairs: sortedRepairs,
      sourceRefs: sortedSourceRefs,
      summary: summarizeRepairPlan(movedFiles, removedFiles, sortedRepairs),
      warnings: uniqueStrings(warnings),
    };
  }
}

export function createEmptyMainlineSourceRefRepairPlan(): MainlineSourceRefRepairPlan {
  return {
    movedFiles: [],
    removedFiles: [],
    repairs: [],
    sourceRefs: [],
    summary: {
      movedFileCount: 0,
      removedFileCount: 0,
      repairedSourceRefCount: 0,
      staleSourceRefCount: 0,
      affectedRecipeCount: 0,
    },
    warnings: [],
  };
}

export function mainlineSourceRefPathFromId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return null;
  }
  if (trimmed.startsWith("symbol:")) {
    const body = trimmed.slice("symbol:".length);
    const separator = body.includes("::") ? body.indexOf("::") : body.indexOf("#");
    return separator > 0 ? normalizeMainlinePosixPath(body.slice(0, separator)) : null;
  }
  const withoutPrefix = trimmed.replace(/^(file|diff):/, "");
  const withoutLine = withoutPrefix.replace(/:\d+(?::\d+)?$/, "");
  const withoutHash = withoutLine.replace(/#.+$/, "");
  return withoutHash ? normalizeMainlinePosixPath(withoutHash) : null;
}

function sourceRefPathForRecipeRef(
  sourceRefId: string,
  sourceRef: SourceRef | undefined,
): string | null {
  return sourceRef?.location.path
    ? normalizeMainlinePosixPath(sourceRef.location.path)
    : mainlineSourceRefPathFromId(sourceRefId);
}

function repairedSourceRef(input: {
  readonly sourceRefId: string;
  readonly sourceRef: SourceRef | undefined;
  readonly previousPath: string;
  readonly movedFile: MainlineSourceRefMovedFile;
  readonly generatedAt?: number;
}): SourceRef {
  return createSourceRef(
    sourceRefInput({
      sourceRefId: input.sourceRefId,
      sourceRef: input.sourceRef,
      path: input.movedFile.toPath,
      status: "repaired",
      summary:
        input.sourceRef?.summary ??
        `SourceRef repaired from ${input.previousPath} to ${input.movedFile.toPath}`,
      repairMetadata: {
        reason: "file-moved",
        previousPath: input.previousPath,
        nextPath: input.movedFile.toPath,
        contentHash: input.movedFile.contentHash,
        generatedAt: input.generatedAt,
      },
    }),
  );
}

function staleSourceRef(input: {
  readonly sourceRefId: string;
  readonly sourceRef: SourceRef | undefined;
  readonly previousPath: string;
  readonly generatedAt?: number;
}): SourceRef {
  return createSourceRef(
    sourceRefInput({
      sourceRefId: input.sourceRefId,
      sourceRef: input.sourceRef,
      path: input.previousPath,
      status: "stale",
      summary:
        input.sourceRef?.summary ?? `SourceRef stale after ${input.previousPath} was removed`,
      repairMetadata: {
        reason: "file-removed",
        previousPath: input.previousPath,
        generatedAt: input.generatedAt,
      },
    }),
  );
}

function sourceRefInput(input: {
  readonly sourceRefId: string;
  readonly sourceRef: SourceRef | undefined;
  readonly path: string;
  readonly status: SourceRef["status"];
  readonly summary: string;
  readonly repairMetadata: Record<string, unknown>;
}): SourceRefInput {
  const metadata = {
    ...(input.sourceRef?.metadata ?? {}),
    sourceRefRepair: compactRecord(input.repairMetadata),
  };
  return {
    id: input.sourceRefId,
    kind: input.sourceRef?.kind ?? "file",
    path: input.path,
    status: input.status,
    summary: input.summary,
    contentHash: input.sourceRef?.contentHash,
    metadata,
    ...(input.sourceRef?.location.startLine === undefined
      ? {}
      : { startLine: input.sourceRef.location.startLine }),
    ...(input.sourceRef?.location.endLine === undefined
      ? {}
      : { endLine: input.sourceRef.location.endLine }),
    ...(input.sourceRef?.location.symbol === undefined
      ? {}
      : { symbol: input.sourceRef.location.symbol }),
  };
}

function normalizeMovedFiles(
  movedFiles: readonly MainlineSourceRefMovedFile[],
): MainlineSourceRefMovedFile[] {
  const byFrom = new Map<string, MainlineSourceRefMovedFile>();
  for (const movedFile of movedFiles) {
    const fromPath = normalizeMainlinePosixPath(movedFile.fromPath);
    const toPath = normalizeMainlinePosixPath(movedFile.toPath);
    if (!fromPath || !toPath || byFrom.has(fromPath)) {
      continue;
    }
    byFrom.set(fromPath, {
      fromPath,
      toPath,
      ...(movedFile.contentHash === undefined ? {} : { contentHash: movedFile.contentHash }),
    });
  }
  return [...byFrom.values()].sort(
    (left, right) =>
      left.fromPath.localeCompare(right.fromPath) || left.toPath.localeCompare(right.toPath),
  );
}

function summarizeRepairPlan(
  movedFiles: readonly MainlineSourceRefMovedFile[],
  removedFiles: readonly string[],
  repairs: readonly MainlineSourceRefRepairPlanItem[],
): MainlineSourceRefRepairPlanSummary {
  return {
    movedFileCount: movedFiles.length,
    removedFileCount: removedFiles.length,
    repairedSourceRefCount: repairs.filter((repair) => repair.status === "repaired").length,
    staleSourceRefCount: repairs.filter((repair) => repair.status === "stale").length,
    affectedRecipeCount: new Set(repairs.map((repair) => repair.recipeId)).size,
  };
}

function isRepairTrackableRecipe(recipe: Recipe): boolean {
  return recipe.status === "active" || recipe.status === "candidate";
}

function compareRepairItems(
  left: MainlineSourceRefRepairPlanItem,
  right: MainlineSourceRefRepairPlanItem,
): number {
  return (
    left.recipeId.localeCompare(right.recipeId) ||
    left.sourceRefId.localeCompare(right.sourceRefId) ||
    left.previousPath.localeCompare(right.previousPath)
  );
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, unknown] => entry[1] !== undefined),
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

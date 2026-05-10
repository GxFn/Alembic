import { normalizeMainlinePosixPath, uniqueMainlinePosixPaths } from "../core/index.js";
import type {
  MainlineFileFingerprintSnapshot,
  MainlineFileFingerprintSnapshotDiff,
} from "../data/index.js";
import type { Recipe, SourceRef } from "../knowledge/index.js";
import type { MainlineProjectIntelligenceIncrementalPlan } from "./ProjectIntelligenceIncrementalPlanner.js";
import {
  createEmptyMainlineSourceRefRepairPlan,
  type MainlineSourceRefMovedFile,
  type MainlineSourceRefRepairPlan,
  RecipePathRepairer,
} from "./RecipePathRepairer.js";

export interface SourceRefRepairServiceRequest {
  readonly recipes: readonly Recipe[];
  readonly sourceRefs?: readonly SourceRef[];
  readonly fingerprintDiff?: MainlineFileFingerprintSnapshotDiff;
  readonly previousFingerprintSnapshot?: MainlineFileFingerprintSnapshot;
  readonly currentFingerprintSnapshot?: MainlineFileFingerprintSnapshot;
  readonly incrementalPlan?: MainlineProjectIntelligenceIncrementalPlan;
  readonly movedFiles?: readonly MainlineSourceRefMovedFile[];
  readonly removedFiles?: readonly string[];
  readonly generatedAt?: number;
}

export interface SourceRefMoveDetectionRequest {
  readonly fingerprintDiff?: MainlineFileFingerprintSnapshotDiff;
  readonly previousFingerprintSnapshot?: MainlineFileFingerprintSnapshot | null;
  readonly currentFingerprintSnapshot?: MainlineFileFingerprintSnapshot | null;
}

/**
 * SourceRefRepairService 是增量编译的薄编排层。
 * 中文注释：它只把指纹 diff、ProjectIntelligence 增量计划和 Recipe SourceRef
 * 汇总成 repair plan；不会修改 Recipe 状态，也不会发布 active Recipe。
 */
export class SourceRefRepairService {
  readonly #repairer: RecipePathRepairer;

  constructor(repairer: RecipePathRepairer = new RecipePathRepairer()) {
    this.#repairer = repairer;
  }

  repair(request: SourceRefRepairServiceRequest): MainlineSourceRefRepairPlan {
    if (request.recipes.length === 0) {
      return createEmptyMainlineSourceRefRepairPlan();
    }

    const detectedMoves = detectMainlineSourceRefMovedFiles(request);
    const movedFiles = mergeMovedFiles([
      ...(request.incrementalPlan?.movedFiles ?? []),
      ...(request.movedFiles ?? []),
      ...detectedMoves,
    ]);
    const movedFromPaths = new Set(movedFiles.map((move) => move.fromPath));
    const removedFiles = uniqueMainlinePosixPaths([
      ...(request.incrementalPlan?.deletedFiles ?? []),
      ...(request.fingerprintDiff?.deleted ?? []),
      ...(request.removedFiles ?? []),
    ]).filter((filePath) => !movedFromPaths.has(filePath));

    return this.#repairer.plan({
      recipes: request.recipes,
      sourceRefs: request.sourceRefs ?? [],
      movedFiles,
      removedFiles,
      ...(request.generatedAt === undefined ? {} : { generatedAt: request.generatedAt }),
    });
  }
}

export function detectMainlineSourceRefMovedFiles(
  request: SourceRefMoveDetectionRequest,
): MainlineSourceRefMovedFile[] {
  const previous = request.previousFingerprintSnapshot?.files;
  const current = request.currentFingerprintSnapshot?.files;
  const diff = request.fingerprintDiff;
  if (!previous || !current || !diff) {
    return [];
  }

  const addedByHash = pathsByHash(diff.added, current);
  const deletedByHash = pathsByHash(diff.deleted, previous);
  const movedFiles: MainlineSourceRefMovedFile[] = [];

  for (const oldPath of uniqueMainlinePosixPaths(diff.deleted)) {
    const contentHash = previous[oldPath];
    if (!contentHash) {
      continue;
    }
    const addedPaths = addedByHash.get(contentHash) ?? [];
    const deletedPaths = deletedByHash.get(contentHash) ?? [];
    if (addedPaths.length !== 1 || deletedPaths.length !== 1) {
      continue;
    }
    const newPath = addedPaths[0];
    if (!newPath) {
      continue;
    }
    movedFiles.push({
      fromPath: normalizeMainlinePosixPath(oldPath),
      toPath: normalizeMainlinePosixPath(newPath),
      contentHash,
    });
  }

  return mergeMovedFiles(movedFiles);
}

function pathsByHash(
  paths: readonly string[],
  files: Record<string, string>,
): Map<string, string[]> {
  const byHash = new Map<string, string[]>();
  for (const rawPath of paths) {
    const filePath = normalizeMainlinePosixPath(rawPath);
    const contentHash = files[filePath];
    if (!contentHash) {
      continue;
    }
    byHash.set(contentHash, [...(byHash.get(contentHash) ?? []), filePath].sort());
  }
  return byHash;
}

function mergeMovedFiles(
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

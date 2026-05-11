import type { EngineeringWorkflowFileDiff } from "../cache/EngineeringWorkflowCacheTypes.js";
import {
  isSameWorkflowSnapshotPath,
  moduleNameForWorkflowPath,
  normalizeWorkflowProjectRoot,
  toWorkflowPosixPath,
} from "../cache/EngineeringWorkflowPathUtils.js";
import { changedFileCount } from "../cache/FileDiffPlanner.js";
import type {
  EngineeringWorkflowIncrementalPlan,
  EngineeringWorkflowIncrementalPlannerInput,
} from "./EngineeringWorkflowIncrementalTypes.js";

export const ENGINEERING_WORKFLOW_FULL_RESCAN_THRESHOLD = 0.5;

export class EngineeringProjectIntelligenceIncrementalPlanner {
  plan(input: EngineeringWorkflowIncrementalPlannerInput): EngineeringWorkflowIncrementalPlan {
    return planEngineeringProjectIntelligenceIncremental(input);
  }
}

export function planEngineeringProjectIntelligenceIncremental(
  input: EngineeringWorkflowIncrementalPlannerInput,
): EngineeringWorkflowIncrementalPlan {
  const diagnostics = [...(input.diff?.diagnostics ?? [])];
  const allDimensions = [...input.allDimensions];

  if (!input.snapshot || !input.diff) {
    return {
      mode: "full-rescan",
      reason: "无历史快照，需要全量冷启动",
      baselineSnapshotId: null,
      affectedFiles: [],
      affectedModules: [],
      affectedDimensions: allDimensions,
      skippedDimensions: [],
      diagnostics,
      diff: input.diff,
    };
  }

  if (
    normalizeWorkflowProjectRoot(input.snapshot.projectRoot) !==
      normalizeWorkflowProjectRoot(input.projectRoot) ||
    diagnostics.some((diagnostic) => diagnostic.code === "project_root_mismatch")
  ) {
    return {
      mode: "full-rescan",
      reason: "历史快照 projectRoot 与当前项目不一致，回退全量冷启动",
      baselineSnapshotId: input.snapshot.id,
      affectedFiles: allChangedFiles(input.diff),
      affectedModules: affectedModulesForDiff(input.diff),
      affectedDimensions: allDimensions,
      skippedDimensions: [],
      diagnostics,
      diff: input.diff,
    };
  }

  const changedCount = changedFileCount(input.diff);
  if (changedCount === 0) {
    return {
      mode: "skip",
      reason: "无文件变更，所有工程维度使用历史结果",
      baselineSnapshotId: input.snapshot.id,
      affectedFiles: [],
      affectedModules: [],
      affectedDimensions: [],
      skippedDimensions: allDimensions,
      diagnostics,
      diff: input.diff,
    };
  }

  const affectedFiles = allChangedFiles(input.diff);
  const affectedModules = affectedModulesForDiff(input.diff);
  const contentChangeCount =
    input.diff.added.length + input.diff.modified.length + input.diff.deleted.length;

  if (contentChangeCount === 0 && input.diff.moved.length > 0) {
    return {
      mode: "panorama-only",
      reason: `${input.diff.moved.length} 个文件移动仅影响工程全景与模块归属`,
      baselineSnapshotId: input.snapshot.id,
      affectedFiles,
      affectedModules,
      affectedDimensions: [],
      skippedDimensions: allDimensions,
      diagnostics,
      diff: input.diff,
    };
  }

  const threshold = input.fullRescanThreshold ?? ENGINEERING_WORKFLOW_FULL_RESCAN_THRESHOLD;
  if (input.diff.changeRatio > threshold) {
    return {
      mode: "full-rescan",
      reason: `变更比例 ${(input.diff.changeRatio * 100).toFixed(0)}% 超过阈值 (${(
        threshold * 100
      ).toFixed(0)}%)，建议全量冷启动`,
      baselineSnapshotId: input.snapshot.id,
      affectedFiles,
      affectedModules,
      affectedDimensions: allDimensions,
      skippedDimensions: [],
      diagnostics,
      diff: input.diff,
    };
  }

  const affectedDimensions = inferAffectedDimensions(input.snapshot, input.diff, allDimensions);
  const skippedDimensions = allDimensions.filter(
    (dimension) => !affectedDimensions.includes(dimension),
  );

  if (affectedDimensions.length === 0) {
    return {
      mode: "panorama-only",
      reason: `${changedCount} 个文件变更未命中维度依赖，仅刷新工程全景`,
      baselineSnapshotId: input.snapshot.id,
      affectedFiles,
      affectedModules,
      affectedDimensions: [],
      skippedDimensions: allDimensions,
      diagnostics,
      diff: input.diff,
    };
  }

  return {
    mode: "targeted-rescan",
    reason: `${changedCount} 个文件变更影响 ${affectedDimensions.length}/${allDimensions.length} 个维度`,
    baselineSnapshotId: input.snapshot.id,
    affectedFiles,
    affectedModules,
    affectedDimensions,
    skippedDimensions,
    diagnostics,
    diff: input.diff,
  };
}

export function inferAffectedDimensions(
  snapshot: EngineeringWorkflowIncrementalPlannerInput["snapshot"],
  diff: EngineeringWorkflowFileDiff,
  allDimensions: readonly string[],
): readonly string[] {
  if (!snapshot) {
    return allDimensions;
  }

  const affected = new Set<string>();
  const known = new Set(allDimensions);
  const changed = allChangedFiles(diff);

  for (const [dimensionId, meta] of Object.entries(snapshot.dimensionMeta)) {
    for (const referencedFile of meta.referencedFilesList) {
      if (changed.some((changedFile) => isSameWorkflowSnapshotPath(referencedFile, changedFile))) {
        affected.add(dimensionId);
        break;
      }
    }
  }

  for (const filePath of [...diff.added, ...diff.modified]) {
    for (const dimensionId of inferDimensionsByWorkflowFileType(filePath)) {
      affected.add(dimensionId);
    }
  }

  if (changed.length > 0) {
    affected.add("project-profile");
  }

  return allDimensions.length > 0
    ? allDimensions.filter((dimensionId) => affected.has(dimensionId))
    : [...affected].filter((dimensionId) => known.size === 0 || known.has(dimensionId));
}

export function inferDimensionsByWorkflowFileType(filePath: string): readonly string[] {
  const normalizedPath = toWorkflowPosixPath(filePath);
  const name = normalizedPath.split("/").pop()?.toLowerCase() || "";
  const ext = name.includes(".") ? name.split(".").pop() || "" : "";
  const dimensions: string[] = [];

  if (["m", "mm", "h"].includes(ext)) {
    dimensions.push("objc-deep-scan");
  }
  if (name.includes("+") || name.includes("category")) {
    dimensions.push("category-scan");
  }
  if (ext === "swift") {
    dimensions.push("code-standard", "architecture");
  }
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte"].includes(ext)) {
    dimensions.push("module-export-scan", "code-standard", "architecture");
  }
  if (ext === "py") {
    dimensions.push("python-package-scan", "code-standard", "architecture");
  }
  if (["java", "kt", "kts"].includes(ext)) {
    dimensions.push("jvm-annotation-scan", "code-standard", "architecture");
  }
  if (["json", "yaml", "yml", "plist", "xcconfig", "toml", "properties", "gradle"].includes(ext)) {
    dimensions.push("project-profile");
  }
  if (
    [
      "m",
      "mm",
      "h",
      "swift",
      "js",
      "jsx",
      "ts",
      "tsx",
      "mjs",
      "cjs",
      "py",
      "java",
      "kt",
      "kts",
      "go",
      "rs",
      "rb",
    ].includes(ext)
  ) {
    dimensions.push("code-pattern", "best-practice");
  }
  if (
    name.includes("manager") ||
    name.includes("service") ||
    name.includes("event") ||
    name.includes("notification") ||
    name.includes("delegate")
  ) {
    dimensions.push("event-and-data-flow");
  }

  return [...new Set(dimensions)];
}

export function allChangedFiles(diff: EngineeringWorkflowFileDiff): readonly string[] {
  return [
    ...diff.added,
    ...diff.modified,
    ...diff.deleted,
    ...diff.moved.flatMap((move) => [move.from, move.to]),
  ].sort();
}

function affectedModulesForDiff(diff: EngineeringWorkflowFileDiff): readonly string[] {
  return [...new Set(allChangedFiles(diff).map(moduleNameForWorkflowPath))].sort();
}

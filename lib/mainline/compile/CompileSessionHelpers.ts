import type { MainlineSourceFileScanResult } from "../../engineering/code/index.js";
import { normalizeMainlinePosixPath, uniqueMainlinePosixPaths } from "../core/index.js";
import type {
  MainlineFileFingerprintInput,
  MainlineFileFingerprintSnapshotDiff,
  RecipeMarkdownFileIndex,
} from "../data/index.js";
import type { MainlineProjectIntelligenceFileInput } from "../graph/index.js";
import type {
  Recipe,
  RecipeMarkdownLoadResult,
  RecipeMarkdownWriteResult,
} from "../knowledge/index.js";
import type {
  MainlineSearchIndex,
  MainlineSearchIndexSnapshot,
  MainlineSearchIndexStore,
} from "../search/index.js";
import type { MainlineCompileSearchMaterializeResult } from "./CompileSearchMaterializer.js";
import type { MainlineCompileSessionRuntime } from "./CompileSessionRuntime.js";
import type {
  MainlineCompileCancelCheckpoint,
  MainlineCompileCancelCheckpointKind,
  MainlineCompileCancelReport,
  MainlineCompileProgressCheckpoint,
  MainlineCompileProgressPhase,
  MainlineCompileProgressStatus,
  MainlineCompileSessionRecipeMarkdownReport,
  MainlineCompileSessionRequest,
  MainlineCompileSessionResult,
  MainlineCompileSessionSearchReport,
} from "./MainlineCompileSession.js";
import type { MainlineProjectIntelligenceRunnerResult } from "./ProjectIntelligenceRunner.js";
import type { MainlineSourceRefMovedFile } from "./RecipePathRepairer.js";

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

export interface ScannedCompileFiles {
  readonly scanResult: MainlineSourceFileScanResult;
  readonly projectFiles: MainlineProjectIntelligenceFileInput[];
  readonly fingerprintFiles: MainlineFileFingerprintInput[];
  readonly warnings: string[];
}

export async function scanCompileFiles(
  runtime: MainlineCompileSessionRuntime,
  request: MainlineCompileSessionRequest,
): Promise<ScannedCompileFiles> {
  const maxFileBytes = request.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const scanResult = await runtime.scanner.scan({
    root: request.projectRoot,
    ...(request.scan ?? {}),
  });
  const projectFiles: MainlineProjectIntelligenceFileInput[] = [];
  const fingerprintFiles: MainlineFileFingerprintInput[] = [];
  const warnings: string[] = [];

  for (const file of scanResult.files) {
    if (file.sizeBytes > maxFileBytes) {
      warnings.push(`Skipped ${file.relativePath}: file exceeds ${maxFileBytes} bytes.`);
      continue;
    }
    try {
      const content = await runtime.fileSystem.readText(file.path);
      fingerprintFiles.push({ path: file.relativePath, content });
      if (file.kind === "source") {
        projectFiles.push({
          path: file.relativePath,
          content,
          languageId: file.languageId,
        });
      }
    } catch {
      warnings.push(`Skipped ${file.relativePath}: file could not be read.`);
    }
  }

  return {
    scanResult,
    projectFiles,
    fingerprintFiles,
    warnings,
  };
}

export async function runProjectIntelligence(
  runtime: MainlineCompileSessionRuntime,
  request: MainlineCompileSessionRequest & { readonly generatedAt: number },
  input: {
    readonly projectFiles: readonly MainlineProjectIntelligenceFileInput[];
    readonly fingerprintDiff: MainlineFileFingerprintSnapshotDiff;
    readonly movedFiles: readonly MainlineSourceRefMovedFile[];
  },
): Promise<MainlineProjectIntelligenceRunnerResult> {
  if (request.mode === "cold-start") {
    return runtime.projectIntelligenceRunner.run({
      projectRoot: request.projectRoot,
      generatedAt: request.generatedAt,
      files: input.projectFiles,
      ...(request.maxFileBytes === undefined ? {} : { maxFileBytes: request.maxFileBytes }),
      engineeringWorkflow: true,
    });
  }

  return runtime.projectIntelligenceRunner.run({
    projectRoot: request.projectRoot,
    generatedAt: request.generatedAt,
    ...(request.maxFileBytes === undefined ? {} : { maxFileBytes: request.maxFileBytes }),
    engineeringWorkflow: true,
    incremental: {
      fingerprintDiff: input.fingerprintDiff,
      ...(input.movedFiles.length === 0 ? {} : { movedFiles: input.movedFiles }),
      ...(request.changedFiles === undefined ? {} : { changedFiles: request.changedFiles }),
      ...(request.removedFiles === undefined ? {} : { deletedFiles: request.removedFiles }),
      ...(request.dependentDepth === undefined ? {} : { dependentDepth: request.dependentDepth }),
      ...(request.fullRebuildChangeRatio === undefined
        ? {}
        : { fullRebuildChangeRatio: request.fullRebuildChangeRatio }),
    },
  });
}

export function mergeExplicitFileChanges(
  diff: MainlineFileFingerprintSnapshotDiff,
  input: {
    readonly changedFiles?: readonly string[];
    readonly removedFiles?: readonly string[];
    readonly currentFiles: readonly string[];
  },
): MainlineFileFingerprintSnapshotDiff {
  const currentFiles = new Set(input.currentFiles.map(normalizeMainlinePosixPath));
  const removedFiles = uniqueMainlinePosixPaths(input.removedFiles ?? []);
  const changedFiles = uniqueMainlinePosixPaths(input.changedFiles ?? []).filter(
    (filePath) => !removedFiles.includes(filePath),
  );
  const added = uniqueMainlinePosixPaths(
    diff.added.filter((filePath) => !removedFiles.includes(filePath)),
  );
  const modified = uniqueMainlinePosixPaths([
    ...diff.modified,
    ...changedFiles.filter((filePath) => !added.includes(filePath)),
  ]).filter((filePath) => !removedFiles.includes(filePath));
  const deleted = uniqueMainlinePosixPaths([...diff.deleted, ...removedFiles]);
  const unchanged = uniqueMainlinePosixPaths(
    [...currentFiles].filter(
      (filePath) => !added.includes(filePath) && !modified.includes(filePath),
    ),
  );
  const total = new Set([...added, ...modified, ...deleted, ...unchanged]).size;

  return {
    added,
    modified,
    deleted,
    unchanged,
    changeRatio: total === 0 ? 0 : (added.length + modified.length + deleted.length) / total,
  };
}

export async function restoreSearchIndex(
  store: MainlineSearchIndexStore,
  index: MainlineSearchIndex,
): Promise<number> {
  const snapshot = await store.loadSnapshot();
  if (!snapshot) {
    return 0;
  }
  index.upsert(snapshot.documents);
  return snapshot.documents.length;
}

export function searchReport(
  projectIntelligence: MainlineProjectIntelligenceRunnerResult,
  projectSearch: MainlineCompileSearchMaterializeResult,
  contentSearch: MainlineCompileSearchMaterializeResult,
  input: {
    readonly restoredDocuments: number;
    readonly persistedSnapshot: MainlineSearchIndexSnapshot;
  },
): MainlineCompileSessionSearchReport {
  const projectDocumentsUpserted =
    projectSearch.upserted || projectIntelligence.materialized?.searchDocuments.length || 0;
  const projectDocumentsRemoved =
    projectSearch.removed || projectIntelligence.materialized?.removedSearchDocumentIds.length || 0;

  return {
    upserted: projectDocumentsUpserted + contentSearch.upserted,
    removed: projectDocumentsRemoved + contentSearch.removed,
    embedded: projectSearch.embedded + contentSearch.embedded,
    embeddingFailures:
      projectSearch.embeddingFailures.length + contentSearch.embeddingFailures.length,
    restoredDocuments: input.restoredDocuments,
    persistedDocuments: input.persistedSnapshot.documents.length,
    projectDocumentsUpserted,
    projectDocumentsRemoved,
    contentDocumentsUpserted: contentSearch.upserted,
    contentDocumentsRemoved: contentSearch.removed,
  };
}

export async function flushSearchIndex(searchIndex: MainlineSearchIndex): Promise<void> {
  const flushable = searchIndex as MainlineSearchIndex & { flush?: () => Promise<void> };
  // 中文注释：持久化 SearchIndex 可能把 upsert/remove 排队为异步 atomic write；
  // compile 返回前必须等待队列清空，避免 daemon/job result 已完成但 dataRoot 仍在写。
  await flushable.flush?.();
}

export function recipeMarkdownReport(
  loaded: RecipeMarkdownLoadResult,
  writes: readonly RecipeMarkdownWriteResult[],
): MainlineCompileSessionRecipeMarkdownReport {
  return {
    loaded: loaded.recipes.length,
    written: writes.length,
    loadedPaths: loaded.files.map((file) => file.relativePath),
    paths: writes.map((write) => write.relativePath),
    warnings: loaded.warnings.map(recipeMarkdownWarning),
  };
}

export function recipeMarkdownWritesToFiles(
  writes: readonly RecipeMarkdownWriteResult[],
  updatedAt: number,
): RecipeMarkdownFileIndex[] {
  return writes.map((write) => ({
    recipeId: write.recipeId,
    bucket: write.bucket,
    relativePath: write.relativePath,
    contentHash: write.contentHash,
    updatedAt,
  }));
}

export function fileContentByPath(
  files: readonly MainlineFileFingerprintInput[],
): Record<string, string> {
  return Object.fromEntries(
    files.flatMap((file) => (typeof file.content === "string" ? [[file.path, file.content]] : [])),
  );
}

export function mergeCompileRecipes(
  markdownRecipes: readonly Recipe[],
  requestRecipes: readonly Recipe[],
): readonly Recipe[] | undefined {
  if (markdownRecipes.length === 0 && requestRecipes.length === 0) {
    return undefined;
  }
  const recipesById = new Map<string, Recipe>();
  for (const recipe of markdownRecipes) {
    recipesById.set(recipe.id, recipe);
  }
  for (const recipe of requestRecipes) {
    recipesById.set(recipe.id, recipe);
  }
  return [...recipesById.values()];
}

export function recipeMarkdownWarning(
  warning: RecipeMarkdownLoadResult["warnings"][number],
): string {
  return `Skipped ${warning.relativePath}: ${warning.message}.`;
}

export function skippedFileWarning(
  skippedFile: MainlineProjectIntelligenceRunnerResult["skippedFiles"][number],
): string {
  return `Skipped ${skippedFile.path}: ${skippedFile.reason}.`;
}

export function markProgress(
  checkpoints: MainlineCompileProgressCheckpoint[],
  phase: MainlineCompileProgressPhase,
  status: MainlineCompileProgressStatus,
  detail?: string,
): void {
  checkpoints.push({
    phase,
    status,
    ...(detail === undefined ? {} : { detail }),
  });
}

export function reachCancelCheckpoint(
  checkpoints: MainlineCompileCancelCheckpoint[],
  kind: MainlineCompileCancelCheckpointKind,
): void {
  checkpoints.push({ kind, reached: true, cancellable: false });
}

export function compileCancelReport(
  checkpoints: readonly MainlineCompileCancelCheckpoint[],
): MainlineCompileCancelReport {
  return {
    supported: false,
    warnings: [
      "Mainline compile cancellation is checkpoint-only; deep cancellation is not wired yet.",
    ],
    checkpoints,
  };
}

export function compileSessionJobResult(
  result: Omit<MainlineCompileSessionResult, "jobId">,
): unknown {
  return {
    mode: result.mode,
    projectRoot: result.projectRoot,
    files: {
      added: result.fingerprintDiff.added.length,
      modified: result.fingerprintDiff.modified.length,
      deleted: result.fingerprintDiff.deleted.length,
      unchanged: result.fingerprintDiff.unchanged.length,
    },
    projectIntelligence: {
      fileCount: result.projectIntelligence.artifact.files.length,
      symbolCount: result.projectIntelligence.artifact.symbols.length,
      edgeCount: result.projectIntelligence.artifact.semanticEdges.length,
      moduleCount: result.projectPanorama.modules.length,
      dependencyCycleCount: result.projectPanorama.cycleCount,
    },
    contentMining: {
      sourceRefCount: result.contentMining.sourceRefs.length,
      recipeCount: result.contentMining.recipes.length,
      edgeCount: result.contentMining.edges.length,
    },
    recipeEvidence: result.recipeEvidence.summary,
    sourceRefRepair: result.sourceRefRepair.summary,
    recipeImpact: result.recipeImpact.summary,
    recipeMarkdown: result.recipeMarkdown,
    search: result.search,
    progress: {
      checkpointCount: result.progress.checkpoints.length,
    },
    cancel: {
      supported: result.cancel.supported,
      checkpointCount: result.cancel.checkpoints.length,
      warningCount: result.cancel.warnings.length,
    },
    warningCount: result.warnings.length,
  };
}

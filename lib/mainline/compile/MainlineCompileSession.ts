import path from "node:path";
import type {
  MainlineSourceFileScanner,
  MainlineSourceFileScanOptions,
  MainlineSourceFileScanResult,
} from "../../engineering/code/index.js";
import type { MainlineEmbeddingPort } from "../ai/index.js";
import {
  epochSecondsNow,
  type MainlineAtomicFileStore,
  type MainlineFileSystemPort,
  MainlineValidationError,
  type MainlineWorkspacePathInput,
  type MainlineWorkspacePaths,
  type MainlineWriteBoundary,
} from "../core/index.js";
import {
  type ContextIndexWriter,
  createMainlineFileFingerprintSnapshot,
  diffMainlineFileFingerprintSnapshots,
  type FileFingerprintSnapshotStore,
  type MainlineFileFingerprintSnapshot,
  type MainlineFileFingerprintSnapshotDiff,
  type MainlineJobLedgerPort,
} from "../data/index.js";
import type { Recipe, RecipeMarkdownStore } from "../knowledge/index.js";
import type {
  MainlineSearchIndex,
  MainlineSearchIndexStore,
  MainlineVectorStore,
} from "../search/index.js";
import {
  compileCancelReport,
  compileSessionJobResult,
  fileContentByPath,
  flushSearchIndex,
  markProgress,
  mergeCompileRecipes,
  mergeExplicitFileChanges,
  reachCancelCheckpoint,
  recipeMarkdownReport,
  recipeMarkdownWarning,
  recipeMarkdownWritesToFiles,
  restoreSearchIndex,
  runProjectIntelligence,
  scanCompileFiles,
  searchReport,
  skippedFileWarning,
} from "./CompileSessionHelpers.js";
import {
  createMainlineCompileSessionRuntime,
  type MainlineCompileSessionRuntime,
} from "./CompileSessionRuntime.js";

export {
  MAINLINE_FILE_FINGERPRINT_SNAPSHOT_STORE_PATH,
  MAINLINE_SEARCH_INDEX_STORE_PATH,
} from "./CompileSessionPaths.js";

import type { MainlineCompileSearchMaterializer } from "./CompileSearchMaterializer.js";
import type { ContentMiningPipelineArtifacts } from "./ContentMiningPipeline.js";
import type { ContentMiningRunner } from "./ContentMiningRunner.js";
import type { MainlineEngineeringWorkflowArtifactStore } from "./EngineeringWorkflowArtifactStore.js";
import type { MainlineProjectIntelligenceArtifactStore } from "./ProjectIntelligenceArtifactStore.js";
import type {
  MainlineProjectIntelligenceRunner,
  MainlineProjectIntelligenceRunnerResult,
} from "./ProjectIntelligenceRunner.js";
import {
  type MainlineProjectPanoramaSummary,
  summarizeMainlineProjectPanorama,
} from "./ProjectPanoramaSummary.js";
import {
  linkMainlineRecipeEvidence,
  type MainlineRecipeEvidenceLinkReport,
} from "./RecipeEvidenceLinker.js";
import type { RecipeImpactAnalyzer } from "./RecipeImpactAnalyzer.js";
import {
  createEmptyMainlineRecipeImpactPlan,
  type MainlineRecipeImpactPlan,
} from "./RecipeImpactPlan.js";
import {
  createEmptyMainlineSourceRefRepairPlan,
  type MainlineSourceRefRepairPlan,
} from "./RecipePathRepairer.js";
import {
  detectMainlineSourceRefMovedFiles,
  type SourceRefRepairService,
} from "./SourceRefRepairService.js";

export type MainlineCompileSessionMode = "cold-start" | "incremental";

export interface MainlineCompileSessionRequest {
  readonly projectRoot: string;
  readonly mode: MainlineCompileSessionMode;
  readonly workspace?: Pick<
    MainlineWorkspacePathInput,
    "mode" | "dataRoot" | "projectId" | "homeDir"
  >;
  readonly scan?: Omit<MainlineSourceFileScanOptions, "root">;
  readonly changedFiles?: readonly string[];
  readonly removedFiles?: readonly string[];
  readonly diffTextByPath?: Record<string, string>;
  readonly recipes?: readonly Recipe[];
  readonly generatedAt?: number;
  readonly maxFileBytes?: number;
  readonly notes?: readonly string[];
  readonly dependentDepth?: number;
  readonly fullRebuildChangeRatio?: number;
}

export interface MainlineCompileSessionSearchReport {
  readonly upserted: number;
  readonly removed: number;
  readonly embedded: number;
  readonly embeddingFailures: number;
  readonly restoredDocuments: number;
  readonly persistedDocuments: number;
  readonly projectDocumentsUpserted: number;
  readonly projectDocumentsRemoved: number;
  readonly contentDocumentsUpserted: number;
  readonly contentDocumentsRemoved: number;
}

export interface MainlineCompileSessionRecipeMarkdownReport {
  readonly loaded: number;
  readonly written: number;
  readonly loadedPaths: readonly string[];
  readonly paths: readonly string[];
  readonly warnings: readonly string[];
}

export type MainlineCompileProgressPhase =
  | "scan"
  | "fingerprint"
  | "recipe-markdown"
  | "content-mining"
  | "project-intelligence"
  | "source-ref-repair"
  | "recipe-impact"
  | "search-index"
  | "fingerprint-store";

export type MainlineCompileProgressStatus = "completed" | "skipped";

export interface MainlineCompileProgressCheckpoint {
  readonly phase: MainlineCompileProgressPhase;
  readonly status: MainlineCompileProgressStatus;
  readonly detail?: string;
}

export interface MainlineCompileProgressReport {
  readonly checkpoints: readonly MainlineCompileProgressCheckpoint[];
}

export type MainlineCompileCancelCheckpointKind =
  | "pre-run"
  | "pre-source-ref-repair"
  | "post-source-ref-repair"
  | "post-run";

export interface MainlineCompileCancelCheckpoint {
  readonly kind: MainlineCompileCancelCheckpointKind;
  readonly reached: boolean;
  readonly cancellable: boolean;
}

export interface MainlineCompileCancelReport {
  readonly supported: false;
  readonly warnings: readonly string[];
  readonly checkpoints: readonly MainlineCompileCancelCheckpoint[];
}

export interface MainlineCompileSessionResult {
  readonly mode: MainlineCompileSessionMode;
  readonly projectRoot: string;
  readonly workspace: ReturnType<MainlineWorkspacePaths["snapshot"]>;
  readonly scanResult: MainlineSourceFileScanResult;
  readonly fingerprintSnapshot: MainlineFileFingerprintSnapshot;
  readonly fingerprintDiff: MainlineFileFingerprintSnapshotDiff;
  readonly projectIntelligence: MainlineProjectIntelligenceRunnerResult;
  readonly projectPanorama: MainlineProjectPanoramaSummary;
  readonly contentMining: ContentMiningPipelineArtifacts;
  readonly recipeEvidence: MainlineRecipeEvidenceLinkReport;
  readonly sourceRefRepair: MainlineSourceRefRepairPlan;
  readonly recipeImpact: MainlineRecipeImpactPlan;
  readonly recipeMarkdown: MainlineCompileSessionRecipeMarkdownReport;
  readonly search: MainlineCompileSessionSearchReport;
  readonly progress: MainlineCompileProgressReport;
  readonly cancel: MainlineCompileCancelReport;
  readonly warnings: readonly string[];
  readonly jobId?: string;
}

export interface MainlineCompileSessionDependencies {
  readonly workspacePaths?: MainlineWorkspacePaths;
  readonly writeBoundary?: MainlineWriteBoundary;
  readonly fileStore?: MainlineAtomicFileStore;
  readonly fileSystem?: Pick<MainlineFileSystemPort, "readText">;
  readonly scanner?: MainlineSourceFileScanner;
  readonly contextIndex?: ContextIndexWriter;
  readonly searchIndex?: MainlineSearchIndex;
  readonly vectorStore?: MainlineVectorStore;
  readonly embeddingProvider?: MainlineEmbeddingPort;
  readonly searchIndexStore?: MainlineSearchIndexStore;
  readonly artifactStore?: MainlineProjectIntelligenceArtifactStore;
  readonly engineeringWorkflowArtifactStore?: MainlineEngineeringWorkflowArtifactStore;
  readonly fingerprintStore?: FileFingerprintSnapshotStore;
  readonly projectIntelligenceRunner?: MainlineProjectIntelligenceRunner;
  readonly contentMiningRunner?: ContentMiningRunner;
  readonly recipeImpactAnalyzer?: RecipeImpactAnalyzer;
  readonly sourceRefRepairService?: SourceRefRepairService;
  readonly recipeMarkdownStore?: RecipeMarkdownStore;
  readonly searchMaterializer?: MainlineCompileSearchMaterializer;
  readonly jobLedger?: MainlineJobLedgerPort;
}

export interface MainlineCompileSessionKernel {
  readonly workspacePaths: MainlineWorkspacePaths;
  readonly writeBoundary: MainlineWriteBoundary;
  readonly fileStore: MainlineAtomicFileStore;
  readonly fileSystem: Pick<MainlineFileSystemPort, "readText">;
  readonly contextIndex: ContextIndexWriter;
  readonly searchIndex: MainlineSearchIndex;
  readonly jobLedger: MainlineJobLedgerPort;
}

/**
 * MainlineCompileSession 是冷启动/增量编译的主线入口。
 * 中文注释：它只串起文件指纹、ProjectIntelligence、内容挖掘、Recipe Markdown、
 * SearchIndex 快照和 JobLedger，不搬旧 workflow/proposal/embedding 兼容层。
 */
export class MainlineCompileSession {
  readonly #dependencies: MainlineCompileSessionDependencies;

  constructor(dependencies: MainlineCompileSessionDependencies = {}) {
    this.#dependencies = dependencies;
  }

  static fromKernel(
    kernel: MainlineCompileSessionKernel,
    dependencies: Omit<
      MainlineCompileSessionDependencies,
      | "workspacePaths"
      | "writeBoundary"
      | "fileStore"
      | "fileSystem"
      | "contextIndex"
      | "searchIndex"
      | "jobLedger"
    > = {},
  ): MainlineCompileSession {
    return new MainlineCompileSession({
      ...dependencies,
      workspacePaths: kernel.workspacePaths,
      writeBoundary: kernel.writeBoundary,
      fileStore: kernel.fileStore,
      fileSystem: kernel.fileSystem,
      contextIndex: kernel.contextIndex,
      searchIndex: kernel.searchIndex,
      jobLedger: kernel.jobLedger,
    });
  }

  async run(request: MainlineCompileSessionRequest): Promise<MainlineCompileSessionResult> {
    const projectRoot = path.resolve(request.projectRoot);
    const runtime = createMainlineCompileSessionRuntime(this.#dependencies, projectRoot, request);
    const generatedAt = request.generatedAt ?? epochSecondsNow();
    const job = await runtime.jobLedger.create({
      kind: "mainline-compile-session",
      source: "compile",
      request: {
        mode: request.mode,
        projectRoot,
        recipeCount: request.recipes?.length ?? 0,
        changedFileCount: request.changedFiles?.length ?? 0,
        removedFileCount: request.removedFiles?.length ?? 0,
      },
    });

    await runtime.jobLedger.markRunning(job.id);
    try {
      const result = await this.#runWithRuntime(runtime, {
        ...request,
        projectRoot,
        generatedAt,
      });
      await runtime.jobLedger.complete(job.id, compileSessionJobResult(result));
      return { ...result, jobId: job.id };
    } catch (error) {
      await runtime.jobLedger.fail(job.id, error);
      throw error;
    }
  }

  async #runWithRuntime(
    runtime: MainlineCompileSessionRuntime,
    request: MainlineCompileSessionRequest & { readonly generatedAt: number },
  ): Promise<Omit<MainlineCompileSessionResult, "jobId">> {
    const progressCheckpoints: MainlineCompileProgressCheckpoint[] = [];
    const cancelCheckpoints: MainlineCompileCancelCheckpoint[] = [];
    reachCancelCheckpoint(cancelCheckpoints, "pre-run");
    const scanned = await scanCompileFiles(runtime, request);
    markProgress(progressCheckpoints, "scan", "completed");
    const fingerprintSnapshot = createMainlineFileFingerprintSnapshot({
      id: `mainline-fingerprint-${request.generatedAt}`,
      projectRoot: request.projectRoot,
      createdAt: request.generatedAt,
      files: scanned.fingerprintFiles,
    });
    const previousSnapshot = await runtime.fingerprintStore.load();
    const restoredSearchDocuments = await restoreSearchIndex(
      runtime.searchIndexStore,
      runtime.searchIndex,
    );
    if (request.mode === "incremental" && !previousSnapshot) {
      throw new MainlineValidationError(
        "Mainline incremental compile requires a saved fingerprint baseline.",
        { projectRoot: request.projectRoot },
      );
    }

    const fingerprintDiff = mergeExplicitFileChanges(
      request.mode === "cold-start"
        ? diffMainlineFileFingerprintSnapshots({}, fingerprintSnapshot.files)
        : diffMainlineFileFingerprintSnapshots(
            previousSnapshot?.files ?? {},
            fingerprintSnapshot.files,
          ),
      {
        currentFiles: Object.keys(fingerprintSnapshot.files),
        ...(request.changedFiles === undefined ? {} : { changedFiles: request.changedFiles }),
        ...(request.removedFiles === undefined ? {} : { removedFiles: request.removedFiles }),
      },
    );
    const detectedMovedFiles =
      request.mode === "incremental"
        ? detectMainlineSourceRefMovedFiles({
            previousFingerprintSnapshot: previousSnapshot,
            currentFingerprintSnapshot: fingerprintSnapshot,
            fingerprintDiff,
          })
        : [];
    markProgress(progressCheckpoints, "fingerprint", "completed");
    const loadedRecipeMarkdown = await runtime.recipeMarkdownStore.loadAll();
    const compileRecipes = mergeCompileRecipes(loadedRecipeMarkdown.recipes, request.recipes ?? []);
    const recipeMarkdownWrites = await runtime.recipeMarkdownStore.writeMany(compileRecipes ?? []);
    const recipeFiles = recipeMarkdownWritesToFiles(recipeMarkdownWrites, request.generatedAt);
    markProgress(progressCheckpoints, "recipe-markdown", "completed");
    // 先写 Recipe 与内容证据，再写项目事实 SourceRef；同 id 时项目事实保留语言/符号元数据。
    const contentMining = await runtime.contentMiningRunner.compileAndWrite({
      evidenceRequest: {
        projectRoot: request.projectRoot,
        origin: request.mode === "cold-start" ? "snapshot" : "diff",
        scanFiles: false,
        snapshotDiff: fingerprintDiff,
        ...(request.diffTextByPath ? { diffTextByPath: request.diffTextByPath } : {}),
        ...(request.notes ? { notes: request.notes } : {}),
        id: `mainline-${request.mode}-${request.generatedAt}`,
      },
      ...(compileRecipes ? { recipes: compileRecipes } : {}),
      recipeFiles,
      generatedAt: request.generatedAt,
      reportId: `mainline-compile-report-${request.generatedAt}`,
    });
    markProgress(progressCheckpoints, "content-mining", "completed");
    const projectIntelligence = await runProjectIntelligence(runtime, request, {
      projectFiles: scanned.projectFiles,
      fingerprintDiff,
      movedFiles: detectedMovedFiles,
    });
    markProgress(progressCheckpoints, "project-intelligence", "completed");
    const projectPanorama = summarizeMainlineProjectPanorama(projectIntelligence.artifact);
    const compiledSourceRefs = [
      ...contentMining.sourceRefs,
      ...(projectIntelligence.materialized?.sourceRefs ?? []),
      ...(projectIntelligence.materialized?.staleSourceRefs ?? []),
    ];
    const recipeEvidence = linkMainlineRecipeEvidence({
      recipes: contentMining.recipes,
      projectIntelligence: projectIntelligence.artifact,
      sourceRefs: compiledSourceRefs,
    });
    reachCancelCheckpoint(cancelCheckpoints, "pre-source-ref-repair");
    const sourceRefRepair =
      request.mode === "incremental"
        ? runtime.sourceRefRepairService.repair({
            recipes: contentMining.recipes,
            sourceRefs: compiledSourceRefs,
            fingerprintDiff,
            ...(previousSnapshot === null ? {} : { previousFingerprintSnapshot: previousSnapshot }),
            currentFingerprintSnapshot: fingerprintSnapshot,
            ...(projectIntelligence.incrementalPlan === undefined
              ? {}
              : { incrementalPlan: projectIntelligence.incrementalPlan }),
            movedFiles: detectedMovedFiles,
            ...(request.removedFiles === undefined ? {} : { removedFiles: request.removedFiles }),
            generatedAt: request.generatedAt,
          })
        : createEmptyMainlineSourceRefRepairPlan();
    markProgress(
      progressCheckpoints,
      "source-ref-repair",
      request.mode === "incremental" ? "completed" : "skipped",
      `${sourceRefRepair.repairs.length} SourceRef repair item(s)`,
    );
    reachCancelCheckpoint(cancelCheckpoints, "post-source-ref-repair");
    const recipeImpact =
      request.mode === "incremental"
        ? runtime.recipeImpactAnalyzer.analyze({
            recipes: contentMining.recipes,
            changedFiles: fingerprintDiff.modified,
            deletedFiles: fingerprintDiff.deleted,
            createdFiles: fingerprintDiff.added,
            movedFiles: sourceRefRepair.movedFiles,
            ...(request.diffTextByPath ? { diffTextByPath: request.diffTextByPath } : {}),
            fileContentByPath: fileContentByPath(scanned.fingerprintFiles),
            sourceRefs: [...compiledSourceRefs, ...sourceRefRepair.sourceRefs],
          })
        : createEmptyMainlineRecipeImpactPlan();
    markProgress(progressCheckpoints, "recipe-impact", "completed");
    const projectSearch = await runtime.searchMaterializer.materialize({
      searchDocuments: projectIntelligence.materialized?.searchDocuments ?? [],
      searchDocumentIdsToRemove: projectIntelligence.materialized?.removedSearchDocumentIds ?? [],
    });
    const contentSearch = await runtime.searchMaterializer.materialize({
      recipes: contentMining.recipes,
      sourceRefs: contentMining.sourceRefs,
    });
    await flushSearchIndex(runtime.searchIndex);
    const persistedSearchSnapshot = await runtime.searchIndexStore.saveDocuments(
      runtime.searchIndex.snapshot(),
    );
    await flushSearchIndex(runtime.searchIndex);
    markProgress(progressCheckpoints, "search-index", "completed");

    // 指纹保存放在所有写入之后，避免失败的增量运行污染下一轮 baseline。
    await runtime.fingerprintStore.save(fingerprintSnapshot);
    markProgress(progressCheckpoints, "fingerprint-store", "completed");
    reachCancelCheckpoint(cancelCheckpoints, "post-run");

    return {
      mode: request.mode,
      projectRoot: request.projectRoot,
      workspace: runtime.workspacePaths.snapshot(),
      scanResult: scanned.scanResult,
      fingerprintSnapshot,
      fingerprintDiff,
      projectIntelligence,
      projectPanorama,
      contentMining,
      recipeEvidence,
      sourceRefRepair,
      recipeImpact,
      recipeMarkdown: recipeMarkdownReport(loadedRecipeMarkdown, recipeMarkdownWrites),
      search: searchReport(projectIntelligence, projectSearch, contentSearch, {
        restoredDocuments: restoredSearchDocuments,
        persistedSnapshot: persistedSearchSnapshot,
      }),
      progress: { checkpoints: progressCheckpoints },
      cancel: compileCancelReport(cancelCheckpoints),
      warnings: [
        ...scanned.warnings,
        ...loadedRecipeMarkdown.warnings.map(recipeMarkdownWarning),
        ...projectIntelligence.skippedFiles.map(skippedFileWarning),
      ],
    };
  }
}

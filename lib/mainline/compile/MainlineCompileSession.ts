import path from "node:path";
import {
  MainlineSourceFileScanner,
  type MainlineSourceFileScanOptions,
  type MainlineSourceFileScanResult,
} from "../code/index.js";
import {
  epochSecondsNow,
  MainlineAtomicFileStore,
  type MainlineFileSystemPort,
  MainlineValidationError,
  type MainlineWorkspacePathInput,
  MainlineWorkspacePaths,
  MainlineWriteBoundary,
  NodeMainlineFileSystem,
  normalizeMainlinePosixPath,
  uniqueMainlinePosixPaths,
} from "../core/index.js";
import {
  type ContextIndexWriter,
  createMainlineFileFingerprintSnapshot,
  diffMainlineFileFingerprintSnapshots,
  FileFingerprintSnapshotStore,
  InMemoryContextIndex,
  InMemoryMainlineJobLedger,
  type MainlineFileFingerprintInput,
  type MainlineFileFingerprintSnapshot,
  type MainlineFileFingerprintSnapshotDiff,
  type MainlineJobLedgerPort,
  type RecipeMarkdownFileIndex,
} from "../data/index.js";
import type {
  MainlineAtomicFileStore as MainlineJsonAtomicFileStore,
  MainlineZonedPath as MainlineJsonZonedPath,
} from "../data/JsonStores.js";
import type { MainlineProjectIntelligenceFileInput } from "../graph/index.js";
import {
  type Recipe,
  type RecipeMarkdownLoadResult,
  RecipeMarkdownStore,
  type RecipeMarkdownWriteResult,
} from "../knowledge/index.js";
import {
  InMemoryMainlineSearchIndex,
  type MainlineSearchIndex,
  type MainlineSearchIndexSnapshot,
  MainlineSearchIndexStore,
  projectMainlineSearchDocuments,
} from "../search/index.js";
import { CompileArtifactWriter } from "./CompileArtifactWriter.js";
import type { ContentMiningPipelineArtifacts } from "./ContentMiningPipeline.js";
import { ContentMiningRunner } from "./ContentMiningRunner.js";
import {
  JsonMainlineProjectIntelligenceArtifactStore,
  MAINLINE_PROJECT_INTELLIGENCE_ARTIFACT_STORE_PATH,
  type MainlineProjectIntelligenceArtifactStore,
} from "./ProjectIntelligenceArtifactStore.js";
import {
  MainlineProjectIntelligenceRunner,
  type MainlineProjectIntelligenceRunnerResult,
} from "./ProjectIntelligenceRunner.js";
import {
  type MainlineProjectPanoramaSummary,
  summarizeMainlineProjectPanorama,
} from "./ProjectPanoramaSummary.js";
import { RecipeImpactAnalyzer } from "./RecipeImpactAnalyzer.js";
import {
  createEmptyMainlineRecipeImpactPlan,
  type MainlineRecipeImpactPlan,
} from "./RecipeImpactPlan.js";
import {
  createEmptyMainlineSourceRefRepairPlan,
  type MainlineSourceRefMovedFile,
  type MainlineSourceRefRepairPlan,
} from "./RecipePathRepairer.js";
import {
  detectMainlineSourceRefMovedFiles,
  SourceRefRepairService,
} from "./SourceRefRepairService.js";

export const MAINLINE_FILE_FINGERPRINT_SNAPSHOT_STORE_PATH =
  "context/file-fingerprint-snapshot.json";
export const MAINLINE_SEARCH_INDEX_STORE_PATH = "context/search-index.json";

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
  readonly restoredDocuments: number;
  readonly persistedDocuments: number;
  readonly projectDocumentsUpserted: number;
  readonly projectDocumentsRemoved: number;
  readonly contentDocumentsUpserted: number;
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
  readonly searchIndexStore?: MainlineSearchIndexStore;
  readonly artifactStore?: MainlineProjectIntelligenceArtifactStore;
  readonly fingerprintStore?: FileFingerprintSnapshotStore;
  readonly projectIntelligenceRunner?: MainlineProjectIntelligenceRunner;
  readonly contentMiningRunner?: ContentMiningRunner;
  readonly recipeImpactAnalyzer?: RecipeImpactAnalyzer;
  readonly sourceRefRepairService?: SourceRefRepairService;
  readonly recipeMarkdownStore?: RecipeMarkdownStore;
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

interface MainlineCompileSessionRuntime {
  readonly workspacePaths: MainlineWorkspacePaths;
  readonly writeBoundary: MainlineWriteBoundary;
  readonly fileStore: MainlineAtomicFileStore;
  readonly fileSystem: Pick<MainlineFileSystemPort, "readText">;
  readonly scanner: MainlineSourceFileScanner;
  readonly contextIndex: ContextIndexWriter;
  readonly searchIndex: MainlineSearchIndex;
  readonly searchIndexStore: MainlineSearchIndexStore;
  readonly artifactStore: MainlineProjectIntelligenceArtifactStore;
  readonly fingerprintStore: FileFingerprintSnapshotStore;
  readonly projectIntelligenceRunner: MainlineProjectIntelligenceRunner;
  readonly contentMiningRunner: ContentMiningRunner;
  readonly recipeImpactAnalyzer: RecipeImpactAnalyzer;
  readonly sourceRefRepairService: SourceRefRepairService;
  readonly recipeMarkdownStore: RecipeMarkdownStore;
  readonly jobLedger: MainlineJobLedgerPort;
}

interface ScannedCompileFiles {
  readonly scanResult: MainlineSourceFileScanResult;
  readonly projectFiles: MainlineProjectIntelligenceFileInput[];
  readonly fingerprintFiles: MainlineFileFingerprintInput[];
  readonly warnings: string[];
}

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

class MainlineJsonFileStoreAdapter implements MainlineJsonAtomicFileStore {
  readonly #fileStore: MainlineAtomicFileStore;

  constructor(fileStore: MainlineAtomicFileStore) {
    this.#fileStore = fileStore;
  }

  readText(target: MainlineJsonZonedPath): Promise<string | null> {
    return this.#fileStore.readText(jsonStoreTargetToCore(target));
  }

  readJson<T>(target: MainlineJsonZonedPath): Promise<T | null> {
    return this.#fileStore.readJson<T>(jsonStoreTargetToCore(target));
  }

  writeJsonAtomic(target: MainlineJsonZonedPath, value: unknown): Promise<void> {
    return this.#fileStore.writeJsonAtomic(jsonStoreTargetToCore(target), value);
  }

  appendJsonl(target: MainlineJsonZonedPath, value: unknown): Promise<void> {
    return this.#fileStore.appendJsonl(jsonStoreTargetToCore(target), value);
  }
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
    const runtime = this.#runtime(projectRoot, request);
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
    const contentSearchDocuments = projectMainlineSearchDocuments({
      recipes: contentMining.recipes,
      sourceRefs: contentMining.sourceRefs,
    });
    runtime.searchIndex.upsert(contentSearchDocuments);
    const persistedSearchSnapshot = await runtime.searchIndexStore.saveDocuments(
      runtime.searchIndex.snapshot(),
    );
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
      sourceRefRepair,
      recipeImpact,
      recipeMarkdown: recipeMarkdownReport(loadedRecipeMarkdown, recipeMarkdownWrites),
      search: searchReport(projectIntelligence, {
        restoredDocuments: restoredSearchDocuments,
        persistedSnapshot: persistedSearchSnapshot,
        contentDocumentsUpserted: contentSearchDocuments.length,
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

  #runtime(
    projectRoot: string,
    request: Pick<MainlineCompileSessionRequest, "workspace">,
  ): MainlineCompileSessionRuntime {
    const workspacePaths =
      this.#dependencies.workspacePaths ??
      new MainlineWorkspacePaths({
        projectRoot,
        ...(request.workspace ?? {}),
      });
    if (path.resolve(workspacePaths.projectRoot) !== projectRoot) {
      throw new MainlineValidationError(
        "Mainline compile session workspacePaths must match request.projectRoot.",
        {
          workspaceProjectRoot: workspacePaths.projectRoot,
          requestProjectRoot: projectRoot,
        },
      );
    }

    const writeBoundary =
      this.#dependencies.writeBoundary ?? new MainlineWriteBoundary({ workspacePaths });
    const fileStore = this.#dependencies.fileStore ?? new MainlineAtomicFileStore();
    const jsonFileStore = new MainlineJsonFileStoreAdapter(fileStore);
    const fileSystem = this.#dependencies.fileSystem ?? new NodeMainlineFileSystem();
    const scanner = this.#dependencies.scanner ?? new MainlineSourceFileScanner();
    const contextIndex = this.#dependencies.contextIndex ?? new InMemoryContextIndex();
    const searchIndex = this.#dependencies.searchIndex ?? new InMemoryMainlineSearchIndex();
    const searchIndexStore =
      this.#dependencies.searchIndexStore ??
      new MainlineSearchIndexStore(
        jsonStoreTarget(writeBoundary.runtime(MAINLINE_SEARCH_INDEX_STORE_PATH)),
        jsonFileStore,
      );
    const artifactStore =
      this.#dependencies.artifactStore ??
      new JsonMainlineProjectIntelligenceArtifactStore(
        jsonStoreTarget(writeBoundary.runtime(MAINLINE_PROJECT_INTELLIGENCE_ARTIFACT_STORE_PATH)),
        jsonFileStore,
      );
    const fingerprintStore =
      this.#dependencies.fingerprintStore ??
      new FileFingerprintSnapshotStore(
        jsonStoreTarget(writeBoundary.runtime(MAINLINE_FILE_FINGERPRINT_SNAPSHOT_STORE_PATH)),
        jsonFileStore,
      );
    const projectIntelligenceRunner =
      this.#dependencies.projectIntelligenceRunner ??
      new MainlineProjectIntelligenceRunner({
        scanner,
        fileSystem,
        artifactStore,
        contextIndex,
        searchIndex,
      });
    const contentMiningRunner =
      this.#dependencies.contentMiningRunner ??
      new ContentMiningRunner(new CompileArtifactWriter(contextIndex));
    const recipeImpactAnalyzer =
      this.#dependencies.recipeImpactAnalyzer ?? new RecipeImpactAnalyzer();
    const sourceRefRepairService =
      this.#dependencies.sourceRefRepairService ?? new SourceRefRepairService();
    const recipeMarkdownStore =
      this.#dependencies.recipeMarkdownStore ??
      new RecipeMarkdownStore(writeBoundary, { fileStore });
    const jobLedger = this.#dependencies.jobLedger ?? new InMemoryMainlineJobLedger();

    return {
      workspacePaths,
      writeBoundary,
      fileStore,
      fileSystem,
      scanner,
      contextIndex,
      searchIndex,
      searchIndexStore,
      artifactStore,
      fingerprintStore,
      projectIntelligenceRunner,
      contentMiningRunner,
      recipeImpactAnalyzer,
      sourceRefRepairService,
      recipeMarkdownStore,
      jobLedger,
    };
  }
}

async function scanCompileFiles(
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

async function runProjectIntelligence(
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
    });
  }

  return runtime.projectIntelligenceRunner.run({
    projectRoot: request.projectRoot,
    generatedAt: request.generatedAt,
    ...(request.maxFileBytes === undefined ? {} : { maxFileBytes: request.maxFileBytes }),
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

function mergeExplicitFileChanges(
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

async function restoreSearchIndex(
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

function searchReport(
  projectIntelligence: MainlineProjectIntelligenceRunnerResult,
  input: {
    readonly restoredDocuments: number;
    readonly persistedSnapshot: MainlineSearchIndexSnapshot;
    readonly contentDocumentsUpserted: number;
  },
): MainlineCompileSessionSearchReport {
  return {
    restoredDocuments: input.restoredDocuments,
    persistedDocuments: input.persistedSnapshot.documents.length,
    projectDocumentsUpserted: projectIntelligence.materialized?.searchDocuments.length ?? 0,
    projectDocumentsRemoved: projectIntelligence.materialized?.removedSearchDocumentIds.length ?? 0,
    contentDocumentsUpserted: input.contentDocumentsUpserted,
  };
}

function recipeMarkdownReport(
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

function recipeMarkdownWritesToFiles(
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

function fileContentByPath(files: readonly MainlineFileFingerprintInput[]): Record<string, string> {
  return Object.fromEntries(
    files.flatMap((file) => (typeof file.content === "string" ? [[file.path, file.content]] : [])),
  );
}

function mergeCompileRecipes(
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

function recipeMarkdownWarning(warning: RecipeMarkdownLoadResult["warnings"][number]): string {
  return `Skipped ${warning.relativePath}: ${warning.message}.`;
}

function skippedFileWarning(
  skippedFile: MainlineProjectIntelligenceRunnerResult["skippedFiles"][number],
): string {
  return `Skipped ${skippedFile.path}: ${skippedFile.reason}.`;
}

function markProgress(
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

function reachCancelCheckpoint(
  checkpoints: MainlineCompileCancelCheckpoint[],
  kind: MainlineCompileCancelCheckpointKind,
): void {
  checkpoints.push({ kind, reached: true, cancellable: false });
}

function compileCancelReport(
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

function compileSessionJobResult(result: Omit<MainlineCompileSessionResult, "jobId">): unknown {
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

function jsonStoreTarget(
  target: ReturnType<MainlineWriteBoundary["runtime"]>,
): MainlineJsonZonedPath {
  return { path: target.absolute, zone: target.zone };
}

function jsonStoreTargetToCore(
  target: MainlineJsonZonedPath,
): ReturnType<MainlineWriteBoundary["runtime"]> {
  return {
    zone: "data",
    absolute: path.resolve(target.path),
    relative: path.basename(target.path),
  };
}

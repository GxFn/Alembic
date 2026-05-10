import path from "node:path";
import {
  MainlineSourceFileScanner,
  type MainlineSourceFileScanOptions,
  type MainlineSourceFileScanResult,
} from "../code/index.js";
import {
  type MainlineFileSystemPort,
  MainlineValidationError,
  NodeMainlineFileSystem,
} from "../core/index.js";
import type { ContextIndexWriter } from "../data/index.js";
import {
  type MainlineProjectIntelligenceArtifact,
  MainlineProjectIntelligenceBuilder,
  type MainlineProjectIntelligenceFileInput,
} from "../graph/index.js";
import { mergeMainlineProjectIntelligenceArtifact } from "./ProjectIntelligenceArtifactMerge.js";
import {
  InMemoryMainlineProjectIntelligenceArtifactStore,
  type MainlineProjectIntelligenceArtifactStore,
} from "./ProjectIntelligenceArtifactStore.js";
import {
  type MainlineProjectIntelligenceIncrementalPlan,
  MainlineProjectIntelligenceIncrementalPlanner,
  type MainlineProjectIntelligenceIncrementalPlanRequest,
} from "./ProjectIntelligenceIncrementalPlanner.js";
import {
  type MainlineProjectIntelligenceMaterializeResult,
  MainlineProjectIntelligenceMaterializer,
  type MainlineProjectIntelligenceSearchWriter,
  searchDocumentsFromProjectIntelligence,
  staleSourceRefsFromProjectIntelligence,
} from "./ProjectIntelligenceMaterializer.js";

export type MainlineProjectIntelligenceRunnerIncrementalRequest = Omit<
  MainlineProjectIntelligenceIncrementalPlanRequest,
  "artifact"
>;

export interface MainlineProjectIntelligenceRunnerRequest {
  readonly projectRoot: string;
  readonly files?: readonly MainlineProjectIntelligenceFileInput[];
  readonly scan?: Omit<MainlineSourceFileScanOptions, "root">;
  readonly generatedAt?: number;
  readonly maxFileBytes?: number;
  readonly materialize?: boolean;
  readonly incremental?: MainlineProjectIntelligenceRunnerIncrementalRequest;
}

export interface MainlineProjectIntelligenceRunnerDependencies {
  readonly scanner?: MainlineSourceFileScanner;
  readonly fileSystem?: Pick<MainlineFileSystemPort, "readText">;
  readonly builder?: MainlineProjectIntelligenceBuilder;
  readonly incrementalPlanner?: MainlineProjectIntelligenceIncrementalPlanner;
  readonly materializer?: MainlineProjectIntelligenceMaterializer;
  readonly artifactStore?: MainlineProjectIntelligenceArtifactStore;
  readonly contextIndex?: ContextIndexWriter;
  readonly searchIndex?: MainlineProjectIntelligenceSearchWriter;
}

export interface MainlineProjectIntelligenceSkippedFile {
  readonly path: string;
  readonly reason: "too-large" | "read-failed";
}

export interface MainlineProjectIntelligenceRunnerResult {
  readonly artifact: MainlineProjectIntelligenceArtifact;
  readonly patchArtifact?: MainlineProjectIntelligenceArtifact;
  readonly scanResult?: MainlineSourceFileScanResult;
  readonly incrementalPlan?: MainlineProjectIntelligenceIncrementalPlan;
  readonly materialized?: MainlineProjectIntelligenceMaterializeResult;
  readonly skippedFiles: MainlineProjectIntelligenceSkippedFile[];
}

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

/**
 * ProjectIntelligenceRunner 是冷启动/增量扫描进入新主干的编译期入口。
 * 它只负责源码发现、项目事实构建和物化，不回连旧 workflow，也不在这里生成 Recipe。
 */
export class MainlineProjectIntelligenceRunner {
  readonly #scanner: MainlineSourceFileScanner;
  readonly #fileSystem: Pick<MainlineFileSystemPort, "readText">;
  readonly #builder: MainlineProjectIntelligenceBuilder;
  readonly #incrementalPlanner: MainlineProjectIntelligenceIncrementalPlanner;
  readonly #materializer: MainlineProjectIntelligenceMaterializer;
  readonly #artifactStore: MainlineProjectIntelligenceArtifactStore;
  readonly #contextIndex: ContextIndexWriter | undefined;
  readonly #searchIndex: MainlineProjectIntelligenceSearchWriter | undefined;

  constructor(dependencies: MainlineProjectIntelligenceRunnerDependencies = {}) {
    this.#scanner = dependencies.scanner ?? new MainlineSourceFileScanner();
    this.#fileSystem = dependencies.fileSystem ?? new NodeMainlineFileSystem();
    this.#builder = dependencies.builder ?? new MainlineProjectIntelligenceBuilder();
    this.#incrementalPlanner =
      dependencies.incrementalPlanner ?? new MainlineProjectIntelligenceIncrementalPlanner();
    this.#materializer = dependencies.materializer ?? new MainlineProjectIntelligenceMaterializer();
    this.#artifactStore =
      dependencies.artifactStore ?? new InMemoryMainlineProjectIntelligenceArtifactStore();
    this.#contextIndex = dependencies.contextIndex;
    this.#searchIndex = dependencies.searchIndex;
  }

  async run(
    request: MainlineProjectIntelligenceRunnerRequest,
  ): Promise<MainlineProjectIntelligenceRunnerResult> {
    const maxFileBytes = request.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const skippedFiles: MainlineProjectIntelligenceSkippedFile[] = [];
    if (request.incremental) {
      return this.#runIncremental(
        { ...request, incremental: request.incremental },
        { maxFileBytes, skippedFiles },
      );
    }

    const scanResult = request.files
      ? undefined
      : await this.#scanner.scan({ root: request.projectRoot, ...request.scan });
    const files =
      request.files ??
      (await this.#readScannedFiles(scanResult, {
        maxFileBytes,
        skippedFiles,
      }));
    const artifact = await this.#builder.build({
      projectRoot: request.projectRoot,
      files,
      ...(request.generatedAt === undefined ? {} : { generatedAt: request.generatedAt }),
    });
    const materialized =
      request.materialize !== false
        ? await this.#materializer.materialize(artifact, this.#materializeTarget())
        : undefined;
    await this.#artifactStore.save(artifact);

    return {
      artifact,
      ...(scanResult === undefined ? {} : { scanResult }),
      ...(materialized === undefined ? {} : { materialized }),
      skippedFiles,
    };
  }

  async #readScannedFiles(
    scanResult: MainlineSourceFileScanResult | undefined,
    options: {
      readonly maxFileBytes: number;
      readonly skippedFiles: MainlineProjectIntelligenceSkippedFile[];
    },
  ): Promise<MainlineProjectIntelligenceFileInput[]> {
    const files: MainlineProjectIntelligenceFileInput[] = [];
    for (const file of scanResult?.files ?? []) {
      if (file.kind !== "source") {
        continue;
      }
      if (file.sizeBytes > options.maxFileBytes) {
        options.skippedFiles.push({ path: file.relativePath, reason: "too-large" });
        continue;
      }
      try {
        files.push({
          path: file.relativePath,
          content: await this.#fileSystem.readText(file.path),
          languageId: file.languageId,
        });
      } catch {
        options.skippedFiles.push({ path: file.relativePath, reason: "read-failed" });
      }
    }
    return files;
  }

  async #runIncremental(
    request: MainlineProjectIntelligenceRunnerRequest & {
      readonly incremental: MainlineProjectIntelligenceRunnerIncrementalRequest;
    },
    options: {
      readonly maxFileBytes: number;
      readonly skippedFiles: MainlineProjectIntelligenceSkippedFile[];
    },
  ): Promise<MainlineProjectIntelligenceRunnerResult> {
    const previousArtifact = await this.#loadPreviousArtifact(request.projectRoot);
    const incrementalPlan = this.#incrementalPlanner.plan({
      ...request.incremental,
      artifact: previousArtifact,
    });
    const files = await this.#readProjectFiles(request.projectRoot, incrementalPlan.filesToParse, {
      previousArtifact,
      maxFileBytes: options.maxFileBytes,
      skippedFiles: options.skippedFiles,
    });
    const patchArtifact = await this.#builder.build({
      projectRoot: request.projectRoot,
      files,
      ...(request.generatedAt === undefined ? {} : { generatedAt: request.generatedAt }),
    });
    const artifact = mergeMainlineProjectIntelligenceArtifact({
      previousArtifact,
      patchArtifact,
      incrementalPlan,
      ...(request.generatedAt === undefined ? {} : { generatedAt: request.generatedAt }),
    });
    const materialized =
      request.materialize !== false
        ? await this.#materializer.materialize(
            artifact,
            this.#materializeTarget(),
            incrementalMaterializeOptions(previousArtifact, artifact, incrementalPlan),
          )
        : undefined;
    await this.#artifactStore.save(artifact);

    return {
      artifact,
      patchArtifact,
      incrementalPlan,
      ...(materialized === undefined ? {} : { materialized }),
      skippedFiles: options.skippedFiles,
    };
  }

  async #readProjectFiles(
    projectRoot: string,
    relativePaths: readonly string[],
    options: {
      readonly previousArtifact: MainlineProjectIntelligenceArtifact;
      readonly maxFileBytes: number;
      readonly skippedFiles: MainlineProjectIntelligenceSkippedFile[];
    },
  ): Promise<MainlineProjectIntelligenceFileInput[]> {
    const languageByPath = new Map(
      options.previousArtifact.files.map((file) => [file.path, file.languageId]),
    );
    const files: MainlineProjectIntelligenceFileInput[] = [];

    for (const relativePath of relativePaths) {
      try {
        const content = await this.#fileSystem.readText(path.join(projectRoot, relativePath));
        if (Buffer.byteLength(content, "utf8") > options.maxFileBytes) {
          options.skippedFiles.push({ path: relativePath, reason: "too-large" });
          continue;
        }
        const languageId = languageByPath.get(relativePath);
        files.push({
          path: relativePath,
          content,
          ...(languageId === undefined ? {} : { languageId }),
        });
      } catch {
        options.skippedFiles.push({ path: relativePath, reason: "read-failed" });
      }
    }

    return files;
  }

  async #loadPreviousArtifact(projectRoot: string): Promise<MainlineProjectIntelligenceArtifact> {
    const artifact = await this.#artifactStore.load();
    if (!artifact) {
      throw new MainlineValidationError(
        "Project intelligence incremental run requires a saved baseline artifact.",
        { projectRoot },
      );
    }
    if (artifact.projectRoot && path.resolve(artifact.projectRoot) !== path.resolve(projectRoot)) {
      throw new MainlineValidationError(
        "Project intelligence baseline belongs to a different project root.",
        {
          expectedProjectRoot: path.resolve(projectRoot),
          actualProjectRoot: path.resolve(artifact.projectRoot),
        },
      );
    }
    return artifact;
  }

  #materializeTarget(): {
    readonly contextIndex?: ContextIndexWriter;
    readonly searchIndex?: MainlineProjectIntelligenceSearchWriter;
  } {
    return {
      ...(this.#contextIndex === undefined ? {} : { contextIndex: this.#contextIndex }),
      ...(this.#searchIndex === undefined ? {} : { searchIndex: this.#searchIndex }),
    };
  }
}

function incrementalMaterializeOptions(
  previousArtifact: MainlineProjectIntelligenceArtifact,
  nextArtifact: MainlineProjectIntelligenceArtifact,
  plan: MainlineProjectIntelligenceIncrementalPlan,
): {
  readonly staleSourceRefs: ReturnType<typeof staleSourceRefsFromProjectIntelligence>;
  readonly searchDocumentIdsToRemove: string[];
} {
  const nextSourceRefIds = new Set([
    ...nextArtifact.files.map((file) => file.path),
    ...nextArtifact.symbols.map((symbol) => symbol.id),
  ]);
  const staleSourceRefIds = uniqueStrings([
    ...plan.sourceRefIdsToStale,
    ...plan.sourceRefIdsToRefresh.filter((sourceRefId) => !nextSourceRefIds.has(sourceRefId)),
  ]);

  return {
    staleSourceRefs: staleSourceRefsFromProjectIntelligence(previousArtifact, staleSourceRefIds),
    searchDocumentIdsToRemove: searchDocumentIdsToRemove(previousArtifact, nextArtifact, plan),
  };
}

function searchDocumentIdsToRemove(
  previousArtifact: MainlineProjectIntelligenceArtifact,
  nextArtifact: MainlineProjectIntelligenceArtifact,
  plan: MainlineProjectIntelligenceIncrementalPlan,
): string[] {
  const nextDocumentIds = new Set(
    searchDocumentsFromProjectIntelligence(nextArtifact).map((document) => document.id),
  );
  const affectedFiles = new Set(plan.affectedFiles);
  const previousAffectedDocumentIds = searchDocumentsFromProjectIntelligence(previousArtifact)
    .filter((document) => documentBelongsToAffectedFile(document.path, document.id, affectedFiles))
    .map((document) => document.id);

  return uniqueStrings([
    ...plan.searchDocumentIdsToRemove,
    ...plan.searchDocumentIdsToRefresh.filter((documentId) => !nextDocumentIds.has(documentId)),
    ...previousAffectedDocumentIds.filter((documentId) => !nextDocumentIds.has(documentId)),
  ]);
}

function documentBelongsToAffectedFile(
  pathValue: string | undefined,
  documentId: string,
  affectedFiles: ReadonlySet<string>,
): boolean {
  if (pathValue && affectedFiles.has(pathValue)) {
    return true;
  }
  for (const filePath of affectedFiles) {
    if (documentId.includes(`file:${filePath}`) || documentId.includes(`symbol:${filePath}::`)) {
      return true;
    }
  }
  return false;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

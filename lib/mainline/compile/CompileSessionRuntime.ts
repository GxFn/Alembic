import path from "node:path";
import { MainlineSourceFileScanner } from "../../engineering/code/index.js";
import type { MainlineEmbeddingPort } from "../ai/index.js";
import {
  MainlineAtomicFileStore,
  type MainlineFileSystemPort,
  MainlineValidationError,
  MainlineWorkspacePaths,
  MainlineWriteBoundary,
  NodeMainlineFileSystem,
} from "../core/index.js";
import {
  type ContextIndexWriter,
  FileFingerprintSnapshotStore,
  InMemoryContextIndex,
  InMemoryMainlineJobLedger,
  type MainlineJobLedgerPort,
} from "../data/index.js";
import type {
  MainlineAtomicFileStore as MainlineJsonAtomicFileStore,
  MainlineZonedPath as MainlineJsonZonedPath,
} from "../data/JsonStores.js";
import { RecipeMarkdownStore } from "../knowledge/index.js";
import type { MainlineSearchIndex, MainlineVectorStore } from "../search/index.js";
import { InMemoryMainlineSearchIndex, MainlineSearchIndexStore } from "../search/index.js";
import { CompileArtifactWriter } from "./CompileArtifactWriter.js";
import {
  MainlineCompileSearchMaterializer,
  MainlineEmbeddingPortBatchEmbedder,
} from "./CompileSearchMaterializer.js";
import {
  MAINLINE_FILE_FINGERPRINT_SNAPSHOT_STORE_PATH,
  MAINLINE_SEARCH_INDEX_STORE_PATH,
} from "./CompileSessionPaths.js";
import { ContentMiningRunner } from "./ContentMiningRunner.js";
import {
  JsonMainlineEngineeringWorkflowArtifactStore,
  MAINLINE_ENGINEERING_CODE_GRAPH_STORE_PATH,
  MAINLINE_ENGINEERING_ENTITY_GRAPH_STORE_PATH,
  MAINLINE_ENGINEERING_PANORAMA_SNAPSHOT_STORE_PATH,
  MAINLINE_ENGINEERING_WORKFLOW_ARTIFACT_STORE_PATH,
  type MainlineEngineeringWorkflowArtifactStore,
} from "./EngineeringWorkflowArtifactStore.js";
import type {
  MainlineCompileSessionDependencies,
  MainlineCompileSessionRequest,
} from "./MainlineCompileSession.js";
import {
  JsonMainlineProjectIntelligenceArtifactStore,
  MAINLINE_PROJECT_INTELLIGENCE_ARTIFACT_STORE_PATH,
  type MainlineProjectIntelligenceArtifactStore,
} from "./ProjectIntelligenceArtifactStore.js";
import { MainlineProjectIntelligenceRunner } from "./ProjectIntelligenceRunner.js";
import { RecipeImpactAnalyzer } from "./RecipeImpactAnalyzer.js";
import { SourceRefRepairService } from "./SourceRefRepairService.js";

export interface MainlineCompileSessionRuntime {
  readonly workspacePaths: MainlineWorkspacePaths;
  readonly writeBoundary: MainlineWriteBoundary;
  readonly fileStore: MainlineAtomicFileStore;
  readonly fileSystem: Pick<MainlineFileSystemPort, "readText">;
  readonly scanner: MainlineSourceFileScanner;
  readonly contextIndex: ContextIndexWriter;
  readonly searchIndex: MainlineSearchIndex;
  readonly vectorStore?: MainlineVectorStore;
  readonly embeddingProvider?: MainlineEmbeddingPort;
  readonly searchIndexStore: MainlineSearchIndexStore;
  readonly artifactStore: MainlineProjectIntelligenceArtifactStore;
  readonly engineeringWorkflowArtifactStore: MainlineEngineeringWorkflowArtifactStore;
  readonly fingerprintStore: FileFingerprintSnapshotStore;
  readonly projectIntelligenceRunner: MainlineProjectIntelligenceRunner;
  readonly contentMiningRunner: ContentMiningRunner;
  readonly recipeImpactAnalyzer: RecipeImpactAnalyzer;
  readonly sourceRefRepairService: SourceRefRepairService;
  readonly recipeMarkdownStore: RecipeMarkdownStore;
  readonly searchMaterializer: MainlineCompileSearchMaterializer;
  readonly jobLedger: MainlineJobLedgerPort;
}

export function createMainlineCompileSessionRuntime(
  dependencies: MainlineCompileSessionDependencies,
  projectRoot: string,
  request: Pick<MainlineCompileSessionRequest, "workspace">,
): MainlineCompileSessionRuntime {
  const workspacePaths =
    dependencies.workspacePaths ??
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

  const writeBoundary = dependencies.writeBoundary ?? new MainlineWriteBoundary({ workspacePaths });
  const fileStore = dependencies.fileStore ?? new MainlineAtomicFileStore();
  const jsonFileStore = new MainlineJsonFileStoreAdapter(fileStore);
  const fileSystem = dependencies.fileSystem ?? new NodeMainlineFileSystem();
  const scanner = dependencies.scanner ?? new MainlineSourceFileScanner();
  const contextIndex = dependencies.contextIndex ?? new InMemoryContextIndex();
  const searchIndex = dependencies.searchIndex ?? new InMemoryMainlineSearchIndex();
  const vectorStore = dependencies.vectorStore;
  const embeddingProvider = dependencies.embeddingProvider;
  const searchIndexStore =
    dependencies.searchIndexStore ??
    new MainlineSearchIndexStore(
      jsonStoreTarget(writeBoundary.runtime(MAINLINE_SEARCH_INDEX_STORE_PATH)),
      jsonFileStore,
    );
  const artifactStore =
    dependencies.artifactStore ??
    new JsonMainlineProjectIntelligenceArtifactStore(
      jsonStoreTarget(writeBoundary.runtime(MAINLINE_PROJECT_INTELLIGENCE_ARTIFACT_STORE_PATH)),
      jsonFileStore,
    );
  const engineeringWorkflowArtifactStore =
    dependencies.engineeringWorkflowArtifactStore ??
    new JsonMainlineEngineeringWorkflowArtifactStore(
      {
        workflowResult: jsonStoreTarget(
          writeBoundary.runtime(MAINLINE_ENGINEERING_WORKFLOW_ARTIFACT_STORE_PATH),
        ),
        codeGraph: jsonStoreTarget(
          writeBoundary.runtime(MAINLINE_ENGINEERING_CODE_GRAPH_STORE_PATH),
        ),
        entityGraph: jsonStoreTarget(
          writeBoundary.runtime(MAINLINE_ENGINEERING_ENTITY_GRAPH_STORE_PATH),
        ),
        panoramaSnapshot: jsonStoreTarget(
          writeBoundary.runtime(MAINLINE_ENGINEERING_PANORAMA_SNAPSHOT_STORE_PATH),
        ),
      },
      jsonFileStore,
    );
  const fingerprintStore =
    dependencies.fingerprintStore ??
    new FileFingerprintSnapshotStore(
      jsonStoreTarget(writeBoundary.runtime(MAINLINE_FILE_FINGERPRINT_SNAPSHOT_STORE_PATH)),
      jsonFileStore,
    );
  const projectIntelligenceRunner =
    dependencies.projectIntelligenceRunner ??
    new MainlineProjectIntelligenceRunner({
      scanner,
      fileSystem,
      artifactStore,
      engineeringWorkflowArtifactStore,
      contextIndex,
      searchIndex,
    });
  const contentMiningRunner =
    dependencies.contentMiningRunner ??
    new ContentMiningRunner(new CompileArtifactWriter(contextIndex));
  const recipeImpactAnalyzer = dependencies.recipeImpactAnalyzer ?? new RecipeImpactAnalyzer();
  const sourceRefRepairService =
    dependencies.sourceRefRepairService ?? new SourceRefRepairService();
  const recipeMarkdownStore =
    dependencies.recipeMarkdownStore ?? new RecipeMarkdownStore(writeBoundary, { fileStore });
  const searchEmbedder =
    embeddingProvider === undefined
      ? undefined
      : new MainlineEmbeddingPortBatchEmbedder(embeddingProvider);
  const searchMaterializer =
    dependencies.searchMaterializer ??
    new MainlineCompileSearchMaterializer({
      searchIndex,
      ...(vectorStore === undefined ? {} : { vectorStore }),
      ...(searchEmbedder === undefined ? {} : { embedder: searchEmbedder }),
    });
  const jobLedger = dependencies.jobLedger ?? new InMemoryMainlineJobLedger();

  return {
    workspacePaths,
    writeBoundary,
    fileStore,
    fileSystem,
    scanner,
    contextIndex,
    searchIndex,
    ...(vectorStore === undefined ? {} : { vectorStore }),
    ...(embeddingProvider === undefined ? {} : { embeddingProvider }),
    searchIndexStore,
    artifactStore,
    engineeringWorkflowArtifactStore,
    fingerprintStore,
    projectIntelligenceRunner,
    contentMiningRunner,
    recipeImpactAnalyzer,
    sourceRefRepairService,
    recipeMarkdownStore,
    searchMaterializer,
    jobLedger,
  };
}

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

import type { MainlineEmbeddingPort } from "../../mainline/ai/index.js";
import type { MainlineSourceFileScanOptions } from "../../mainline/code/index.js";
import {
  MainlineCompileSession,
  type MainlineProjectIntelligenceArtifactStore,
} from "../../mainline/compile/index.js";
import type { ContextIndexWriter } from "../../mainline/data/index.js";
import type { MainlineProjectIntelligenceArtifact } from "../../mainline/graph/index.js";
import type {
  MainlineSearchDocument,
  MainlineSearchIndex,
  MainlineVectorStore,
} from "../../mainline/search/index.js";
import { type ScanLifecycleRunInput, ScanLifecycleRunner } from "../scan/ScanLifecycleRunner.js";
import type {
  MainlineWorkflowCancellationToken,
  MainlineWorkflowKind,
  MainlineWorkflowPhaseRecord,
  MainlineWorkflowStatus,
} from "../scan/ScanWorkflowKernel.js";

export interface MainlineWorkflowRunInput {
  readonly kind: MainlineWorkflowKind;
  readonly projectRoot: string;
  readonly scan?: Partial<MainlineSourceFileScanOptions>;
  readonly changedFiles?: readonly string[];
  readonly removedFiles?: readonly string[];
  readonly diffTextByPath?: Record<string, string>;
  readonly cancellation?: MainlineWorkflowCancellationToken;
}

export interface MainlineWorkflowEntrypointDependencies {
  readonly compileSession?: MainlineCompileSession;
  readonly lifecycleRunner?: ScanLifecycleRunner;
  readonly contextIndex?: ContextIndexWriter;
  readonly searchIndex?: MainlineSearchIndex;
  readonly vectorStore?: MainlineVectorStore;
  readonly embeddingProvider?: MainlineEmbeddingPort;
  readonly artifactStore?: MainlineProjectIntelligenceArtifactStore;
  readonly persistence?: MainlineWorkflowPersistence;
  readonly persistedArtifacts?: MainlineWorkflowPersistedArtifacts;
  readonly resetRuntimeState?: () => Promise<void>;
  readonly now?: () => Date;
}

export interface MainlineWorkflowPersistenceInput {
  readonly kind: MainlineWorkflowKind;
  readonly projectRoot: string;
  readonly artifact: MainlineProjectIntelligenceArtifact;
  readonly searchDocuments: readonly MainlineSearchDocument[];
}

export interface MainlineWorkflowPersistedArtifacts {
  readonly artifactPath?: string;
  readonly contextSnapshotPath?: string;
  readonly searchSnapshotPath?: string;
  readonly vectorSnapshotPath?: string;
  readonly fingerprintSnapshotPath?: string;
  readonly recipeMarkdownRoot?: string;
}

export interface MainlineWorkflowPersistence {
  saveSnapshots(
    input: MainlineWorkflowPersistenceInput,
  ): Promise<MainlineWorkflowPersistedArtifacts>;
}

export interface MainlineWorkflowSideEffects {
  readonly wiki: false;
  readonly delivery: false;
  readonly semanticMemory: false;
}

export interface MainlineWorkflowResult {
  readonly kind: MainlineWorkflowKind;
  readonly status: MainlineWorkflowStatus;
  readonly phases: readonly MainlineWorkflowPhaseRecord[];
  readonly projectRoot: string;
  readonly summary: {
    readonly scannedFiles: number;
    readonly sourceFiles: number;
    readonly selectedFiles: number;
    readonly parsedFiles: number;
    readonly symbols: number;
    readonly semanticEdges: number;
    readonly sourceRefs: number;
    readonly searchDocuments: number;
    readonly recipes: number;
    readonly truncated: boolean;
  };
  readonly persisted?: MainlineWorkflowPersistedArtifacts;
  readonly skippedSideEffects: MainlineWorkflowSideEffects;
  readonly warnings: readonly string[];
}

const SKIPPED_SIDE_EFFECTS: MainlineWorkflowSideEffects = {
  wiki: false,
  delivery: false,
  semanticMemory: false,
};

/**
 * MainlineWorkflowEntrypoint 保留原 workflow 调用面，但内部统一交给 ScanLifecycleRunner。
 * 中文注释：旧入口不再手写 scan/read/build/materialize 分支，避免冷启动和 rescan 绕过完整主线链路。
 */
export class MainlineWorkflowEntrypoint {
  readonly #lifecycleRunner: ScanLifecycleRunner;

  constructor(dependencies: MainlineWorkflowEntrypointDependencies = {}) {
    this.#lifecycleRunner =
      dependencies.lifecycleRunner ??
      new ScanLifecycleRunner({
        compileSession:
          dependencies.compileSession ??
          new MainlineCompileSession({
            ...(dependencies.contextIndex === undefined
              ? {}
              : { contextIndex: dependencies.contextIndex }),
            ...(dependencies.searchIndex === undefined
              ? {}
              : { searchIndex: dependencies.searchIndex }),
            ...(dependencies.vectorStore === undefined
              ? {}
              : { vectorStore: dependencies.vectorStore }),
            ...(dependencies.embeddingProvider === undefined
              ? {}
              : { embeddingProvider: dependencies.embeddingProvider }),
            ...(dependencies.artifactStore === undefined
              ? {}
              : { artifactStore: dependencies.artifactStore }),
          }),
        ...(dependencies.resetRuntimeState === undefined
          ? {}
          : { resetRuntimeState: dependencies.resetRuntimeState }),
        ...(dependencies.persistedArtifacts === undefined
          ? {}
          : { persistedArtifacts: dependencies.persistedArtifacts }),
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      });
  }

  async run(input: MainlineWorkflowRunInput): Promise<MainlineWorkflowResult> {
    const lifecycle = await this.#lifecycleRunner.run(toLifecycleInput(input));
    return {
      kind: lifecycle.kind,
      status: lifecycle.status,
      phases: lifecycle.phases,
      projectRoot: lifecycle.projectRoot,
      summary: {
        scannedFiles: lifecycle.summary.scannedFiles,
        sourceFiles: lifecycle.summary.sourceFiles,
        selectedFiles: lifecycle.summary.selectedFiles,
        parsedFiles: lifecycle.summary.parsedFiles,
        symbols: lifecycle.summary.symbols,
        semanticEdges: lifecycle.summary.semanticEdges,
        sourceRefs: lifecycle.summary.sourceRefs,
        searchDocuments: lifecycle.summary.searchDocuments,
        recipes: lifecycle.summary.recipes,
        truncated: lifecycle.summary.truncated,
      },
      ...(lifecycle.persisted === undefined ? {} : { persisted: lifecycle.persisted }),
      skippedSideEffects: SKIPPED_SIDE_EFFECTS,
      warnings: lifecycle.warnings,
    };
  }
}

function toLifecycleInput(input: MainlineWorkflowRunInput): ScanLifecycleRunInput {
  const scan = scanWithoutRoot(input.scan);
  return {
    kind: input.kind,
    projectRoot: input.projectRoot,
    ...(scan === undefined ? {} : { scan }),
    ...(input.changedFiles === undefined ? {} : { changedFiles: input.changedFiles }),
    ...(input.removedFiles === undefined ? {} : { removedFiles: input.removedFiles }),
    ...(input.diffTextByPath === undefined ? {} : { diffTextByPath: input.diffTextByPath }),
    ...(input.cancellation === undefined ? {} : { cancellation: input.cancellation }),
    source: "workflow",
  };
}

function scanWithoutRoot(
  scan: Partial<MainlineSourceFileScanOptions> | undefined,
): Omit<MainlineSourceFileScanOptions, "root"> | undefined {
  if (scan === undefined) {
    return undefined;
  }
  return {
    ...(scan.maxDepth === undefined ? {} : { maxDepth: scan.maxDepth }),
    ...(scan.maxFiles === undefined ? {} : { maxFiles: scan.maxFiles }),
    ...(scan.includeTests === undefined ? {} : { includeTests: scan.includeTests }),
    ...(scan.includeDocs === undefined ? {} : { includeDocs: scan.includeDocs }),
    ...(scan.includeMarkdown === undefined ? {} : { includeMarkdown: scan.includeMarkdown }),
    ...(scan.skipDirs === undefined ? {} : { skipDirs: scan.skipDirs }),
  };
}

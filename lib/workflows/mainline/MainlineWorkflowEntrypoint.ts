import fs from "node:fs/promises";
import {
  MainlineSourceFileScanner,
  type MainlineSourceFileScanOptions,
  type MainlineSourceFileScanResult,
} from "../../mainline/code/index.js";
import {
  type MainlineProjectIntelligenceArtifactStore,
  MainlineProjectIntelligenceMaterializer,
} from "../../mainline/compile/index.js";
import type { ContextIndexWriter } from "../../mainline/data/index.js";
import {
  type MainlineProjectIntelligenceArtifact,
  MainlineProjectIntelligenceBuilder,
} from "../../mainline/graph/index.js";
import type { MainlineSearchDocument, MainlineSearchIndex } from "../../mainline/search/index.js";
import {
  type MainlineWorkflowCancellationToken,
  MainlineWorkflowCancelledError,
  type MainlineWorkflowKind,
  type MainlineWorkflowPhaseRecord,
  type MainlineWorkflowStatus,
  ScanWorkflowKernel,
} from "../scan/ScanWorkflowKernel.js";

export interface MainlineWorkflowRunInput {
  readonly kind: MainlineWorkflowKind;
  readonly projectRoot: string;
  readonly scan?: Partial<MainlineSourceFileScanOptions>;
  readonly changedFiles?: readonly string[];
  readonly cancellation?: MainlineWorkflowCancellationToken;
}

export interface MainlineWorkflowEntrypointDependencies {
  readonly scanner?: MainlineSourceFileScanner;
  readonly projectIntelligenceBuilder?: MainlineProjectIntelligenceBuilder;
  readonly materializer?: MainlineProjectIntelligenceMaterializer;
  readonly contextIndex?: ContextIndexWriter;
  readonly searchIndex?: Pick<MainlineSearchIndex, "remove" | "upsert">;
  readonly artifactStore?: MainlineProjectIntelligenceArtifactStore;
  readonly persistence?: MainlineWorkflowPersistence;
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
    readonly recipes: 0;
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

export class MainlineWorkflowEntrypoint {
  readonly #scanner: MainlineSourceFileScanner;
  readonly #builder: MainlineProjectIntelligenceBuilder;
  readonly #materializer: MainlineProjectIntelligenceMaterializer;
  readonly #contextIndex: ContextIndexWriter | undefined;
  readonly #searchIndex: Pick<MainlineSearchIndex, "remove" | "upsert"> | undefined;
  readonly #artifactStore: MainlineProjectIntelligenceArtifactStore | undefined;
  readonly #persistence: MainlineWorkflowPersistence | undefined;
  readonly #now: () => Date;

  constructor(dependencies: MainlineWorkflowEntrypointDependencies = {}) {
    this.#scanner = dependencies.scanner ?? new MainlineSourceFileScanner();
    this.#builder =
      dependencies.projectIntelligenceBuilder ?? new MainlineProjectIntelligenceBuilder();
    this.#materializer = dependencies.materializer ?? new MainlineProjectIntelligenceMaterializer();
    this.#contextIndex = dependencies.contextIndex;
    this.#searchIndex = dependencies.searchIndex;
    this.#artifactStore = dependencies.artifactStore;
    this.#persistence = dependencies.persistence;
    this.#now = dependencies.now ?? (() => new Date());
  }

  async run(input: MainlineWorkflowRunInput): Promise<MainlineWorkflowResult> {
    const kernel = new ScanWorkflowKernel({
      ...(input.cancellation ? { cancellation: input.cancellation } : {}),
      now: this.#now,
    });
    const warnings: string[] = [];
    let scanResult: MainlineSourceFileScanResult | null = null;
    let selectedFiles = 0;
    let artifact: MainlineProjectIntelligenceArtifact | null = null;
    let sourceRefs = 0;
    let searchDocuments = 0;
    let materializedSearchDocuments: readonly MainlineSearchDocument[] = [];
    let persisted: MainlineWorkflowPersistedArtifacts | undefined;

    try {
      scanResult = await kernel.runPhase("scan", () =>
        this.#scanner.scan({
          root: input.projectRoot,
          maxFiles: 1_000,
          includeTests: false,
          includeDocs: false,
          includeMarkdown: false,
          ...input.scan,
        }),
      );

      const files = await kernel.runPhase("read-files", () =>
        readProjectIntelligenceFiles(scanResult as MainlineSourceFileScanResult, input),
      );
      selectedFiles = files.length;

      artifact = await kernel.runPhase("build-project-intelligence", () =>
        this.#builder.build({
          projectRoot: input.projectRoot,
          knownFiles:
            scanResult?.files
              .filter((file) => file.kind === "source")
              .map((file) => file.relativePath) ?? [],
          files,
          generatedAt: this.#now().getTime(),
        }),
      );

      const materialized = await kernel.runPhase("materialize-project-intelligence", () =>
        this.#materializer.materialize(artifact as MainlineProjectIntelligenceArtifact, {
          ...(this.#contextIndex ? { contextIndex: this.#contextIndex } : {}),
          ...(this.#searchIndex ? { searchIndex: this.#searchIndex } : {}),
        }),
      );
      sourceRefs = materialized.sourceRefs.length;
      searchDocuments = materialized.searchDocuments.length;
      materializedSearchDocuments = materialized.searchDocuments;

      await kernel.runPhase("save-artifact", async () => {
        await this.#artifactStore?.save(artifact as MainlineProjectIntelligenceArtifact);
        persisted = await this.#persistence?.saveSnapshots({
          kind: input.kind,
          projectRoot: input.projectRoot,
          artifact: artifact as MainlineProjectIntelligenceArtifact,
          searchDocuments: materializedSearchDocuments,
        });
      });

      warnings.push("recipe_generation_deferred");
      return this.#result(input, "completed", kernel.phases, scanResult, {
        selectedFiles,
        artifact,
        sourceRefs,
        searchDocuments,
        ...(persisted ? { persisted } : {}),
        warnings,
      });
    } catch (error) {
      if (error instanceof MainlineWorkflowCancelledError) {
        warnings.push(`cancelled_before_${error.phase}`);
        return this.#result(input, "cancelled", kernel.phases, scanResult, {
          selectedFiles,
          artifact,
          sourceRefs,
          searchDocuments,
          ...(persisted ? { persisted } : {}),
          warnings,
        });
      }
      throw error;
    }
  }

  #result(
    input: MainlineWorkflowRunInput,
    status: MainlineWorkflowStatus,
    phases: readonly MainlineWorkflowPhaseRecord[],
    scanResult: MainlineSourceFileScanResult | null,
    partial: {
      readonly selectedFiles: number;
      readonly artifact: MainlineProjectIntelligenceArtifact | null;
      readonly sourceRefs: number;
      readonly searchDocuments: number;
      readonly persisted?: MainlineWorkflowPersistedArtifacts;
      readonly warnings: readonly string[];
    },
  ): MainlineWorkflowResult {
    return {
      kind: input.kind,
      status,
      phases,
      projectRoot: input.projectRoot,
      summary: {
        scannedFiles: scanResult?.metadata.totalFiles ?? 0,
        sourceFiles: scanResult?.metadata.sourceFiles ?? 0,
        selectedFiles: partial.selectedFiles,
        parsedFiles: partial.artifact?.files.filter((file) => file.status === "parsed").length ?? 0,
        symbols: partial.artifact?.symbols.length ?? 0,
        semanticEdges: partial.artifact?.semanticEdges.length ?? 0,
        sourceRefs: partial.sourceRefs,
        searchDocuments: partial.searchDocuments,
        recipes: 0,
        truncated: scanResult?.truncated ?? false,
      },
      ...(partial.persisted ? { persisted: partial.persisted } : {}),
      skippedSideEffects: SKIPPED_SIDE_EFFECTS,
      warnings: partial.warnings,
    };
  }
}

async function readProjectIntelligenceFiles(
  scanResult: MainlineSourceFileScanResult,
  input: MainlineWorkflowRunInput,
) {
  const changedFileSet =
    input.kind === "rescan" && input.changedFiles && input.changedFiles.length > 0
      ? new Set(input.changedFiles)
      : null;
  const files = scanResult.files.filter(
    (file) =>
      file.kind === "source" &&
      (!changedFileSet || changedFileSet.has(file.relativePath) || changedFileSet.has(file.path)),
  );

  const result = [];
  for (const file of files) {
    result.push({
      path: file.relativePath,
      content: await fs.readFile(file.path, "utf8"),
      languageId: file.languageId,
    });
  }
  return result;
}

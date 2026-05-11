import fs from "node:fs/promises";
import path from "node:path";
import type { MainlineSourceFileScanOptions } from "../../engineering/code/index.js";
import {
  MainlineCompileSession,
  type MainlineCompileSessionRequest,
  type MainlineCompileSessionResult,
} from "../../mainline/compile/index.js";
import {
  epochSecondsNow,
  type MainlineWorkspacePathInput,
  MainlineWorkspacePaths,
  normalizeMainlinePosixPath,
  uniqueMainlinePosixPaths,
} from "../../mainline/core/index.js";
import type { Recipe } from "../../mainline/knowledge/index.js";
import {
  type MainlineWorkflowCancellationToken,
  MainlineWorkflowCancelledError,
  type MainlineWorkflowKind,
  type MainlineWorkflowPhaseRecord,
  type MainlineWorkflowStatus,
  ScanWorkflowKernel,
} from "./ScanWorkflowKernel.js";

export type ScanLifecycleCleanupPolicy = "full-reset" | "rescan-clean" | "none";

export interface ScanLifecycleRunInput {
  readonly kind: MainlineWorkflowKind;
  readonly projectRoot: string;
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
  readonly cleanup?: ScanLifecycleCleanupPolicy;
  readonly source?: "daemon" | "workflow" | "codex" | "cli" | "test";
  readonly cancellation?: MainlineWorkflowCancellationToken;
  readonly persistedArtifacts?: ScanLifecyclePersistedArtifacts;
}

export interface ScanLifecyclePersistedArtifacts {
  readonly artifactPath?: string;
  readonly contextSnapshotPath?: string;
  readonly searchSnapshotPath?: string;
  readonly vectorSnapshotPath?: string;
  readonly fingerprintSnapshotPath?: string;
  readonly recipeMarkdownRoot?: string;
}

export interface ScanLifecyclePlan {
  readonly mode: MainlineCompileSessionRequest["mode"];
  readonly cleanupPolicy: ScanLifecycleCleanupPolicy;
  readonly requiresBaseline: boolean;
  readonly generatedAt: number;
  readonly scan: Omit<MainlineSourceFileScanOptions, "root">;
  readonly changedFileCount: number;
  readonly removedFileCount: number;
  readonly diffFileCount: number;
  readonly recipeCount: number;
  readonly notesCount: number;
}

export interface ScanLifecycleCleanupReport {
  readonly policy: ScanLifecycleCleanupPolicy;
  readonly removedPaths: readonly string[];
  readonly preservedPaths: readonly string[];
  readonly warnings: readonly string[];
}

export interface ScanLifecycleSummary {
  readonly scannedFiles: number;
  readonly sourceFiles: number;
  readonly selectedFiles: number;
  readonly parsedFiles: number;
  readonly symbols: number;
  readonly semanticEdges: number;
  readonly sourceRefs: number;
  readonly searchDocuments: number;
  readonly recipes: number;
  readonly recipeMarkdownFiles: number;
  readonly addedFiles: number;
  readonly modifiedFiles: number;
  readonly deletedFiles: number;
  readonly movedFiles: number;
  readonly recipeImpacts: number;
  readonly repairedSourceRefs: number;
  readonly staleSourceRefs: number;
  readonly truncated: boolean;
}

export interface ScanLifecycleEvidence {
  readonly origin: "snapshot" | "diff";
  readonly fingerprintDiff: MainlineCompileSessionResult["fingerprintDiff"];
  readonly projectPanorama: MainlineCompileSessionResult["projectPanorama"];
  readonly sourceRefRepair: MainlineCompileSessionResult["sourceRefRepair"]["summary"];
  readonly recipeImpact: MainlineCompileSessionResult["recipeImpact"]["summary"];
  readonly recipeMarkdown: MainlineCompileSessionResult["recipeMarkdown"];
  readonly search: MainlineCompileSessionResult["search"];
  readonly compileJobId?: string;
}

export interface ScanLifecycleRecommendation {
  readonly id: string;
  readonly priority: "low" | "medium" | "high";
  readonly reason: string;
  readonly action: string;
}

export interface ScanLifecycleResult {
  readonly kind: MainlineWorkflowKind;
  readonly status: MainlineWorkflowStatus;
  readonly mode: MainlineCompileSessionRequest["mode"];
  readonly projectRoot: string;
  readonly phases: readonly MainlineWorkflowPhaseRecord[];
  readonly plan: ScanLifecyclePlan;
  readonly cleanup: ScanLifecycleCleanupReport;
  readonly summary: ScanLifecycleSummary;
  readonly evidence?: ScanLifecycleEvidence;
  readonly compile?: MainlineCompileSessionResult;
  readonly recommendations: readonly ScanLifecycleRecommendation[];
  readonly persisted?: ScanLifecyclePersistedArtifacts;
  readonly warnings: readonly string[];
}

export interface ScanLifecycleRunnerDependencies {
  readonly workspacePaths?: MainlineWorkspacePaths;
  readonly compileSession?: MainlineCompileSession;
  readonly resetRuntimeState?: () => Promise<void>;
  readonly persistedArtifacts?: ScanLifecyclePersistedArtifacts;
  readonly now?: () => Date;
}

interface NormalizedScanLifecycleInput extends ScanLifecycleRunInput {
  readonly projectRoot: string;
  readonly mode: MainlineCompileSessionRequest["mode"];
  readonly workspacePaths: MainlineWorkspacePaths;
  readonly changedFiles: readonly string[];
  readonly removedFiles: readonly string[];
  readonly diffTextByPath: Record<string, string>;
  readonly notes: readonly string[];
  readonly generatedAt: number;
}

/**
 * ScanLifecycleRunner 是冷启动与增量扫描的统一业务链路。
 * 中文注释：它负责 Normalize/Plan/Track/Execute/Project/Persist/Recommend；
 * 真正的文件事实、Recipe、SourceRef、SearchIndex 编译仍由 MainlineCompileSession 完成。
 */
export class ScanLifecycleRunner {
  readonly #dependencies: ScanLifecycleRunnerDependencies;

  constructor(dependencies: ScanLifecycleRunnerDependencies = {}) {
    this.#dependencies = dependencies;
  }

  async run(input: ScanLifecycleRunInput): Promise<ScanLifecycleResult> {
    const kernel = new ScanWorkflowKernel({
      ...(input.cancellation ? { cancellation: input.cancellation } : {}),
      ...(this.#dependencies.now === undefined ? {} : { now: this.#dependencies.now }),
    });
    let normalized: NormalizedScanLifecycleInput | undefined;
    let plan: ScanLifecyclePlan | undefined;
    let cleanup: ScanLifecycleCleanupReport = skippedCleanupReport("none");
    let evidence: ScanLifecycleEvidence | undefined;
    let summary = emptyScanLifecycleSummary();
    let recommendations: readonly ScanLifecycleRecommendation[] = [];
    const warnings: string[] = [];

    try {
      const normalizedInput = await kernel.runPhase("normalize", async () =>
        this.#normalize(input),
      );
      normalized = normalizedInput;
      const lifecyclePlan = await kernel.runPhase("plan", async () =>
        buildScanLifecyclePlan(normalizedInput),
      );
      plan = lifecyclePlan;
      cleanup = await kernel.runPhase("track", () => {
        const cleanupInput = {
          policy: lifecyclePlan.cleanupPolicy,
          workspacePaths: normalizedInput.workspacePaths,
          ...(this.#dependencies.resetRuntimeState === undefined
            ? {}
            : { resetRuntimeState: this.#dependencies.resetRuntimeState }),
        };
        return applyScanLifecycleCleanup(cleanupInput);
      });
      const compileResult = await kernel.runPhase("compile-session", () =>
        this.#compileSession().run(toCompileSessionRequest(normalizedInput)),
      );
      ({ evidence, summary } = await kernel.runPhase("project", async () =>
        projectScanLifecycleResult(compileResult),
      ));
      await kernel.runPhase("persist", async () => undefined);
      recommendations = await kernel.runPhase("recommend", async () =>
        recommendNextActions({
          kind: input.kind,
          summary,
          compile: compileResult,
          cleanup,
        }),
      );

      warnings.push(...cleanup.warnings, ...compileResult.warnings);
      return buildScanLifecycleResult({
        input,
        normalized: normalizedInput,
        plan: lifecyclePlan,
        cleanup,
        status: "completed",
        phases: kernel.phases,
        summary,
        evidence,
        compile: compileResult,
        recommendations,
        warnings,
        ...persistedResult(input.persistedArtifacts ?? this.#dependencies.persistedArtifacts),
      });
    } catch (error) {
      if (error instanceof MainlineWorkflowCancelledError) {
        warnings.push(`cancelled_before_${error.phase}`);
        return buildScanLifecycleResult({
          input,
          ...(normalized === undefined ? {} : { normalized }),
          ...(plan === undefined ? {} : { plan }),
          cleanup,
          status: "cancelled",
          phases: kernel.phases,
          summary,
          recommendations,
          warnings,
          ...persistedResult(input.persistedArtifacts ?? this.#dependencies.persistedArtifacts),
        });
      }
      throw error;
    }
  }

  #normalize(input: ScanLifecycleRunInput): NormalizedScanLifecycleInput {
    const projectRoot = path.resolve(input.projectRoot);
    const mode = input.kind === "bootstrap" ? "cold-start" : "incremental";
    const workspacePaths =
      this.#dependencies.workspacePaths ??
      new MainlineWorkspacePaths({
        projectRoot,
        ...(input.workspace ?? {}),
      });
    const generatedAt = input.generatedAt ?? epochSecondsNow();

    return {
      ...input,
      projectRoot,
      mode,
      workspacePaths,
      changedFiles: uniqueMainlinePosixPaths(input.changedFiles ?? []),
      removedFiles: uniqueMainlinePosixPaths(input.removedFiles ?? []),
      diffTextByPath: normalizeDiffTextByPath(input.diffTextByPath ?? {}),
      notes: [...(input.notes ?? [])].filter((note) => note.trim().length > 0),
      generatedAt,
    };
  }

  #compileSession(): MainlineCompileSession {
    return this.#dependencies.compileSession ?? new MainlineCompileSession();
  }
}

function buildScanLifecyclePlan(input: NormalizedScanLifecycleInput): ScanLifecyclePlan {
  const cleanupPolicy =
    input.cleanup ?? (input.kind === "bootstrap" ? "full-reset" : "rescan-clean");
  return {
    mode: input.mode,
    cleanupPolicy,
    requiresBaseline: input.mode === "incremental",
    generatedAt: input.generatedAt,
    scan: normalizeScanOptions(input.scan),
    changedFileCount: input.changedFiles.length,
    removedFileCount: input.removedFiles.length,
    diffFileCount: Object.keys(input.diffTextByPath).length,
    recipeCount: input.recipes?.length ?? 0,
    notesCount: input.notes.length,
  };
}

async function applyScanLifecycleCleanup(input: {
  readonly policy: ScanLifecycleCleanupPolicy;
  readonly workspacePaths: MainlineWorkspacePaths;
  readonly resetRuntimeState?: () => Promise<void>;
}): Promise<ScanLifecycleCleanupReport> {
  if (input.policy === "none") {
    return skippedCleanupReport("none");
  }

  const removedPaths: string[] = [];
  const preservedPaths: string[] = [];
  const warnings: string[] = [];

  if (input.policy === "full-reset") {
    const candidates = [
      input.workspacePaths.snapshot().contextDir,
      input.workspacePaths.snapshot().cacheDir,
      input.workspacePaths.snapshot().candidatesDir,
    ];
    for (const candidate of candidates) {
      await removePath(candidate, removedPaths, warnings);
    }
    preservedPaths.push(input.workspacePaths.snapshot().recipesDir);
  } else {
    await removePath(input.workspacePaths.snapshot().cacheDir, removedPaths, warnings);
    preservedPaths.push(
      input.workspacePaths.snapshot().contextDir,
      input.workspacePaths.snapshot().recipesDir,
    );
  }

  if (input.policy === "full-reset") {
    await input.resetRuntimeState?.();
  }

  return { policy: input.policy, removedPaths, preservedPaths, warnings };
}

async function removePath(pathToRemove: string, removedPaths: string[], warnings: string[]) {
  try {
    await fs.rm(pathToRemove, { recursive: true, force: true });
    removedPaths.push(pathToRemove);
  } catch (error) {
    warnings.push(
      `cleanup_failed:${pathToRemove}:${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function toCompileSessionRequest(
  input: NormalizedScanLifecycleInput,
): MainlineCompileSessionRequest {
  return {
    projectRoot: input.projectRoot,
    mode: input.mode,
    workspace: {
      mode: input.workspacePaths.mode,
      dataRoot: input.workspacePaths.dataRoot,
    },
    scan: normalizeScanOptions(input.scan),
    changedFiles: input.changedFiles,
    removedFiles: input.removedFiles,
    diffTextByPath: input.diffTextByPath,
    ...(input.recipes === undefined ? {} : { recipes: input.recipes }),
    generatedAt: input.generatedAt,
    ...(input.maxFileBytes === undefined ? {} : { maxFileBytes: input.maxFileBytes }),
    notes: input.notes,
    ...(input.dependentDepth === undefined ? {} : { dependentDepth: input.dependentDepth }),
    ...(input.fullRebuildChangeRatio === undefined
      ? {}
      : { fullRebuildChangeRatio: input.fullRebuildChangeRatio }),
  };
}

function projectScanLifecycleResult(compile: MainlineCompileSessionResult): {
  readonly evidence: ScanLifecycleEvidence;
  readonly summary: ScanLifecycleSummary;
} {
  const patchArtifact = compile.projectIntelligence.patchArtifact;
  const selectedFiles =
    patchArtifact?.files.length ?? compile.projectIntelligence.artifact.files.length;
  const parsedFiles =
    patchArtifact?.files.filter((file) => file.status === "parsed").length ??
    compile.projectIntelligence.artifact.files.filter((file) => file.status === "parsed").length;
  const projectSourceRefs = compile.projectIntelligence.materialized?.sourceRefs.length ?? 0;
  const staleProjectSourceRefs =
    compile.projectIntelligence.materialized?.staleSourceRefs.length ?? 0;

  return {
    evidence: {
      origin: compile.mode === "cold-start" ? "snapshot" : "diff",
      fingerprintDiff: compile.fingerprintDiff,
      projectPanorama: compile.projectPanorama,
      sourceRefRepair: compile.sourceRefRepair.summary,
      recipeImpact: compile.recipeImpact.summary,
      recipeMarkdown: compile.recipeMarkdown,
      search: compile.search,
      ...(compile.jobId === undefined ? {} : { compileJobId: compile.jobId }),
    },
    summary: {
      scannedFiles: compile.scanResult.metadata.totalFiles,
      sourceFiles: compile.scanResult.metadata.sourceFiles,
      selectedFiles,
      parsedFiles,
      symbols: compile.projectIntelligence.artifact.symbols.length,
      semanticEdges: compile.projectIntelligence.artifact.semanticEdges.length,
      sourceRefs:
        projectSourceRefs +
        staleProjectSourceRefs +
        compile.contentMining.sourceRefs.length +
        compile.sourceRefRepair.sourceRefs.length,
      searchDocuments: compile.search.persistedDocuments,
      recipes: compile.contentMining.recipes.length,
      recipeMarkdownFiles: compile.recipeMarkdown.paths.length,
      addedFiles: compile.fingerprintDiff.added.length,
      modifiedFiles: compile.fingerprintDiff.modified.length,
      deletedFiles: compile.fingerprintDiff.deleted.length,
      movedFiles: compile.sourceRefRepair.movedFiles.length,
      recipeImpacts: compile.recipeImpact.summary.impactCount,
      repairedSourceRefs: compile.sourceRefRepair.summary.repairedSourceRefCount,
      staleSourceRefs: compile.sourceRefRepair.summary.staleSourceRefCount,
      truncated: compile.scanResult.truncated,
    },
  };
}

function recommendNextActions(input: {
  readonly kind: MainlineWorkflowKind;
  readonly summary: ScanLifecycleSummary;
  readonly compile: MainlineCompileSessionResult;
  readonly cleanup: ScanLifecycleCleanupReport;
}): ScanLifecycleRecommendation[] {
  const recommendations: ScanLifecycleRecommendation[] = [];
  if (input.summary.recipes === 0) {
    recommendations.push({
      id: "submit-knowledge",
      priority: "medium",
      reason: "No Recipe was compiled into the runtime context.",
      action: "Submit project conventions or run an agent-backed knowledge fill.",
    });
  }
  if (input.summary.recipeImpacts > 0) {
    recommendations.push({
      id: "review-recipe-impact",
      priority: "high",
      reason: `${input.summary.recipeImpacts} Recipe impact item(s) were detected.`,
      action: "Review the rescan recipe impact plan before trusting old guidance.",
    });
  }
  if (input.summary.repairedSourceRefs + input.summary.staleSourceRefs > 0) {
    recommendations.push({
      id: "review-source-ref-repair",
      priority: "high",
      reason: "SourceRef repair marked moved or stale knowledge anchors.",
      action: "Inspect repaired/stale SourceRefs and update affected Recipes.",
    });
  }
  if (input.compile.warnings.length > 0 || input.cleanup.warnings.length > 0) {
    recommendations.push({
      id: "inspect-warnings",
      priority: "medium",
      reason: "The scan lifecycle completed with warnings.",
      action: "Inspect warnings before using the generated context for agent decisions.",
    });
  }
  if (input.kind === "bootstrap" && input.summary.searchDocuments > 0) {
    recommendations.push({
      id: "prime-agent-context",
      priority: "low",
      reason: "Cold-start produced a searchable project context.",
      action: "Prime the agent runtime from the new SearchIndex and ContextIndex snapshots.",
    });
  }
  return recommendations;
}

function buildScanLifecycleResult(input: {
  readonly input: ScanLifecycleRunInput;
  readonly normalized?: NormalizedScanLifecycleInput;
  readonly plan?: ScanLifecyclePlan;
  readonly cleanup: ScanLifecycleCleanupReport;
  readonly status: MainlineWorkflowStatus;
  readonly phases: readonly MainlineWorkflowPhaseRecord[];
  readonly summary: ScanLifecycleSummary;
  readonly evidence?: ScanLifecycleEvidence;
  readonly compile?: MainlineCompileSessionResult;
  readonly recommendations: readonly ScanLifecycleRecommendation[];
  readonly warnings: readonly string[];
  readonly persisted?: ScanLifecyclePersistedArtifacts;
}): ScanLifecycleResult {
  const projectRoot = input.normalized?.projectRoot ?? path.resolve(input.input.projectRoot);
  const mode =
    input.normalized?.mode ?? (input.input.kind === "bootstrap" ? "cold-start" : "incremental");
  const plan =
    input.plan ??
    buildScanLifecyclePlan({
      ...input.input,
      projectRoot,
      mode,
      workspacePaths: new MainlineWorkspacePaths({
        projectRoot,
        ...(input.input.workspace ?? {}),
      }),
      changedFiles: uniqueMainlinePosixPaths(input.input.changedFiles ?? []),
      removedFiles: uniqueMainlinePosixPaths(input.input.removedFiles ?? []),
      diffTextByPath: normalizeDiffTextByPath(input.input.diffTextByPath ?? {}),
      notes: [...(input.input.notes ?? [])],
      generatedAt: input.input.generatedAt ?? epochSecondsNow(),
    });

  return {
    kind: input.input.kind,
    status: input.status,
    mode,
    projectRoot,
    phases: input.phases,
    plan,
    cleanup: input.cleanup,
    summary: input.summary,
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    ...(input.compile === undefined ? {} : { compile: input.compile }),
    recommendations: input.recommendations,
    ...(input.persisted === undefined ? {} : { persisted: input.persisted }),
    warnings: input.warnings,
  };
}

function normalizeScanOptions(
  scan: Omit<MainlineSourceFileScanOptions, "root"> | undefined,
): Omit<MainlineSourceFileScanOptions, "root"> {
  return {
    maxFiles: scan?.maxFiles ?? 5_000,
    includeTests: scan?.includeTests ?? false,
    includeDocs: scan?.includeDocs ?? false,
    includeMarkdown: scan?.includeMarkdown ?? false,
    ...(scan?.maxDepth === undefined ? {} : { maxDepth: scan.maxDepth }),
    ...(scan?.skipDirs === undefined ? {} : { skipDirs: scan.skipDirs }),
  };
}

function normalizeDiffTextByPath(input: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).map(([filePath, diffText]) => [
      normalizeMainlinePosixPath(filePath),
      diffText,
    ]),
  );
}

function skippedCleanupReport(policy: ScanLifecycleCleanupPolicy): ScanLifecycleCleanupReport {
  return { policy, removedPaths: [], preservedPaths: [], warnings: [] };
}

function persistedResult(persisted: ScanLifecyclePersistedArtifacts | undefined): {
  readonly persisted?: ScanLifecyclePersistedArtifacts;
} {
  return persisted === undefined ? {} : { persisted };
}

function emptyScanLifecycleSummary(): ScanLifecycleSummary {
  return {
    scannedFiles: 0,
    sourceFiles: 0,
    selectedFiles: 0,
    parsedFiles: 0,
    symbols: 0,
    semanticEdges: 0,
    sourceRefs: 0,
    searchDocuments: 0,
    recipes: 0,
    recipeMarkdownFiles: 0,
    addedFiles: 0,
    modifiedFiles: 0,
    deletedFiles: 0,
    movedFiles: 0,
    recipeImpacts: 0,
    repairedSourceRefs: 0,
    staleSourceRefs: 0,
    truncated: false,
  };
}

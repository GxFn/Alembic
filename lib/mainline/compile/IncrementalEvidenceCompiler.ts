import path from "node:path";
import {
  type MainlineScannedSourceFile,
  MainlineSourceFileScanner,
  type MainlineSourceFileScanResult,
} from "../../engineering/code/index.js";
import { filterMainlineGeneratedFiles, isMainlineGeneratedProjectFile } from "../core/index.js";
import type { MainlineFileFingerprintSnapshotDiff } from "../data/index.js";
import type {
  EvidenceOrigin,
  EvidencePackage,
  SourceRef,
  SourceRefStatus,
} from "../knowledge/index.js";
import { EvidencePackageBuilder } from "./EvidencePackageBuilder.js";
import {
  type MainlineGitChangedFile,
  normalizeSourcePath,
  SourceRefMaterializer,
} from "./SourceRefMaterializer.js";

export interface MainlineGitChangeSet {
  readonly files: readonly MainlineGitChangedFile[];
  readonly stagedCount?: number;
  readonly unstagedCount?: number;
  readonly untrackedCount?: number;
}

export interface IncrementalEvidenceCompilerRequest {
  readonly projectRoot: string;
  readonly origin: Extract<EvidenceOrigin, "snapshot" | "diff">;
  readonly scanFiles?: boolean;
  readonly gitChangeSet?: MainlineGitChangeSet;
  readonly snapshotDiff?: MainlineFileFingerprintSnapshotDiff;
  readonly diffTextByPath?: Record<string, string>;
  readonly notes?: readonly string[];
  readonly includeTests?: boolean;
  readonly includeDocs?: boolean;
  readonly includeMarkdown?: boolean;
  readonly maxScanFiles?: number;
  readonly maxScanDepth?: number;
  readonly id?: string;
}

export interface IncrementalEvidenceCompilerDependencies {
  readonly evidencePackageBuilder?: EvidencePackageBuilder;
  readonly materializer?: SourceRefMaterializer;
  readonly scanner?: MainlineSourceFileScanner;
}

interface PathEvidence {
  readonly path: string;
  readonly status: SourceRefStatus;
  readonly oldPath?: string;
  readonly source: "git" | "snapshot" | "scan" | "diff";
  readonly metadata?: Record<string, unknown>;
}

export class IncrementalEvidenceCompiler {
  readonly #builder: EvidencePackageBuilder;
  readonly #materializer: SourceRefMaterializer;
  readonly #scanner: MainlineSourceFileScanner;

  constructor(dependencies: IncrementalEvidenceCompilerDependencies = {}) {
    this.#builder = dependencies.evidencePackageBuilder ?? new EvidencePackageBuilder();
    this.#materializer = dependencies.materializer ?? new SourceRefMaterializer();
    this.#scanner = dependencies.scanner ?? new MainlineSourceFileScanner();
  }

  /**
   * 把项目变化事实编译成 EvidencePackage。
   * 中文注释：这里不生成 Recipe、不写 ContextIndex、不调用 AI，只负责把
   * scan/git/snapshot/diff 事实合并成可追踪证据。
   */
  async compile(request: IncrementalEvidenceCompilerRequest): Promise<EvidencePackage> {
    const projectRoot = path.resolve(request.projectRoot);
    const scanResult = request.scanFiles
      ? await this.#scanner.scan({
          root: projectRoot,
          ...(request.includeTests !== undefined ? { includeTests: request.includeTests } : {}),
          ...(request.includeDocs !== undefined ? { includeDocs: request.includeDocs } : {}),
          ...(request.includeMarkdown !== undefined
            ? { includeMarkdown: request.includeMarkdown }
            : {}),
          ...(request.maxScanDepth !== undefined ? { maxDepth: request.maxScanDepth } : {}),
          ...(request.maxScanFiles !== undefined ? { maxFiles: request.maxScanFiles } : {}),
        })
      : undefined;

    const pathEvidence = collectPathEvidence(request, scanResult);
    const changedFiles = [...pathEvidence.keys()].filter((filePath) => !isIgnoredPath(filePath));
    const sourceRefs = collectSourceRefs({
      changedFiles,
      pathEvidence,
      materializer: this.#materializer,
      ...(request.diffTextByPath ? { diffTextByPath: request.diffTextByPath } : {}),
      ...(scanResult ? { scanResult } : {}),
    });
    const metadata = buildMetadata(request, scanResult, sourceRefs);
    const id = request.id ?? incrementalEvidenceId(request.origin, changedFiles, sourceRefs);
    const buildRequest = {
      id,
      projectRoot,
      changedFiles,
      sourceRefs,
      metadata,
      ...(request.notes ? { notes: request.notes } : {}),
    };

    return request.origin === "snapshot"
      ? this.#builder.buildSnapshot(buildRequest)
      : this.#builder.buildDiff(buildRequest);
  }
}

function collectPathEvidence(
  request: IncrementalEvidenceCompilerRequest,
  scanResult?: MainlineSourceFileScanResult,
): Map<string, PathEvidence> {
  const evidence = new Map<string, PathEvidence>();

  for (const file of filterMainlineGeneratedFiles(request.gitChangeSet?.files ?? [])) {
    evidence.set(normalizeSourcePath(file.path), {
      path: normalizeSourcePath(file.path),
      status: gitStatusToSourceStatus(file.status),
      source: "git",
      ...(file.oldPath ? { oldPath: normalizeSourcePath(file.oldPath) } : {}),
      metadata: {
        gitStatus: file.status,
        ...(file.staged !== undefined ? { staged: file.staged } : {}),
        ...(file.oldPath ? { oldPath: normalizeSourcePath(file.oldPath) } : {}),
      },
    });
  }

  for (const item of snapshotPathEvidence(request.snapshotDiff)) {
    if (!evidence.has(item.path) && !isIgnoredPath(item.path)) {
      evidence.set(item.path, item);
    }
  }

  const hasDiffFacts = Object.keys(request.diffTextByPath ?? {}).some(
    (rawPath) => !isIgnoredPath(rawPath),
  );
  const hasIncrementalFacts = evidence.size > 0 || hasDiffFacts;
  if (scanResult && !hasIncrementalFacts) {
    for (const file of filterScannedFiles(scanResult.files)) {
      evidence.set(normalizeSourcePath(file.relativePath), {
        path: normalizeSourcePath(file.relativePath),
        status: "active",
        source: "scan",
      });
    }
  }

  for (const rawPath of Object.keys(request.diffTextByPath ?? {})) {
    const filePath = normalizeSourcePath(rawPath);
    if (!evidence.has(filePath) && !isIgnoredPath(filePath)) {
      evidence.set(filePath, { path: filePath, status: "active", source: "diff" });
    }
  }

  return evidence;
}

function collectSourceRefs(input: {
  readonly changedFiles: readonly string[];
  readonly pathEvidence: ReadonlyMap<string, PathEvidence>;
  readonly diffTextByPath?: Record<string, string>;
  readonly scanResult?: MainlineSourceFileScanResult;
  readonly materializer: SourceRefMaterializer;
}): SourceRef[] {
  const sourceRefs = new Map<string, SourceRef>();
  const scannedByPath = new Map(
    filterScannedFiles(input.scanResult?.files ?? []).map((file) => [
      normalizeSourcePath(file.relativePath),
      file,
    ]),
  );

  for (const filePath of input.changedFiles) {
    const pathEvidence = input.pathEvidence.get(filePath);
    const scannedFile = scannedByPath.get(filePath);
    const sourceRef = scannedFile
      ? mergeScannedFileRef(input.materializer.fromScannedFile(scannedFile), pathEvidence)
      : input.materializer.fromPath({
          path: filePath,
          status: pathEvidence?.status ?? "active",
          metadata: {
            source: pathEvidence?.source ?? "unknown",
            ...(pathEvidence?.metadata ?? {}),
          },
          ...(pathEvidence?.oldPath ? { oldPath: pathEvidence.oldPath } : {}),
        });
    sourceRefs.set(sourceRef.id, sourceRef);
  }

  for (const [rawPath, diffText] of Object.entries(input.diffTextByPath ?? {})) {
    const filePath = normalizeSourcePath(rawPath);
    if (isIgnoredPath(filePath)) {
      continue;
    }
    const status = input.pathEvidence.get(filePath)?.status ?? "active";
    const diff = input.materializer.fromDiffText(filePath, diffText, status);
    sourceRefs.set(diff.sourceRef.id, diff.sourceRef);
  }

  return [...sourceRefs.values()];
}

function snapshotPathEvidence(snapshotDiff?: MainlineFileFingerprintSnapshotDiff): PathEvidence[] {
  if (!snapshotDiff) {
    return [];
  }
  return [
    ...snapshotDiff.added.map((filePath) => snapshotItem(filePath, "active", "added")),
    ...snapshotDiff.modified.map((filePath) => snapshotItem(filePath, "active", "modified")),
    ...snapshotDiff.deleted.map((filePath) => snapshotItem(filePath, "missing", "deleted")),
  ];
}

function snapshotItem(
  filePath: string,
  status: SourceRefStatus,
  snapshotStatus: string,
): PathEvidence {
  const normalized = normalizeSourcePath(filePath);
  return {
    path: normalized,
    status,
    source: "snapshot",
    metadata: { snapshotStatus },
  };
}

function mergeScannedFileRef(sourceRef: SourceRef, evidence?: PathEvidence): SourceRef {
  if (!evidence) {
    return sourceRef;
  }
  return {
    ...sourceRef,
    status: evidence.status,
    metadata: {
      ...(sourceRef.metadata ?? {}),
      source: evidence.source,
      ...(evidence.metadata ?? {}),
      ...(evidence.oldPath ? { oldPath: evidence.oldPath } : {}),
    },
  };
}

function buildMetadata(
  request: IncrementalEvidenceCompilerRequest,
  scanResult: MainlineSourceFileScanResult | undefined,
  sourceRefs: readonly SourceRef[],
): Record<string, unknown> {
  const diffRefs = sourceRefs.filter((sourceRef) => sourceRef.kind === "diff");
  const tokens = new Set<string>();
  let hunkCount = 0;
  for (const sourceRef of diffRefs) {
    for (const token of readStringArray(sourceRef.metadata?.tokens)) {
      tokens.add(token);
    }
    hunkCount +=
      typeof sourceRef.metadata?.hunkCount === "number" ? sourceRef.metadata.hunkCount : 0;
  }

  return {
    git: {
      stagedCount: request.gitChangeSet?.stagedCount ?? 0,
      unstagedCount: request.gitChangeSet?.unstagedCount ?? 0,
      untrackedCount: request.gitChangeSet?.untrackedCount ?? 0,
      changedFileCount: request.gitChangeSet?.files.length ?? 0,
    },
    snapshot: {
      changeRatio: request.snapshotDiff?.changeRatio ?? 0,
      addedCount: request.snapshotDiff?.added.length ?? 0,
      modifiedCount: request.snapshotDiff?.modified.length ?? 0,
      deletedCount: request.snapshotDiff?.deleted.length ?? 0,
    },
    diff: {
      tokens: [...tokens].sort(),
      tokenCount: tokens.size,
      hunkCount,
    },
    scan: {
      enabled: request.scanFiles === true,
      truncated: scanResult?.truncated ?? false,
      fileCount: scanResult?.files.length ?? 0,
      languageCounts: scanResult?.languageCounts ?? {},
      documentCounts: scanResult?.documentCounts ?? {},
    },
  };
}

function filterScannedFiles(
  files: readonly MainlineScannedSourceFile[],
): MainlineScannedSourceFile[] {
  return filterMainlineGeneratedFiles(files).filter((file) => !isIgnoredPath(file.relativePath));
}

function gitStatusToSourceStatus(status: MainlineGitChangedFile["status"]): SourceRefStatus {
  switch (status) {
    case "deleted":
      return "missing";
    case "renamed":
      return "renamed";
    case "added":
    case "modified":
    case "untracked":
      return "active";
  }
}

function isIgnoredPath(filePath: string): boolean {
  return isMainlineGeneratedProjectFile(normalizeSourcePath(filePath));
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function incrementalEvidenceId(
  origin: IncrementalEvidenceCompilerRequest["origin"],
  changedFiles: readonly string[],
  sourceRefs: readonly SourceRef[],
): string {
  return `mainline-${origin}-${changedFiles.length}-${sourceRefs.length}`;
}

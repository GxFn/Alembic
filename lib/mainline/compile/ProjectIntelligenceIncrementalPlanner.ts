import { normalizeMainlinePosixPath, uniqueMainlinePosixPaths } from "../core/index.js";
import type { MainlineFileFingerprintSnapshotDiff } from "../data/index.js";
import type {
  MainlineProjectIntelligenceArtifact,
  MainlineProjectIntelligenceEdge,
  MainlineProjectIntelligenceSymbol,
} from "../graph/index.js";
import type { MainlineSourceRefMovedFile } from "./RecipePathRepairer.js";

export interface MainlineProjectIntelligenceIncrementalPlanRequest {
  readonly artifact: MainlineProjectIntelligenceArtifact;
  readonly fingerprintDiff?: MainlineFileFingerprintSnapshotDiff;
  readonly changedFiles?: readonly string[];
  readonly deletedFiles?: readonly string[];
  readonly movedFiles?: readonly MainlineSourceRefMovedFile[];
  readonly dependentDepth?: number;
  readonly fullRebuildChangeRatio?: number;
}

export interface MainlineProjectIntelligenceIncrementalPlan {
  readonly changedFiles: readonly string[];
  readonly deletedFiles: readonly string[];
  readonly dependentFiles: readonly string[];
  readonly affectedFiles: readonly string[];
  readonly filesToParse: readonly string[];
  readonly affectedSymbols: readonly MainlineProjectIntelligenceSymbol[];
  readonly movedFiles: readonly MainlineSourceRefMovedFile[];
  readonly sourceRefIdsToRefresh: readonly string[];
  readonly sourceRefIdsToRepair: readonly string[];
  readonly sourceRefIdsToStale: readonly string[];
  readonly searchDocumentIdsToRefresh: readonly string[];
  readonly searchDocumentIdsToRemove: readonly string[];
  readonly contextLookupFiles: readonly string[];
  readonly fullRebuildRequired: boolean;
  readonly reasons: readonly MainlineProjectIntelligenceIncrementalReason[];
}

export interface MainlineProjectIntelligenceIncrementalReason {
  readonly path: string;
  readonly kind: "changed" | "deleted" | "moved" | "dependent" | "full-rebuild-threshold";
  readonly via?: string;
}

const DEFAULT_DEPENDENT_DEPTH = 2;
const DEFAULT_FULL_REBUILD_CHANGE_RATIO = 0.35;

/**
 * ProjectIntelligenceIncrementalPlanner 是增量编译的纯决策层。
 * 它只消费上一轮项目事实和文件指纹 diff，输出需要重解析、失效和刷新的一组稳定集合。
 */
export class MainlineProjectIntelligenceIncrementalPlanner {
  plan(
    request: MainlineProjectIntelligenceIncrementalPlanRequest,
  ): MainlineProjectIntelligenceIncrementalPlan {
    const movedFiles = normalizeMovedFiles(request.movedFiles ?? []);
    const changedFiles = uniqueMainlinePosixPaths([
      ...(request.fingerprintDiff?.added ?? []),
      ...(request.fingerprintDiff?.modified ?? []),
      ...(request.changedFiles ?? []),
      ...movedFiles.map((movedFile) => movedFile.toPath),
    ]);
    const deletedFiles = uniqueMainlinePosixPaths([
      ...(request.fingerprintDiff?.deleted ?? []),
      ...(request.deletedFiles ?? []),
      ...movedFiles.map((movedFile) => movedFile.fromPath),
    ]);
    const movedFromPaths = new Set(movedFiles.map((move) => move.fromPath));
    const knownFiles = new Set(request.artifact.files.map((file) => file.path));
    const fullRebuildRequired =
      (request.fingerprintDiff?.changeRatio ?? 0) >=
      (request.fullRebuildChangeRatio ?? DEFAULT_FULL_REBUILD_CHANGE_RATIO);
    const dependentFiles = fullRebuildRequired
      ? [...knownFiles].sort()
      : collectDependentFiles(request.artifact.semanticEdges, [...changedFiles, ...deletedFiles], {
          knownFiles,
          maxDepth: request.dependentDepth ?? DEFAULT_DEPENDENT_DEPTH,
        });
    const filesToParse = fullRebuildRequired
      ? [...knownFiles].filter((filePath) => !deletedFiles.includes(filePath)).sort()
      : uniqueMainlinePosixPaths([...changedFiles, ...dependentFiles])
          .filter((filePath) => !deletedFiles.includes(filePath))
          .sort();
    const affectedFiles = uniqueMainlinePosixPaths([...filesToParse, ...deletedFiles]).sort();
    const affectedSymbols = symbolsForFiles(request.artifact.symbols, affectedFiles);
    const symbolsToRefresh = symbolsForFiles(request.artifact.symbols, filesToParse);
    const symbolsToRepair = symbolsForFiles(request.artifact.symbols, [...movedFromPaths]);
    const staleDeletedFiles = deletedFiles.filter((filePath) => !movedFromPaths.has(filePath));
    const symbolsToStale = symbolsForFiles(request.artifact.symbols, staleDeletedFiles);
    const reasons = buildReasons({
      changedFiles,
      deletedFiles,
      movedFiles,
      dependentFiles,
      fullRebuildRequired,
    });

    return {
      changedFiles,
      deletedFiles,
      dependentFiles,
      affectedFiles,
      filesToParse,
      affectedSymbols,
      movedFiles,
      sourceRefIdsToRefresh: uniqueStrings([
        ...filesToParse,
        ...symbolsToRefresh.map((symbol) => symbol.id),
      ]),
      sourceRefIdsToRepair: uniqueStrings([
        ...movedFiles.map((movedFile) => movedFile.fromPath),
        ...symbolsToRepair.map((symbol) => symbol.id),
      ]),
      sourceRefIdsToStale: uniqueStrings([
        ...staleDeletedFiles,
        ...symbolsToStale.map((symbol) => symbol.id),
      ]),
      searchDocumentIdsToRefresh: uniqueStrings([
        ...filesToParse.map((filePath) => `file:${filePath}`),
        ...symbolsToRefresh.map((symbol) => symbol.id),
      ]),
      searchDocumentIdsToRemove: uniqueStrings([
        ...deletedFiles.map((filePath) => `file:${filePath}`),
        ...symbolsToRepair.map((symbol) => symbol.id),
        ...symbolsToStale.map((symbol) => symbol.id),
      ]),
      contextLookupFiles: affectedFiles,
      fullRebuildRequired,
      reasons,
    };
  }
}

function collectDependentFiles(
  edges: readonly MainlineProjectIntelligenceEdge[],
  seedFiles: readonly string[],
  options: {
    readonly knownFiles: ReadonlySet<string>;
    readonly maxDepth: number;
  },
): string[] {
  const incoming = incomingFileDependencyMap(edges, options.knownFiles);
  const queue = seedFiles
    .map((filePath) => normalizeMainlinePosixPath(filePath))
    .filter((filePath) => options.knownFiles.has(filePath))
    .map((filePath) => ({ path: filePath, depth: 0 }));
  const dependents = new Set<string>();
  const visited = new Set(queue.map((item) => item.path));

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (!current || current.depth >= options.maxDepth) {
      continue;
    }

    for (const dependent of incoming.get(current.path) ?? []) {
      if (visited.has(dependent)) {
        continue;
      }
      visited.add(dependent);
      dependents.add(dependent);
      queue.push({ path: dependent, depth: current.depth + 1 });
    }
  }

  return [...dependents].sort();
}

function incomingFileDependencyMap(
  edges: readonly MainlineProjectIntelligenceEdge[],
  knownFiles: ReadonlySet<string>,
): Map<string, string[]> {
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    if (!isFileDependencyEdge(edge)) {
      continue;
    }

    const from = edge.from.slice("file:".length);
    const to = edge.to.slice("file:".length);
    if (!knownFiles.has(from) || !knownFiles.has(to)) {
      continue;
    }
    incoming.set(to, [...(incoming.get(to) ?? []), from].sort());
  }
  return incoming;
}

function isFileDependencyEdge(edge: MainlineProjectIntelligenceEdge): boolean {
  return (
    edge.from.startsWith("file:") &&
    edge.to.startsWith("file:") &&
    ["imports", "exports", "requires", "dynamic-import"].includes(edge.kind)
  );
}

function symbolsForFiles(
  symbols: readonly MainlineProjectIntelligenceSymbol[],
  files: readonly string[],
): MainlineProjectIntelligenceSymbol[] {
  const fileSet = new Set(files);
  return symbols
    .filter((symbol) => fileSet.has(symbol.file))
    .sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.line - right.line ||
        left.fqn.localeCompare(right.fqn),
    );
}

function buildReasons(input: {
  readonly changedFiles: readonly string[];
  readonly deletedFiles: readonly string[];
  readonly movedFiles: readonly MainlineSourceRefMovedFile[];
  readonly dependentFiles: readonly string[];
  readonly fullRebuildRequired: boolean;
}): MainlineProjectIntelligenceIncrementalReason[] {
  const reasons: MainlineProjectIntelligenceIncrementalReason[] = [
    ...input.changedFiles.map((filePath) => ({ path: filePath, kind: "changed" as const })),
    ...input.deletedFiles.map((filePath) => ({ path: filePath, kind: "deleted" as const })),
    ...input.movedFiles.map((movedFile) => ({
      path: movedFile.fromPath,
      kind: "moved" as const,
      via: movedFile.toPath,
    })),
    ...input.dependentFiles.map((filePath) => ({ path: filePath, kind: "dependent" as const })),
  ];

  if (input.fullRebuildRequired) {
    reasons.push({
      path: "*",
      kind: "full-rebuild-threshold",
      via: "fingerprint-diff.changeRatio",
    });
  }

  return reasons.sort(
    (left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind),
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function normalizeMovedFiles(
  movedFiles: readonly MainlineSourceRefMovedFile[],
): MainlineSourceRefMovedFile[] {
  const byFrom = new Map<string, MainlineSourceRefMovedFile>();
  for (const movedFile of movedFiles) {
    const fromPath = normalizeMainlinePosixPath(movedFile.fromPath);
    const toPath = normalizeMainlinePosixPath(movedFile.toPath);
    if (!fromPath || !toPath || byFrom.has(fromPath)) {
      continue;
    }
    byFrom.set(fromPath, {
      fromPath,
      toPath,
      ...(movedFile.contentHash === undefined ? {} : { contentHash: movedFile.contentHash }),
    });
  }
  return [...byFrom.values()].sort(
    (left, right) =>
      left.fromPath.localeCompare(right.fromPath) || left.toPath.localeCompare(right.toPath),
  );
}

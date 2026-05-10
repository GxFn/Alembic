import type { MainlineCallSite } from "../code/index.js";
import { normalizeMainlinePosixPath } from "../core/PathIdentity.js";
import type {
  MainlineProjectGraph,
  MainlineProjectGraphEdge,
  MainlineProjectGraphExternalDependency,
  MainlineProjectGraphNode,
  MainlineProjectGraphUnresolvedDependency,
  MainlineProjectIntelligenceArtifact,
  MainlineProjectIntelligenceEdge,
  MainlineProjectIntelligenceFile,
  MainlineProjectIntelligenceSymbol,
} from "../graph/index.js";

interface MainlineProjectIntelligenceArtifactMergeIncrementalPlan {
  readonly affectedFiles: readonly string[];
  readonly fullRebuildRequired?: boolean;
}

export interface MainlineProjectIntelligenceArtifactMergeRequest {
  readonly previousArtifact: MainlineProjectIntelligenceArtifact;
  readonly patchArtifact: MainlineProjectIntelligenceArtifact;
  readonly incrementalPlan: MainlineProjectIntelligenceArtifactMergeIncrementalPlan;
  readonly generatedAt?: number;
}

/**
 * 合并 ProjectIntelligence 增量产物。
 * 规则保持保守：受影响文件的旧 facts 全部丢弃，再放入 patch artifact；
 * 未受影响文件沿用上一轮事实，本层不触发扫描或 runner 重建。
 */
export function mergeMainlineProjectIntelligenceArtifact(
  request: MainlineProjectIntelligenceArtifactMergeRequest,
): MainlineProjectIntelligenceArtifact {
  const affectedFiles = new Set(
    request.incrementalPlan.affectedFiles
      .map((filePath) => normalizeMainlinePosixPath(filePath))
      .filter(Boolean),
  );
  const patchFiles = new Set(request.patchArtifact.files.map((file) => file.path));
  const removedFiles = new Set([...affectedFiles, ...patchFiles]);
  const projectRoot = request.previousArtifact.projectRoot ?? request.patchArtifact.projectRoot;
  const generatedAt = request.generatedAt ?? request.patchArtifact.generatedAt;

  if (request.incrementalPlan.fullRebuildRequired) {
    return artifactWithHeader(projectRoot, generatedAt, {
      files: request.patchArtifact.files,
      symbols: request.patchArtifact.symbols,
      callSites: request.patchArtifact.callSites,
      projectGraph: request.patchArtifact.projectGraph,
      semanticEdges: request.patchArtifact.semanticEdges,
    });
  }

  return artifactWithHeader(projectRoot, generatedAt, {
    files: sortFiles([
      ...request.previousArtifact.files.filter((file) => !removedFiles.has(file.path)),
      ...request.patchArtifact.files,
    ]),
    symbols: sortSymbols([
      ...request.previousArtifact.symbols.filter((symbol) => !removedFiles.has(symbol.file)),
      ...request.patchArtifact.symbols,
    ]),
    callSites: sortCallSites([
      ...request.previousArtifact.callSites.filter((callSite) =>
        keepPreviousCallSite(callSite, removedFiles),
      ),
      ...request.patchArtifact.callSites,
    ]),
    projectGraph: mergeProjectGraph(
      request.previousArtifact.projectGraph,
      request.patchArtifact.projectGraph,
      removedFiles,
    ),
    semanticEdges: sortSemanticEdges([
      ...request.previousArtifact.semanticEdges.filter((edge) =>
        keepPreviousSemanticEdge(edge, removedFiles),
      ),
      ...request.patchArtifact.semanticEdges,
    ]),
  });
}

function artifactWithHeader(
  projectRoot: string | undefined,
  generatedAt: number | undefined,
  body: Omit<MainlineProjectIntelligenceArtifact, "projectRoot" | "generatedAt">,
): MainlineProjectIntelligenceArtifact {
  return {
    ...(projectRoot === undefined ? {} : { projectRoot }),
    ...(generatedAt === undefined ? {} : { generatedAt }),
    ...body,
  };
}

function mergeProjectGraph(
  previous: MainlineProjectGraph,
  patch: MainlineProjectGraph,
  removedFiles: ReadonlySet<string>,
): MainlineProjectGraph {
  return {
    nodes: sortNodes([
      ...previous.nodes.filter((node) => keepPreviousGraphNode(node, removedFiles)),
      ...patch.nodes,
    ]),
    edges: sortGraphEdges([
      ...previous.edges.filter((edge) => keepPreviousGraphEdge(edge, removedFiles)),
      ...patch.edges,
    ]),
    externalDependencies: sortExternalDependencies([
      ...previous.externalDependencies.filter(
        (dependency) => !removedFiles.has(dependency.fromPath),
      ),
      ...patch.externalDependencies,
    ]),
    unresolvedDependencies: sortUnresolvedDependencies([
      ...previous.unresolvedDependencies.filter(
        (dependency) => !removedFiles.has(dependency.fromPath),
      ),
      ...patch.unresolvedDependencies,
    ]),
    cycles: sortCycles([
      ...previous.cycles.filter((cycle) => cycle.every((filePath) => !removedFiles.has(filePath))),
      ...patch.cycles,
    ]),
  };
}

function keepPreviousCallSite(
  callSite: MainlineCallSite,
  removedFiles: ReadonlySet<string>,
): boolean {
  return ![callSite.callerSymbol, callSite.targetFqn]
    .filter((value): value is string => Boolean(value))
    .some((value) => removedFiles.has(pathFromNodeRef(value)));
}

function keepPreviousSemanticEdge(
  edge: MainlineProjectIntelligenceEdge,
  removedFiles: ReadonlySet<string>,
): boolean {
  return ![edge.from, edge.to, edge.file]
    .filter((value): value is string => Boolean(value))
    .some((value) => removedFiles.has(pathFromNodeRef(value)));
}

function keepPreviousGraphNode(
  node: MainlineProjectGraphNode,
  removedFiles: ReadonlySet<string>,
): boolean {
  return !removedFiles.has(node.path ?? pathFromNodeRef(node.id));
}

function keepPreviousGraphEdge(
  edge: MainlineProjectGraphEdge,
  removedFiles: ReadonlySet<string>,
): boolean {
  return ![edge.from, edge.to].some((nodeId) => removedFiles.has(pathFromNodeRef(nodeId)));
}

function pathFromNodeRef(value: string): string {
  if (value.startsWith("file:")) {
    return value.slice("file:".length);
  }
  if (value.startsWith("symbol:")) {
    return value.slice("symbol:".length).split("::")[0] ?? value;
  }
  return value.split("::")[0] ?? value;
}

function sortFiles(
  files: readonly MainlineProjectIntelligenceFile[],
): MainlineProjectIntelligenceFile[] {
  return [...new Map(files.map((file) => [file.path, file])).values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function sortSymbols(
  symbols: readonly MainlineProjectIntelligenceSymbol[],
): MainlineProjectIntelligenceSymbol[] {
  return [...new Map(symbols.map((symbol) => [symbol.id, symbol])).values()].sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.fqn.localeCompare(right.fqn),
  );
}

function sortCallSites(callSites: readonly MainlineCallSite[]): MainlineCallSite[] {
  return [
    ...new Map(
      callSites.map((callSite) => [
        `${callSite.line}\u0000${callSite.callee}\u0000${callSite.callerSymbol ?? ""}\u0000${
          callSite.targetFqn ?? ""
        }`,
        callSite,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      left.line - right.line ||
      left.callee.localeCompare(right.callee) ||
      (left.callerSymbol ?? "").localeCompare(right.callerSymbol ?? ""),
  );
}

function sortNodes(nodes: readonly MainlineProjectGraphNode[]): MainlineProjectGraphNode[] {
  return [...new Map(nodes.map((node) => [node.id, node])).values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

function sortGraphEdges(edges: readonly MainlineProjectGraphEdge[]): MainlineProjectGraphEdge[] {
  return [
    ...new Map(
      edges.map((edge) => [
        `${edge.from}\u0000${edge.to}\u0000${edge.kind}\u0000${edge.specifier ?? ""}`,
        edge,
      ]),
    ).values(),
  ].sort(compareGraphEdges);
}

function sortSemanticEdges(
  edges: readonly MainlineProjectIntelligenceEdge[],
): MainlineProjectIntelligenceEdge[] {
  return [
    ...new Map(
      edges.map((edge) => [
        `${edge.from}\u0000${edge.to}\u0000${edge.kind}\u0000${edge.specifier ?? ""}\u0000${
          edge.line ?? 0
        }`,
        edge,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to) ||
      left.kind.localeCompare(right.kind) ||
      (left.line ?? 0) - (right.line ?? 0),
  );
}

function sortExternalDependencies(
  dependencies: readonly MainlineProjectGraphExternalDependency[],
): MainlineProjectGraphExternalDependency[] {
  return [
    ...new Map(
      dependencies.map((dependency) => [
        `${dependency.fromPath}\u0000${dependency.specifier}\u0000${dependency.kind}`,
        dependency,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      left.fromPath.localeCompare(right.fromPath) ||
      left.specifier.localeCompare(right.specifier) ||
      left.kind.localeCompare(right.kind),
  );
}

function sortUnresolvedDependencies(
  dependencies: readonly MainlineProjectGraphUnresolvedDependency[],
): MainlineProjectGraphUnresolvedDependency[] {
  return [
    ...new Map(
      dependencies.map((dependency) => [
        `${dependency.fromPath}\u0000${dependency.specifier}\u0000${dependency.kind}`,
        dependency,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      left.fromPath.localeCompare(right.fromPath) ||
      left.normalizedTarget.localeCompare(right.normalizedTarget) ||
      left.kind.localeCompare(right.kind),
  );
}

function sortCycles(cycles: readonly string[][]): string[][] {
  return [...new Map(cycles.map((cycle) => [cycle.join("\u0000"), [...cycle]])).values()].sort(
    (left, right) => left.join("\u0000").localeCompare(right.join("\u0000")),
  );
}

function compareGraphEdges(
  left: MainlineProjectGraphEdge,
  right: MainlineProjectGraphEdge,
): number {
  return (
    left.from.localeCompare(right.from) ||
    left.to.localeCompare(right.to) ||
    left.kind.localeCompare(right.kind) ||
    (left.specifier ?? "").localeCompare(right.specifier ?? "")
  );
}

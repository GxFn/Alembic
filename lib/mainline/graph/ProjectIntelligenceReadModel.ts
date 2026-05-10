import type {
  MainlineProjectIntelligenceArtifact,
  MainlineProjectIntelligenceEdge,
  MainlineProjectIntelligenceFile,
} from "./ProjectIntelligenceArtifact.js";

export const MAINLINE_PROJECT_INTELLIGENCE_READ_MODEL_PATH =
  "context/project-intelligence-artifact.json";

export interface MainlineProjectIntelligenceLanguageSummary {
  readonly languageId: string;
  readonly fileCount: number;
  readonly parsedFileCount: number;
  readonly symbolCount: number;
}

export interface MainlineProjectIntelligenceModuleSummary {
  readonly name: string;
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly representativePaths: readonly string[];
}

export interface MainlineProjectIntelligenceEdgeKindSummary {
  readonly kind: MainlineProjectIntelligenceEdge["kind"];
  readonly count: number;
}

export interface MainlineProjectIntelligenceReadSummary {
  readonly projectRoot?: string;
  readonly generatedAt?: number;
  readonly fileCount: number;
  readonly parsedFileCount: number;
  readonly unsupportedFileCount: number;
  readonly failedFileCount: number;
  readonly symbolCount: number;
  readonly callSiteCount: number;
  readonly edgeCount: number;
  readonly dependencyEdgeCount: number;
  readonly externalDependencyCount: number;
  readonly unresolvedDependencyCount: number;
  readonly cycleCount: number;
  readonly languages: readonly MainlineProjectIntelligenceLanguageSummary[];
  readonly modules: readonly MainlineProjectIntelligenceModuleSummary[];
  readonly edgeKinds: readonly MainlineProjectIntelligenceEdgeKindSummary[];
}

/**
 * ProjectIntelligence read model helper：给 Codex public tools 消费已编译事实。
 * 这里只聚合 artifact，不触发扫描、编译，也不复用 internal Agent tool envelope。
 */
export function summarizeMainlineProjectIntelligenceReadModel(
  artifact: MainlineProjectIntelligenceArtifact,
): MainlineProjectIntelligenceReadSummary {
  const symbolCountByFile = countSymbolsByFile(artifact);
  const edgeKinds = summarizeEdgeKinds(artifact.semanticEdges);

  return {
    ...(artifact.projectRoot === undefined ? {} : { projectRoot: artifact.projectRoot }),
    ...(artifact.generatedAt === undefined ? {} : { generatedAt: artifact.generatedAt }),
    fileCount: artifact.files.length,
    parsedFileCount: artifact.files.filter((file) => file.status === "parsed").length,
    unsupportedFileCount: artifact.files.filter((file) => file.status === "unsupported").length,
    failedFileCount: artifact.files.filter((file) => file.status === "failed").length,
    symbolCount: artifact.symbols.length,
    callSiteCount: artifact.callSites.length,
    edgeCount: artifact.semanticEdges.length,
    dependencyEdgeCount: artifact.semanticEdges.filter(isFileDependencyEdge).length,
    externalDependencyCount: artifact.projectGraph.externalDependencies.length,
    unresolvedDependencyCount: artifact.projectGraph.unresolvedDependencies.length,
    cycleCount: artifact.projectGraph.cycles.length,
    languages: summarizeLanguages(artifact, symbolCountByFile),
    modules: summarizeModules(artifact.files, symbolCountByFile),
    edgeKinds,
  };
}

function summarizeLanguages(
  artifact: MainlineProjectIntelligenceArtifact,
  symbolCountByFile: ReadonlyMap<string, number>,
): MainlineProjectIntelligenceLanguageSummary[] {
  const byLanguage = new Map<string, MainlineProjectIntelligenceLanguageSummary>();
  for (const file of artifact.files) {
    const current =
      byLanguage.get(file.languageId) ??
      ({
        languageId: file.languageId,
        fileCount: 0,
        parsedFileCount: 0,
        symbolCount: 0,
      } satisfies MainlineProjectIntelligenceLanguageSummary);
    byLanguage.set(file.languageId, {
      languageId: file.languageId,
      fileCount: current.fileCount + 1,
      parsedFileCount: current.parsedFileCount + (file.status === "parsed" ? 1 : 0),
      symbolCount: current.symbolCount + (symbolCountByFile.get(file.path) ?? 0),
    });
  }
  return [...byLanguage.values()].sort(
    (left, right) =>
      right.fileCount - left.fileCount ||
      right.symbolCount - left.symbolCount ||
      left.languageId.localeCompare(right.languageId),
  );
}

function summarizeModules(
  files: readonly MainlineProjectIntelligenceFile[],
  symbolCountByFile: ReadonlyMap<string, number>,
): MainlineProjectIntelligenceModuleSummary[] {
  const byModule = new Map<
    string,
    {
      readonly paths: string[];
      symbolCount: number;
    }
  >();
  for (const file of files) {
    const name = moduleNameForPath(file.path);
    const current = byModule.get(name) ?? { paths: [], symbolCount: 0 };
    current.paths.push(file.path);
    current.symbolCount += symbolCountByFile.get(file.path) ?? 0;
    byModule.set(name, current);
  }
  return [...byModule.entries()]
    .map(([name, value]) => ({
      name,
      fileCount: value.paths.length,
      symbolCount: value.symbolCount,
      representativePaths: [...value.paths].sort().slice(0, 5),
    }))
    .sort(
      (left, right) =>
        right.fileCount - left.fileCount ||
        right.symbolCount - left.symbolCount ||
        left.name.localeCompare(right.name),
    );
}

function summarizeEdgeKinds(
  edges: readonly MainlineProjectIntelligenceEdge[],
): MainlineProjectIntelligenceEdgeKindSummary[] {
  const counts = new Map<MainlineProjectIntelligenceEdge["kind"], number>();
  for (const edge of edges) {
    counts.set(edge.kind, (counts.get(edge.kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind));
}

function countSymbolsByFile(artifact: MainlineProjectIntelligenceArtifact): Map<string, number> {
  const counts = new Map<string, number>();
  for (const symbol of artifact.symbols) {
    counts.set(symbol.file, (counts.get(symbol.file) ?? 0) + 1);
  }
  return counts;
}

function moduleNameForPath(filePath: string): string {
  const parts = filePath.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return ".";
  }
  if (["apps", "lib", "packages", "plugins", "src", "test", "tests"].includes(parts[0] ?? "")) {
    return parts.slice(0, Math.min(2, parts.length - 1)).join("/");
  }
  return parts[0] ?? ".";
}

function isFileDependencyEdge(edge: MainlineProjectIntelligenceEdge): boolean {
  return (
    edge.from.startsWith("file:") &&
    edge.to.startsWith("file:") &&
    ["dynamic-import", "exports", "imports", "requires"].includes(edge.kind)
  );
}

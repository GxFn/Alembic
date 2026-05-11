import path from "node:path";
import type {
  MainlineProjectGraphExternalDependency,
  MainlineProjectIntelligenceArtifact,
  MainlineProjectIntelligenceFile,
} from "../graph/index.js";

export type MainlineProjectModuleRole =
  | "core"
  | "interface"
  | "data"
  | "service"
  | "agent-orchestration"
  | "test"
  | "documentation"
  | "operations";

export interface MainlineProjectLanguageSummary {
  readonly languageId: string;
  readonly fileCount: number;
  readonly parsedFileCount: number;
  readonly symbolCount: number;
}

export interface MainlineProjectModuleSummary {
  readonly name: string;
  readonly role: MainlineProjectModuleRole;
  readonly fileCount: number;
  readonly sourceFileCount: number;
  readonly testFileCount: number;
  readonly docFileCount: number;
  readonly symbolCount: number;
  readonly dependencyCount: number;
  readonly dependentCount: number;
  readonly externalDependencyCount: number;
  readonly languages: readonly string[];
  readonly representativePaths: readonly string[];
}

export interface MainlineProjectModuleDependencyEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: string;
  readonly weight: number;
}

export interface MainlineProjectModuleCycle {
  readonly cycle: readonly string[];
  readonly severity: "warning" | "error";
}

export interface MainlineProjectLayerLevel {
  readonly level: number;
  readonly name: string;
  readonly modules: readonly string[];
}

export interface MainlineProjectLayerViolation {
  readonly from: string;
  readonly to: string;
  readonly fromLayer: number;
  readonly toLayer: number;
  readonly relation: string;
}

export interface MainlineExternalDependencySummary {
  readonly specifier: string;
  readonly count: number;
  readonly kinds: readonly string[];
  readonly fromPaths: readonly string[];
}

export interface MainlineProjectPanoramaSummary {
  readonly projectRoot?: string;
  readonly generatedAt?: number;
  readonly fileCount: number;
  readonly parsedFileCount: number;
  readonly unsupportedFileCount: number;
  readonly failedFileCount: number;
  readonly sourceFileCount: number;
  readonly testFileCount: number;
  readonly docFileCount: number;
  readonly testSourceRatio: number;
  readonly symbolCount: number;
  readonly callSiteCount: number;
  readonly callGraphEdgeCount: number;
  readonly dataFlowEdgeCount: number;
  readonly crossFileCallEdgeCount: number;
  readonly dominantLanguage?: string;
  readonly languages: readonly MainlineProjectLanguageSummary[];
  readonly modules: readonly MainlineProjectModuleSummary[];
  readonly moduleDependencyEdges: readonly MainlineProjectModuleDependencyEdge[];
  readonly layers: readonly MainlineProjectLayerLevel[];
  readonly layerViolations: readonly MainlineProjectLayerViolation[];
  readonly moduleCycles: readonly MainlineProjectModuleCycle[];
  readonly externalDependencies: readonly MainlineExternalDependencySummary[];
  readonly unresolvedDependencyCount: number;
  readonly dependencyCycles: readonly string[][];
  readonly cycleCount: number;
}

interface ModuleAccumulator {
  readonly name: string;
  readonly files: MainlineProjectIntelligenceFile[];
  readonly dependencies: Set<string>;
  readonly dependents: Set<string>;
  readonly externalDependencies: Set<string>;
}

/**
 * ProjectPanoramaSummary 从 ProjectIntelligence artifact 生成项目全景摘要。
 * 它只整理已编译事实，不回扫文件系统，也不承接旧 panorama 的多入口分析状态。
 */
export class ProjectPanoramaSummary {
  summarize(artifact: MainlineProjectIntelligenceArtifact): MainlineProjectPanoramaSummary {
    const files = [...artifact.files].sort((left, right) => left.path.localeCompare(right.path));
    const symbolCountByFile = countSymbolsByFile(artifact);
    const modules = buildModuleSummaries(artifact, symbolCountByFile);
    const languages = buildLanguageSummaries(artifact);
    const moduleDependencyEdges = buildModuleDependencyEdges(artifact);
    const moduleCycles = findModuleCycles(moduleDependencyEdges);
    const layerHierarchy = inferModuleLayers(
      modules.map((module) => module.name),
      moduleDependencyEdges,
      moduleCycles,
    );
    const sourceFileCount = files.filter(isSourceFile).length;
    const testFileCount = files.filter(isTestFile).length;
    const docFileCount = files.filter(isDocFile).length;
    const dominantLanguage = languages[0]?.languageId;

    return {
      ...(artifact.projectRoot === undefined ? {} : { projectRoot: artifact.projectRoot }),
      ...(artifact.generatedAt === undefined ? {} : { generatedAt: artifact.generatedAt }),
      fileCount: files.length,
      parsedFileCount: files.filter((file) => file.status === "parsed").length,
      unsupportedFileCount: files.filter((file) => file.status === "unsupported").length,
      failedFileCount: files.filter((file) => file.status === "failed").length,
      sourceFileCount,
      testFileCount,
      docFileCount,
      testSourceRatio: roundRatio(testFileCount, sourceFileCount),
      symbolCount: artifact.symbols.length,
      callSiteCount: artifact.callSites.length,
      callGraphEdgeCount: artifact.callGraph?.callEdges.length ?? 0,
      dataFlowEdgeCount: artifact.callGraph?.dataFlowEdges.length ?? 0,
      crossFileCallEdgeCount: (artifact.callGraph?.callEdges ?? []).filter(
        (edge) => pathFromFqn(edge.caller) !== pathFromFqn(edge.callee),
      ).length,
      ...(dominantLanguage === undefined ? {} : { dominantLanguage }),
      languages,
      modules,
      moduleDependencyEdges,
      layers: layerHierarchy.levels,
      layerViolations: layerHierarchy.violations,
      moduleCycles,
      externalDependencies: summarizeExternalDependencies(
        artifact.projectGraph.externalDependencies,
      ),
      unresolvedDependencyCount: artifact.projectGraph.unresolvedDependencies.length,
      dependencyCycles: artifact.projectGraph.cycles.map((cycle) => [...cycle]),
      cycleCount: artifact.projectGraph.cycles.length,
    };
  }
}

export function summarizeMainlineProjectPanorama(
  artifact: MainlineProjectIntelligenceArtifact,
): MainlineProjectPanoramaSummary {
  return new ProjectPanoramaSummary().summarize(artifact);
}

function buildLanguageSummaries(
  artifact: MainlineProjectIntelligenceArtifact,
): MainlineProjectLanguageSummary[] {
  const symbolCountByFile = countSymbolsByFile(artifact);
  const byLanguage = new Map<string, MainlineProjectLanguageSummary>();
  for (const file of artifact.files) {
    const current =
      byLanguage.get(file.languageId) ??
      ({
        languageId: file.languageId,
        fileCount: 0,
        parsedFileCount: 0,
        symbolCount: 0,
      } satisfies MainlineProjectLanguageSummary);
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

function buildModuleSummaries(
  artifact: MainlineProjectIntelligenceArtifact,
  symbolCountByFile: ReadonlyMap<string, number>,
): MainlineProjectModuleSummary[] {
  const modules = new Map<string, ModuleAccumulator>();
  for (const file of artifact.files) {
    const name = mainlineModuleNameForPath(file.path);
    const accumulator = modules.get(name) ?? {
      name,
      files: [],
      dependencies: new Set<string>(),
      dependents: new Set<string>(),
      externalDependencies: new Set<string>(),
    };
    accumulator.files.push(file);
    modules.set(name, accumulator);
  }

  for (const edge of artifact.projectGraph.edges) {
    if (!edge.from.startsWith("file:") || !edge.to.startsWith("file:")) {
      continue;
    }
    const fromModule = mainlineModuleNameForPath(edge.from.slice("file:".length));
    const toModule = mainlineModuleNameForPath(edge.to.slice("file:".length));
    if (!fromModule || !toModule || fromModule === toModule) {
      continue;
    }
    modules.get(fromModule)?.dependencies.add(toModule);
    modules.get(toModule)?.dependents.add(fromModule);
  }

  for (const dependency of artifact.projectGraph.externalDependencies) {
    modules
      .get(mainlineModuleNameForPath(dependency.fromPath))
      ?.externalDependencies.add(dependency.specifier);
  }

  return [...modules.values()]
    .map((module) => {
      const files = module.files.sort((left, right) => left.path.localeCompare(right.path));
      const sourceFileCount = files.filter(isSourceFile).length;
      const testFileCount = files.filter(isTestFile).length;
      const docFileCount = files.filter(isDocFile).length;
      return {
        name: module.name,
        role: inferModuleRole(module.name, files),
        fileCount: files.length,
        sourceFileCount,
        testFileCount,
        docFileCount,
        symbolCount: files.reduce((sum, file) => sum + (symbolCountByFile.get(file.path) ?? 0), 0),
        dependencyCount: module.dependencies.size,
        dependentCount: module.dependents.size,
        externalDependencyCount: module.externalDependencies.size,
        languages: [...new Set(files.map((file) => file.languageId))].sort(),
        representativePaths: files.slice(0, 5).map((file) => file.path),
      } satisfies MainlineProjectModuleSummary;
    })
    .sort(
      (left, right) =>
        right.fileCount - left.fileCount ||
        right.symbolCount - left.symbolCount ||
        left.name.localeCompare(right.name),
    );
}

function summarizeExternalDependencies(
  dependencies: readonly MainlineProjectGraphExternalDependency[],
): MainlineExternalDependencySummary[] {
  const bySpecifier = new Map<
    string,
    { readonly kinds: Set<string>; readonly fromPaths: Set<string>; count: number }
  >();
  for (const dependency of dependencies) {
    const current = bySpecifier.get(dependency.specifier) ?? {
      kinds: new Set<string>(),
      fromPaths: new Set<string>(),
      count: 0,
    };
    current.kinds.add(dependency.kind);
    current.fromPaths.add(dependency.fromPath);
    current.count += 1;
    bySpecifier.set(dependency.specifier, current);
  }
  return [...bySpecifier.entries()]
    .map(([specifier, summary]) => ({
      specifier,
      count: summary.count,
      kinds: [...summary.kinds].sort(),
      fromPaths: [...summary.fromPaths].sort(),
    }))
    .sort(
      (left, right) => right.count - left.count || left.specifier.localeCompare(right.specifier),
    );
}

function buildModuleDependencyEdges(
  artifact: MainlineProjectIntelligenceArtifact,
): MainlineProjectModuleDependencyEdge[] {
  const edges: MainlineProjectModuleDependencyEdge[] = [];

  for (const edge of artifact.projectGraph.edges) {
    if (!edge.from.startsWith("file:") || !edge.to.startsWith("file:")) {
      continue;
    }
    const from = mainlineModuleNameForPath(edge.from.slice("file:".length));
    const to = mainlineModuleNameForPath(edge.to.slice("file:".length));
    if (from !== to) {
      edges.push({ from, to, relation: edge.kind, weight: 0.5 });
    }
  }

  for (const edge of artifact.callGraph?.callEdges ?? []) {
    const from = mainlineModuleNameForPath(edge.file);
    const to = mainlineModuleNameForPath(pathFromFqn(edge.callee));
    if (from !== to) {
      edges.push({ from, to, relation: "calls", weight: 1.0 });
    }
  }

  for (const edge of artifact.callGraph?.dataFlowEdges ?? []) {
    const from = mainlineModuleNameForPath(pathFromFqn(edge.from));
    const to = mainlineModuleNameForPath(pathFromFqn(edge.to));
    if (from !== to) {
      edges.push({ from, to, relation: "data_flow", weight: 0.8 });
    }
  }

  return dedupeModuleEdges(edges);
}

function dedupeModuleEdges(
  edges: readonly MainlineProjectModuleDependencyEdge[],
): MainlineProjectModuleDependencyEdge[] {
  const byKey = new Map<string, MainlineProjectModuleDependencyEdge>();
  for (const edge of edges) {
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.relation}`;
    const current = byKey.get(key);
    byKey.set(key, {
      from: edge.from,
      to: edge.to,
      relation: edge.relation,
      weight: (current?.weight ?? 0) + edge.weight,
    });
  }
  return [...byKey.values()].sort(
    (left, right) =>
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to) ||
      left.relation.localeCompare(right.relation),
  );
}

function findModuleCycles(
  edges: readonly MainlineProjectModuleDependencyEdge[],
): MainlineProjectModuleCycle[] {
  const nodes = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    nodes.add(edge.from);
    nodes.add(edge.to);
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  }
  for (const [node, targets] of adjacency) {
    adjacency.set(node, [...new Set(targets)].sort());
  }

  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const cycles: MainlineProjectModuleCycle[] = [];

  const strongConnect = (node: string): void => {
    indices.set(node, index);
    lowlinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of adjacency.get(node) ?? []) {
      if (!indices.has(next)) {
        strongConnect(next);
        lowlinks.set(node, Math.min(lowlinks.get(node) ?? 0, lowlinks.get(next) ?? 0));
      } else if (onStack.has(next)) {
        lowlinks.set(node, Math.min(lowlinks.get(node) ?? 0, indices.get(next) ?? 0));
      }
    }

    if (lowlinks.get(node) === indices.get(node)) {
      const component: string[] = [];
      let current: string | undefined;
      do {
        current = stack.pop();
        if (current) {
          onStack.delete(current);
          component.push(current);
        }
      } while (current && current !== node);

      if (component.length > 1) {
        const cycle = canonicalizeModuleCycle(component);
        cycles.push({
          cycle,
          severity: cycle.length > 3 ? "error" : "warning",
        });
      }
    }
  };

  for (const node of [...nodes].sort()) {
    if (!indices.has(node)) {
      strongConnect(node);
    }
  }

  return cycles.sort((left, right) =>
    left.cycle.join("\u0000").localeCompare(right.cycle.join("\u0000")),
  );
}

function inferModuleLayers(
  moduleNames: readonly string[],
  edges: readonly MainlineProjectModuleDependencyEdge[],
  cycles: readonly MainlineProjectModuleCycle[],
): {
  readonly levels: MainlineProjectLayerLevel[];
  readonly violations: MainlineProjectLayerViolation[];
} {
  const modules = new Set(moduleNames);
  const cyclePairs = new Set<string>();
  for (const cycle of cycles) {
    for (let index = 0; index < cycle.cycle.length; index += 1) {
      const from = cycle.cycle[index];
      const to = cycle.cycle[(index + 1) % cycle.cycle.length];
      cyclePairs.add(`${from}\u0000${to}`);
    }
  }

  const adjacency = new Map<string, Set<string>>();
  for (const moduleName of modules) {
    adjacency.set(moduleName, new Set());
  }
  for (const edge of edges) {
    modules.add(edge.from);
    modules.add(edge.to);
    adjacency.set(edge.from, adjacency.get(edge.from) ?? new Set());
    adjacency.set(edge.to, adjacency.get(edge.to) ?? new Set());
    if (edge.from !== edge.to && !cyclePairs.has(`${edge.from}\u0000${edge.to}`)) {
      adjacency.get(edge.from)?.add(edge.to);
    }
  }

  const levels = new Map<string, number>();
  const active = new Set<string>();
  const computeLevel = (moduleName: string): number => {
    const cached = levels.get(moduleName);
    if (cached !== undefined) {
      return cached;
    }
    if (active.has(moduleName)) {
      return 0;
    }
    active.add(moduleName);
    const deps = [...(adjacency.get(moduleName) ?? [])];
    const level = deps.length === 0 ? 0 : Math.max(...deps.map((dep) => computeLevel(dep))) + 1;
    active.delete(moduleName);
    levels.set(moduleName, level);
    return level;
  };

  for (const moduleName of [...modules].sort()) {
    computeLevel(moduleName);
  }

  const grouped = new Map<number, string[]>();
  for (const [moduleName, level] of levels) {
    grouped.set(level, [...(grouped.get(level) ?? []), moduleName]);
  }
  const sortedGroups = [...grouped.entries()].sort((left, right) => left[0] - right[0]);
  const layerLevels = sortedGroups.map(([level, groupedModules]) => ({
    level,
    name: inferLayerName(groupedModules, level, sortedGroups.length),
    modules: groupedModules.sort(),
  }));

  const violations = edges.flatMap((edge) => {
    const fromLayer = levels.get(edge.from);
    const toLayer = levels.get(edge.to);
    if (fromLayer === undefined || toLayer === undefined || fromLayer >= toLayer) {
      return [];
    }
    return [
      {
        from: edge.from,
        to: edge.to,
        fromLayer,
        toLayer,
        relation: edge.relation,
      },
    ];
  });

  return { levels: layerLevels, violations };
}

function inferLayerName(modules: readonly string[], level: number, layerCount: number): string {
  const joined = modules.join(" ");
  if (/foundation|core|base|shared|common/i.test(joined) || level === 0) {
    return "Foundation";
  }
  if (/model|entity|dto/i.test(joined)) {
    return "Model";
  }
  if (/service|repository|manager|provider|store/i.test(joined)) {
    return "Service";
  }
  if (/network|api|http/i.test(joined)) {
    return "Networking";
  }
  if (/ui|view|screen|component|widget/i.test(joined)) {
    return "UI";
  }
  if (/router|coordinator|navigation/i.test(joined)) {
    return "Routing";
  }
  if (/test|spec|mock/i.test(joined)) {
    return "Test";
  }
  if (level === layerCount - 1) {
    return "Application";
  }
  return "Feature";
}

function canonicalizeModuleCycle(cycle: readonly string[]): string[] {
  if (cycle.length === 0) {
    return [];
  }
  const rotations = cycle.map((_, index) => [...cycle.slice(index), ...cycle.slice(0, index)]);
  return (
    rotations.sort((left, right) => left.join("\u0000").localeCompare(right.join("\u0000")))[0] ??
    []
  );
}

function pathFromFqn(fqn: string): string {
  return fqn.startsWith("symbol:")
    ? (fqn.slice("symbol:".length).split("::")[0] ?? fqn)
    : (fqn.split("::")[0] ?? fqn);
}

function countSymbolsByFile(artifact: MainlineProjectIntelligenceArtifact): Map<string, number> {
  const counts = new Map<string, number>();
  for (const symbol of artifact.symbols) {
    counts.set(symbol.file, (counts.get(symbol.file) ?? 0) + 1);
  }
  return counts;
}

export function mainlineModuleNameForPath(filePath: string): string {
  const segments = filePath.split("/").filter(Boolean);
  if (segments.length <= 1) {
    return path.posix.dirname(filePath) === "." ? "(root)" : path.posix.dirname(filePath);
  }
  if (["apps", "packages"].includes(segments[0] ?? "") && segments[1]) {
    return `${segments[0]}/${segments[1]}`;
  }
  if (["lib", "src", "app"].includes(segments[0] ?? "") && segments[1]) {
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0] ?? "(root)";
}

function inferModuleRole(
  moduleName: string,
  files: readonly MainlineProjectIntelligenceFile[],
): MainlineProjectModuleRole {
  const haystack = `${moduleName}/${files.map((file) => file.path).join("/")}`.toLowerCase();
  if (files.every(isTestFile) || /(^|\/)(__tests__|tests?|spec)(\/|$)/.test(haystack)) {
    return "test";
  }
  if (files.every(isDocFile) || /(^|\/)(docs?|documentation)(\/|$)/.test(haystack)) {
    return "documentation";
  }
  if (/(^|\/)(agent|agents|workflow|workflows|runtime)(\/|$)/.test(haystack)) {
    return "agent-orchestration";
  }
  if (/(^|\/)(component|components|pages|screens|views|ui)(\/|$)/.test(haystack)) {
    return "interface";
  }
  if (/(^|\/)(db|data|database|model|models|schema|repository|repositories)(\/|$)/.test(haystack)) {
    return "data";
  }
  if (/(^|\/)(api|client|service|services|server|network)(\/|$)/.test(haystack)) {
    return "service";
  }
  if (/(^|\/)(config|scripts?|bin|cli)(\/|$)/.test(haystack)) {
    return "operations";
  }
  return "core";
}

function isSourceFile(file: MainlineProjectIntelligenceFile): boolean {
  return !isTestFile(file) && !isDocFile(file) && file.status === "parsed";
}

function isTestFile(file: MainlineProjectIntelligenceFile): boolean {
  return /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[a-z0-9]+$/i.test(file.path);
}

function isDocFile(file: MainlineProjectIntelligenceFile): boolean {
  return /(^|\/)(docs?|documentation)(\/|$)|\.(md|mdx|rst)$/i.test(file.path);
}

function roundRatio(left: number, right: number): number {
  if (right <= 0) {
    return left > 0 ? 1 : 0;
  }
  return Math.round((left / right) * 1000) / 1000;
}

import path from "node:path";
import type { EngineeringCodeGraphReader } from "../code/types.js";
import type {
  EngineeringDependencyEdge,
  EngineeringDependencyGraph,
  EngineeringDependencyGraphLayer,
  EngineeringDependencyNode,
  EngineeringFile,
  EngineeringModuleRelationEdge,
  EngineeringRelationshipGraph,
} from "../foundation/types.js";
import { normalizeEngineeringDependencyNode } from "../foundation/types.js";
import { EngineeringLanguageService } from "../language/service.js";
import { engineeringModuleNameForPath, toEngineeringRelativePath } from "../workspace/paths.js";
import {
  inferModuleRole,
  isConfigFile,
  isDocFile,
  isExternalDependencyName,
  isExternalNode,
  isHostNode,
  isResourceWrapperDir,
  isVendorDir,
  SOURCE_WRAPPER_DIRS,
  shouldUseModuleDiscoveryFile,
  TEST_WRAPPER_DIRS,
} from "./module-discovery-rules.js";
import type {
  DependencyGraphModuleFacts,
  EngineeringDiscoveredModuleFact,
  EngineeringDiscoveredModuleFileGroups,
  EngineeringDiscoveredModuleNeighbors,
  EngineeringModuleDiscovererInput,
  EngineeringModuleDiscoveryResult,
  EngineeringModuleDiscoverySignal,
  EngineeringModuleDiscoverySignalSource,
  ModuleDraft,
  ModuleIndex,
  NormalizedModuleFile,
} from "./module-discovery-types.js";
import { inferImportFallbackEdges } from "./module-import-inference.js";

export type {
  EngineeringDiscoveredModuleFact,
  EngineeringDiscoveredModuleFileGroups,
  EngineeringDiscoveredModuleNeighbors,
  EngineeringImportFact,
  EngineeringModuleDiscovererInput,
  EngineeringModuleDiscoveryResult,
  EngineeringModuleDiscoverySignal,
  EngineeringModuleDiscoverySignalSource,
} from "./module-discovery-types.js";

import type { EngineeringPanoramaModuleSummary } from "./types.js";

/**
 * Pure engineering-fact module discovery for Panorama.
 * It consumes already-collected files, dependency graph nodes/edges, and optional code/import facts.
 */
export class EngineeringModuleDiscoverer {
  discover(input: EngineeringModuleDiscovererInput): EngineeringModuleDiscoveryResult {
    const files = normalizeFiles(input.projectRoot, input.files).filter((file) =>
      shouldUseModuleDiscoveryFile(file.relativePath),
    );
    const graphFacts = readDependencyGraphFacts(input.dependencyGraph);
    const configLayers = injectApplicationLayer(
      input.dependencyGraph.layers ?? [],
      graphFacts.hostNames.size > 0,
    );
    const modules = buildModuleDrafts(files, graphFacts, configLayers);
    const moduleIndex = buildModuleIndex(modules);
    const graphEdges = dependencyGraphEdgesToRelations(input.dependencyGraph.edges, moduleIndex);
    const importEdges = inferImportFallbackEdges(input, files, moduleIndex, graphEdges);
    const relationships = buildRelationships([...graphEdges, ...importEdges]);
    const enrichedGraph = enrichDependencyGraph(
      input.dependencyGraph,
      modules,
      importEdges,
      configLayers,
    );
    const concreteModules = finalizeModules(modules, relationships.moduleEdges);

    return {
      modules: concreteModules,
      panorama: {
        modules: concreteModules.map((module) => moduleSummary(module, input.codeGraph)),
      },
      relationships,
      dependencyGraph: enrichedGraph,
      configLayers,
      signals: collectSignals(concreteModules, importEdges),
    };
  }
}

function normalizeFiles(
  projectRoot: string,
  files: readonly EngineeringFile[],
): NormalizedModuleFile[] {
  return files.map((file) => ({
    file,
    relativePath: toEngineeringRelativePath(projectRoot, file.relativePath || file.path),
  }));
}

function readDependencyGraphFacts(dependencyGraph: EngineeringDependencyGraph): {
  readonly localNodes: ReadonlyMap<string, EngineeringDependencyNode>;
  readonly externalNames: ReadonlySet<string>;
  readonly hostNames: ReadonlySet<string>;
} {
  const localNodes = new Map<string, EngineeringDependencyNode>();
  const externalNames = new Set<string>();
  const hostNames = new Set<string>();

  for (const rawNode of dependencyGraph.nodes) {
    const node = normalizeEngineeringDependencyNode(rawNode);
    if (isExternalNode(node)) {
      externalNames.add(node.id);
      continue;
    }
    localNodes.set(node.id, node);
    if (isHostNode(node)) {
      hostNames.add(node.id);
    }
  }

  return { localNodes, externalNames, hostNames };
}

function injectApplicationLayer(
  layers: readonly EngineeringDependencyGraphLayer[],
  hasHostModules: boolean,
): readonly EngineeringDependencyGraphLayer[] {
  if (!hasHostModules || layers.length === 0) {
    return layers;
  }
  if (layers.some((layer) => /^(app|application)$/i.test(layer.name))) {
    return layers;
  }
  const minOrder = Math.min(...layers.map((layer) => layer.order));
  return [
    {
      name: "Application",
      order: minOrder - 1,
      accessibleLayers: layers.map((layer) => layer.name),
    },
    ...layers,
  ];
}

function buildModuleDrafts(
  files: readonly NormalizedModuleFile[],
  graphFacts: DependencyGraphModuleFacts,
  configLayers: readonly EngineeringDependencyGraphLayer[],
): Map<string, ModuleDraft> {
  const modules = new Map<string, ModuleDraft>();
  for (const [name, node] of graphFacts.localNodes) {
    const draft = ensureModule(modules, name);
    draft.kind = isHostNode(node) ? "host" : "local";
    draft.configLayer = typeof node.layer === "string" ? node.layer : undefined;
    draft.role = inferModuleRole(name, node, draft.configLayer);
    draft.signals.add("dependency-graph");
    if (draft.configLayer) {
      draft.signals.add("config");
    }
  }

  const hostNames = graphFacts.hostNames;
  const hostFiles = new Map<string, NormalizedModuleFile[]>();
  for (const file of files) {
    const hostName = hostNameForFile(file, hostNames);
    if (hostName) {
      hostFiles.set(hostName, [...(hostFiles.get(hostName) ?? []), file]);
      continue;
    }
    const moduleName = moduleNameForFile(file, graphFacts.localNodes);
    const draft = ensureModule(modules, moduleName);
    if (moduleName === "(root)" && graphFacts.localNodes.size === 0) {
      draft.kind = "fallback";
      draft.signals.add("unknown-fallback");
    }
    draft.files.add(file.relativePath);
    if (draft.kind !== "fallback") {
      draft.signals.add("file-group");
    }
    if (!draft.role) {
      draft.role = inferModuleRole(moduleName, undefined, draft.configLayer);
    }
  }

  for (const [hostName, ownedFiles] of hostFiles) {
    decomposeHostModule(modules, hostName, ownedFiles, configLayers.length > 0);
  }

  enrichKnownModuleFiles(modules, files, graphFacts.localNodes);

  if (modules.size === 0) {
    const fallbackName = "(root)";
    const draft = ensureModule(modules, fallbackName);
    draft.kind = "fallback";
    draft.role = "core";
    draft.signals.add("unknown-fallback");
    for (const file of files) {
      draft.files.add(file.relativePath);
    }
  }

  for (const draft of modules.values()) {
    if (!draft.role) {
      draft.role = inferModuleRole(draft.name, undefined, draft.configLayer);
    }
    if (draft.configLayer && !draft.signals.has("config")) {
      draft.signals.add("config");
    }
  }

  return modules;
}

function ensureModule(modules: Map<string, ModuleDraft>, name: string): ModuleDraft {
  const current = modules.get(name);
  if (current) {
    return current;
  }
  const draft: ModuleDraft = {
    name,
    kind: "local",
    role: undefined,
    configLayer: undefined,
    files: new Set(),
    signals: new Set(),
  };
  modules.set(name, draft);
  return draft;
}

function hostNameForFile(
  file: NormalizedModuleFile,
  hostNames: ReadonlySet<string>,
): string | undefined {
  if (file.file.targetName && hostNames.has(file.file.targetName)) {
    return file.file.targetName;
  }
  const firstSegment = file.relativePath.split("/").filter(Boolean)[0];
  return firstSegment && hostNames.has(firstSegment) ? firstSegment : undefined;
}

function moduleNameForFile(
  file: NormalizedModuleFile,
  localNodes: ReadonlyMap<string, EngineeringDependencyNode>,
): string {
  if (file.file.targetName && localNodes.has(file.file.targetName)) {
    return file.file.targetName;
  }
  const pathMatch = matchKnownModuleByPath(file.relativePath, localNodes);
  return pathMatch ?? engineeringModuleNameForPath(file.relativePath);
}

function matchKnownModuleByPath(
  relativePath: string,
  localNodes: ReadonlyMap<string, EngineeringDependencyNode>,
): string | undefined {
  const sortedNames = [...localNodes.keys()].sort((left, right) => right.length - left.length);
  for (const name of sortedNames) {
    const normalized = name.split(path.sep).join("/");
    if (relativePath === normalized || relativePath.startsWith(`${normalized}/`)) {
      return name;
    }
    if (relativePath.includes(`/${normalized}/`)) {
      return name;
    }
  }
  return undefined;
}

function decomposeHostModule(
  modules: Map<string, ModuleDraft>,
  hostName: string,
  files: readonly NormalizedModuleFile[],
  hasConfigLayers: boolean,
): void {
  const existingNames = new Set(modules.keys());
  const rootFiles: string[] = [];
  const groups = new Map<string, string[]>();

  for (const file of files) {
    const relativeToHost = stripHostPrefix(file.relativePath, hostName);
    const segments = relativeToHost.split("/").filter(Boolean);
    const groupName = hostSubmoduleName(segments);
    if (!groupName) {
      rootFiles.push(file.relativePath);
      continue;
    }
    groups.set(groupName, [...(groups.get(groupName) ?? []), file.relativePath]);
  }

  for (const [groupName, groupFiles] of groups) {
    if (groupFiles.length < 2) {
      rootFiles.push(...groupFiles);
      continue;
    }
    const moduleName = existingNames.has(groupName) ? `${hostName}/${groupName}` : groupName;
    const draft = ensureModule(modules, moduleName);
    draft.kind = "local";
    draft.role = inferModuleRole(groupName, undefined, hasConfigLayers ? "Application" : undefined);
    draft.configLayer = hasConfigLayers ? "Application" : draft.configLayer;
    draft.signals.add("host-decomposition");
    for (const filePath of groupFiles) {
      draft.files.add(filePath);
    }
  }

  if (rootFiles.length > 0) {
    const host = ensureModule(modules, hostName);
    host.kind = "host";
    host.role = "app";
    host.configLayer = hasConfigLayers ? "Application" : host.configLayer;
    host.signals.add("host-decomposition");
    for (const filePath of rootFiles) {
      host.files.add(filePath);
    }
  }
}

function stripHostPrefix(relativePath: string, hostName: string): string {
  return relativePath === hostName
    ? ""
    : relativePath.startsWith(`${hostName}/`)
      ? relativePath.slice(hostName.length + 1)
      : relativePath;
}

function hostSubmoduleName(segments: readonly string[]): string | undefined {
  const [first, second] = segments;
  if (!first) {
    return undefined;
  }
  const firstLower = first.toLowerCase();
  if ((SOURCE_WRAPPER_DIRS.has(firstLower) || TEST_WRAPPER_DIRS.has(firstLower)) && second) {
    return second;
  }
  if (isResourceWrapperDir(firstLower) || isVendorDir(first)) {
    return undefined;
  }
  return first;
}

function enrichKnownModuleFiles(
  modules: Map<string, ModuleDraft>,
  files: readonly NormalizedModuleFile[],
  localNodes: ReadonlyMap<string, EngineeringDependencyNode>,
): void {
  for (const [name, node] of localNodes) {
    const draft = modules.get(name);
    if (!draft || draft.files.size > 0 || isHostNode(node)) {
      continue;
    }
    const matches = files.filter((file) => moduleNameForFile(file, localNodes) === name);
    for (const file of matches) {
      draft.files.add(file.relativePath);
    }
    if (matches.length > 0) {
      draft.signals.add("file-group");
    }
  }
}

function buildModuleIndex(modules: ReadonlyMap<string, ModuleDraft>): ModuleIndex {
  const fileToModule = new Map<string, string>();
  const localNames = new Set<string>();
  const externalNames = new Set<string>();
  for (const module of modules.values()) {
    if (module.kind === "external") {
      externalNames.add(module.name);
    } else {
      localNames.add(module.name);
    }
    for (const filePath of module.files) {
      fileToModule.set(filePath, module.name);
    }
  }
  return { modules, fileToModule, localNames, externalNames };
}

function dependencyGraphEdgesToRelations(
  edges: readonly EngineeringDependencyEdge[],
  moduleIndex: ModuleIndex,
): EngineeringModuleRelationEdge[] {
  return edges.flatMap((edge) => {
    const from = resolveGraphEndpoint(edge.from, moduleIndex);
    const to = resolveGraphEndpoint(edge.to, moduleIndex);
    if (!from || !to || from === to) {
      return [];
    }
    return [
      {
        from,
        to,
        relation: normalizeDependencyRelation(edge.type),
        source: "config",
        weight: edge.weight ?? 1,
      },
    ];
  });
}

function resolveGraphEndpoint(value: string, moduleIndex: ModuleIndex): string | undefined {
  if (moduleIndex.localNames.has(value) || moduleIndex.externalNames.has(value)) {
    return value;
  }
  if (moduleIndex.fileToModule.has(value)) {
    return moduleIndex.fileToModule.get(value);
  }
  const normalizedPath = value.split(path.sep).join("/");
  if (moduleIndex.fileToModule.has(normalizedPath)) {
    return moduleIndex.fileToModule.get(normalizedPath);
  }
  for (const moduleName of moduleIndex.localNames) {
    if (normalizedPath === moduleName || normalizedPath.startsWith(`${moduleName}/`)) {
      return moduleName;
    }
  }
  return value || undefined;
}

function normalizeDependencyRelation(type: string): string {
  return type === "dependency" || type === "targetDependency" || type === "package"
    ? "depends_on"
    : type;
}

function buildRelationships(
  edges: readonly EngineeringModuleRelationEdge[],
): EngineeringRelationshipGraph {
  const merged = new Map<string, EngineeringModuleRelationEdge>();
  for (const edge of edges) {
    if (!edge.from || !edge.to || edge.from === edge.to) {
      continue;
    }
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.relation}\u0000${edge.source}`;
    const current = merged.get(key);
    merged.set(key, {
      ...edge,
      weight: (current?.weight ?? 0) + edge.weight,
    });
  }
  return {
    moduleEdges: [...merged.values()].sort(
      (left, right) =>
        left.from.localeCompare(right.from) ||
        left.to.localeCompare(right.to) ||
        left.source.localeCompare(right.source),
    ),
    cycles: [],
    layers: [],
    layerViolations: [],
  };
}

function enrichDependencyGraph(
  graph: EngineeringDependencyGraph,
  modules: ReadonlyMap<string, ModuleDraft>,
  importEdges: readonly EngineeringModuleRelationEdge[],
  configLayers: readonly EngineeringDependencyGraphLayer[],
): EngineeringDependencyGraph {
  const existingNodeIds = new Set(
    graph.nodes.map((node) => normalizeEngineeringDependencyNode(node).id),
  );
  const extraNodes: EngineeringDependencyNode[] = [];
  for (const module of modules.values()) {
    if (!existingNodeIds.has(module.name)) {
      extraNodes.push({
        id: module.name,
        type: module.kind === "fallback" ? "inferred" : module.kind,
        ...(module.configLayer ? { layer: module.configLayer } : {}),
        ...(module.role ? { conventionRole: module.role } : {}),
      });
    }
  }
  for (const edge of importEdges) {
    if (!existingNodeIds.has(edge.to) && !modules.has(edge.to)) {
      existingNodeIds.add(edge.to);
      extraNodes.push({ id: edge.to, type: "external", indirect: true });
    }
  }
  const extraEdges: EngineeringDependencyEdge[] = importEdges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    type: "import",
    weight: edge.weight,
  }));

  return {
    nodes: [...graph.nodes, ...extraNodes],
    edges: [...graph.edges, ...extraEdges],
    layers: configLayers,
  };
}

function finalizeModules(
  modules: ReadonlyMap<string, ModuleDraft>,
  edges: readonly EngineeringModuleRelationEdge[],
): EngineeringDiscoveredModuleFact[] {
  const localModuleNames = new Set(modules.keys());
  return [...modules.values()]
    .filter((module) => module.files.size > 0 || module.signals.has("dependency-graph"))
    .map((module) => {
      const files = [...module.files].sort();
      return {
        name: module.name,
        role: module.role ?? "core",
        kind: module.kind,
        files,
        fileGroups: groupModuleFiles(files),
        neighbors: moduleNeighbors(module.name, edges, localModuleNames),
        configLayer: module.configLayer,
        discoverySignals: [...module.signals].sort(),
      };
    })
    .sort(
      (left, right) =>
        right.files.length - left.files.length || left.name.localeCompare(right.name),
    );
}

function moduleSummary(
  module: EngineeringDiscoveredModuleFact,
  codeGraph: EngineeringCodeGraphReader | undefined,
): EngineeringPanoramaModuleSummary {
  return {
    name: module.name,
    role: module.role,
    fileCount: module.files.length,
    sourceFileCount: module.fileGroups.source.length,
    testFileCount: module.fileGroups.test.length,
    docFileCount: module.fileGroups.doc.length,
    symbolCount: countSymbols(module.files, codeGraph),
    dependencyCount: module.neighbors.dependencies.length,
    dependentCount: module.neighbors.dependents.length,
    externalDependencyCount: module.neighbors.externalDependencies.length,
    languages: moduleLanguages(module.files, codeGraph),
    representativePaths: module.files,
  };
}

function groupModuleFiles(files: readonly string[]): EngineeringDiscoveredModuleFileGroups {
  const groups = {
    source: [] as string[],
    test: [] as string[],
    doc: [] as string[],
    config: [] as string[],
  };
  for (const filePath of files) {
    if (isDocFile(filePath)) {
      groups.doc.push(filePath);
    } else if (EngineeringLanguageService.isTestFile(filePath)) {
      groups.test.push(filePath);
    } else if (isConfigFile(filePath)) {
      groups.config.push(filePath);
    } else {
      groups.source.push(filePath);
    }
  }
  return groups;
}

function moduleNeighbors(
  moduleName: string,
  edges: readonly EngineeringModuleRelationEdge[],
  localModuleNames: ReadonlySet<string>,
): EngineeringDiscoveredModuleNeighbors {
  const dependencies = new Set<string>();
  const dependents = new Set<string>();
  const externalDependencies = new Set<string>();
  for (const edge of edges) {
    if (edge.from === moduleName) {
      if (localModuleNames.has(edge.to)) {
        dependencies.add(edge.to);
      } else if (isExternalDependencyName(edge.to)) {
        externalDependencies.add(edge.to);
      }
    }
    if (edge.to === moduleName) {
      dependents.add(edge.from);
    }
  }
  return {
    dependencies: [...dependencies].sort(),
    dependents: [...dependents].sort(),
    externalDependencies: [...externalDependencies].sort(),
  };
}

function countSymbols(
  files: readonly string[],
  codeGraph: EngineeringCodeGraphReader | undefined,
): number {
  if (!codeGraph) {
    return 0;
  }
  let count = 0;
  for (const filePath of files) {
    const symbols = codeGraph.getFileSymbols(filePath);
    count +=
      (symbols?.classes.length ?? 0) +
      (symbols?.protocols.length ?? 0) +
      (symbols?.categories.length ?? 0);
  }
  return count;
}

function moduleLanguages(
  files: readonly string[],
  codeGraph: EngineeringCodeGraphReader | undefined,
): string[] {
  const languages = new Set<string>();
  for (const filePath of files) {
    const graphLanguage = codeGraph?.getFileSymbols(filePath)?.languageId;
    languages.add(graphLanguage ?? EngineeringLanguageService.inferLang(filePath));
  }
  return [...languages].filter((language) => language !== "unknown").sort();
}

function collectSignals(
  modules: readonly EngineeringDiscoveredModuleFact[],
  importEdges: readonly EngineeringModuleRelationEdge[],
): readonly EngineeringModuleDiscoverySignal[] {
  const signals: EngineeringModuleDiscoverySignal[] = [];
  for (const module of modules) {
    for (const source of module.discoverySignals) {
      signals.push({
        source,
        module: module.name,
        message: signalMessage(source, module.name),
        confidence: signalConfidence(source),
      });
    }
  }
  for (const edge of importEdges) {
    signals.push({
      source: "import-fallback",
      module: edge.from,
      message: `Inferred ${edge.from} -> ${edge.to} from import facts`,
      confidence: 0.55,
    });
  }
  return signals;
}

function signalMessage(source: EngineeringModuleDiscoverySignalSource, moduleName: string): string {
  switch (source) {
    case "config":
      return `${moduleName} carries a config-declared layer`;
    case "dependency-graph":
      return `${moduleName} came from dependency graph nodes`;
    case "file-group":
      return `${moduleName} was grouped from owned file paths`;
    case "host-decomposition":
      return `${moduleName} was decomposed from a host module`;
    case "import-fallback":
      return `${moduleName} has fallback import edges`;
    case "unknown-fallback":
      return `${moduleName} is an unknown fallback module`;
  }
}

function signalConfidence(source: EngineeringModuleDiscoverySignalSource): number {
  switch (source) {
    case "config":
    case "dependency-graph":
      return 0.9;
    case "file-group":
    case "host-decomposition":
      return 0.75;
    case "import-fallback":
      return 0.55;
    case "unknown-fallback":
      return 0.3;
  }
}

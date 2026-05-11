import path from "node:path";
import type {
  EngineeringDependencyEdge,
  EngineeringDependencyGraph,
  EngineeringDependencyNode,
  EngineeringFile,
  EngineeringTarget,
} from "../foundation/EngineeringCoreTypes.js";
import { EngineeringLanguageService } from "../language/EngineeringLanguageService.js";
import type { EngineeringWorkspaceReader } from "./ProjectDiscoverer.js";
import type { EngineeringDiscoveryParseResult } from "./parsers/index.js";

export interface MutableEngineeringDependencyGraph {
  readonly layers?: EngineeringDependencyGraph["layers"];
  nodes: Array<EngineeringDependencyNode | string>;
  edges: EngineeringDependencyEdge[];
}

export const COMMON_EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  ...EngineeringLanguageService.scanSkipDirs,
  ".cursor",
  ".idea",
  ".next",
  ".nuxt",
  ".pub-cache",
  ".pub",
  ".ruff_cache",
  ".tox",
  ".turbo",
  ".vscode",
  "_output",
  "coverage",
  "ios",
  "android",
  "linux",
  "macos",
  "windows",
  "web",
]);

export function targetByName(
  targets: readonly EngineeringTarget[],
  target: EngineeringTarget | string,
  fallbackPath: string | null,
): EngineeringTarget | null {
  if (typeof target !== "string") {
    return target;
  }
  return targets.find((candidate) => candidate.name === target) ?? nullTarget(target, fallbackPath);
}

export function nullTarget(name: string, fallbackPath: string | null): EngineeringTarget | null {
  if (fallbackPath === null) {
    return null;
  }
  return { name, path: fallbackPath, type: "library", language: "unknown" };
}

export async function collectSourceFiles(
  reader: EngineeringWorkspaceReader,
  dir: string,
  options: {
    readonly rootDir?: string;
    readonly extensions?: ReadonlySet<string>;
    readonly language?: string;
    readonly maxDepth?: number;
    readonly maxFiles?: number;
    readonly includeContent?: boolean;
    readonly excludeDirs?: ReadonlySet<string>;
  } = {},
): Promise<readonly EngineeringFile[]> {
  const rootDir = options.rootDir ?? dir;
  const extensions = options.extensions ?? EngineeringLanguageService.sourceExts;
  const maxDepth = options.maxDepth ?? 15;
  const maxFiles = options.maxFiles ?? 600;
  const excludeDirs = options.excludeDirs ?? COMMON_EXCLUDE_DIRS;
  const files: EngineeringFile[] = [];

  async function walk(currentDir: string, depth: number): Promise<void> {
    if (depth > maxDepth || files.length >= maxFiles) {
      return;
    }
    let entries: readonly {
      readonly name: string;
      readonly isFile: boolean;
      readonly isDirectory: boolean;
    }[];
    try {
      entries = await reader.readDir(currentDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles || entry.name.startsWith(".")) {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory) {
        if (!excludeDirs.has(entry.name)) {
          await walk(fullPath, depth + 1);
        }
        continue;
      }
      if (!entry.isFile || !extensions.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      const language = options.language ?? EngineeringLanguageService.inferLang(entry.name);
      const relativePath = path.relative(rootDir, fullPath);
      files.push({
        name: entry.name,
        path: fullPath,
        relativePath,
        language,
        isTest: EngineeringLanguageService.isTestFile(relativePath),
      });
    }
  }

  await walk(dir, 0);
  return files;
}

export function dedupeTargets(targets: readonly EngineeringTarget[]): readonly EngineeringTarget[] {
  const byName = new Map<string, EngineeringTarget>();
  for (const target of targets) {
    if (!byName.has(target.name)) {
      byName.set(target.name, target);
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function dedupeGraph(
  graph: EngineeringDependencyGraph | MutableEngineeringDependencyGraph,
): EngineeringDependencyGraph {
  const nodeMap = new Map<string, EngineeringDependencyNode | string>();
  for (const node of graph.nodes) {
    const id = typeof node === "string" ? node : node.id;
    nodeMap.set(id, node);
  }
  for (const edge of graph.edges) {
    if (!nodeMap.has(edge.from)) {
      nodeMap.set(edge.from, edge.from);
    }
    if (!nodeMap.has(edge.to)) {
      nodeMap.set(edge.to, { id: edge.to, label: edge.to, type: "external", indirect: true });
    }
  }
  const edgeMap = new Map<string, (typeof graph.edges)[number]>();
  for (const edge of graph.edges) {
    if (edge.from !== edge.to) {
      edgeMap.set(`${edge.from}\u0000${edge.to}\u0000${edge.type}\u0000${edge.scope ?? ""}`, edge);
    }
  }
  return {
    nodes: [...nodeMap.values()],
    edges: [...edgeMap.values()],
    ...(graph.layers === undefined ? {} : { layers: graph.layers }),
  };
}

export function graphFromParseResults(
  results: readonly EngineeringDiscoveryParseResult[],
): EngineeringDependencyGraph {
  const nodes = new Map<string, EngineeringDependencyNode>();
  const edges: EngineeringDependencyEdge[] = [];
  const layers = results.flatMap((result) =>
    result.layers.map((layer) => ({
      name: layer.name,
      order: layer.order,
      accessibleLayers: layer.accessibleLayers,
    })),
  );

  for (const result of results) {
    for (const entity of [
      ...result.projects,
      ...result.targets,
      ...result.modules,
      ...result.packages,
    ]) {
      nodes.set(entity.id, {
        id: entity.id,
        label: entity.name,
        type: entity.type ?? entity.kind,
        ...(entity.path === undefined ? {} : { fullPath: entity.path }),
        ...(entity.type === undefined ? {} : { targetType: entity.type }),
        ...(entity.layer === undefined ? {} : { layer: entity.layer }),
        ...(entity.metadata ?? {}),
      });
    }
    for (const dependency of result.dependencies) {
      edges.push({
        from: dependency.from,
        to: dependency.to,
        type: dependency.kind,
        ...(dependency.scope === undefined ? {} : { scope: dependency.scope }),
        weight: dependency.confidence,
      });
    }
  }

  return dedupeGraph({
    nodes: [...nodes.values()],
    edges,
    ...(layers.length === 0 ? {} : { layers }),
  });
}

export function targetsFromParseResults(
  results: readonly EngineeringDiscoveryParseResult[],
  projectRoot: string,
): readonly EngineeringTarget[] {
  const targets: EngineeringTarget[] = [];
  for (const result of results) {
    for (const entity of [...result.targets, ...result.modules]) {
      targets.push({
        name: entity.name,
        path: path.resolve(projectRoot, entity.path ?? "."),
        type: entity.type ?? entity.kind,
        language: entity.language ?? "unknown",
        metadata: {
          parser: result.parser,
          id: entity.id,
          confidence: entity.confidence,
          ...(entity.metadata ?? {}),
        },
      });
    }
  }
  return dedupeTargets(targets);
}

export function packageNameFromDependency(notation: string): string {
  const parts = notation.split(":");
  return parts.length >= 2 && parts[0] && parts[1] ? `${parts[0]}:${parts[1]}` : notation;
}

export function globBase(pattern: string): string {
  const wildcardIndex = pattern.search(/[*{[]/);
  const prefix = wildcardIndex === -1 ? pattern : pattern.slice(0, wildcardIndex);
  return prefix.replace(/[/\\]+$/, "");
}

export async function expandSimpleWorkspacePatterns(
  reader: EngineeringWorkspaceReader,
  projectRoot: string,
  patterns: readonly string[],
): Promise<readonly string[]> {
  const paths = new Set<string>();
  for (const pattern of patterns) {
    if (pattern.includes("*")) {
      const base = globBase(pattern);
      const parent = path.resolve(projectRoot, base);
      let entries: readonly { readonly name: string; readonly isDirectory: boolean }[];
      try {
        entries = await reader.readDir(parent);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory && !entry.name.startsWith(".")) {
          paths.add(path.join(base, entry.name));
        }
      }
    } else {
      paths.add(pattern);
    }
  }
  return [...paths].sort();
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function objectKeys(value: unknown): string[] {
  const record = recordValue(value);
  return record === null ? [] : Object.keys(record);
}

import path from "node:path";
import {
  type MainlineImportPathAlias,
  MainlineImportPathResolver,
  type MainlineImportRecord,
} from "../code/index.js";
import { normalizeMainlinePosixPath, uniqueMainlinePosixPaths } from "../core/PathIdentity.js";

export type MainlineProjectGraphNodeKind = "file" | "symbol";
export type MainlineProjectGraphEdgeKind =
  | "imports"
  | "exports"
  | "requires"
  | "dynamic-import"
  | "declares";

export interface MainlineProjectGraphSymbolInput {
  readonly name: string;
  readonly kind?: string;
}

export interface MainlineProjectGraphFileInput {
  readonly path: string;
  readonly content: string;
  readonly languageId?: string;
  readonly symbols?: readonly MainlineProjectGraphSymbolInput[];
  readonly imports?: readonly MainlineImportRecord[];
}

export interface MainlineProjectGraphBuildInput {
  readonly projectRoot?: string;
  readonly knownFiles?: readonly string[];
  readonly pathAliases?: readonly MainlineImportPathAlias[];
  readonly files: readonly MainlineProjectGraphFileInput[];
}

export interface MainlineProjectGraphNode {
  readonly id: string;
  readonly kind: MainlineProjectGraphNodeKind;
  readonly path?: string;
  readonly symbol?: string;
  readonly languageId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface MainlineProjectGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: MainlineProjectGraphEdgeKind;
  readonly specifier?: string;
}

export interface MainlineProjectGraphExternalDependency {
  readonly fromPath: string;
  readonly specifier: string;
  readonly kind: Exclude<MainlineProjectGraphEdgeKind, "declares">;
}

export interface MainlineProjectGraphUnresolvedDependency {
  readonly fromPath: string;
  readonly specifier: string;
  readonly normalizedTarget: string;
  readonly kind: Exclude<MainlineProjectGraphEdgeKind, "declares">;
}

export interface MainlineProjectGraph {
  readonly nodes: MainlineProjectGraphNode[];
  readonly edges: MainlineProjectGraphEdge[];
  readonly externalDependencies: MainlineProjectGraphExternalDependency[];
  readonly unresolvedDependencies: MainlineProjectGraphUnresolvedDependency[];
  readonly cycles: string[][];
}

interface NormalizedGraphFile {
  readonly path: string;
  readonly content: string;
  readonly languageId?: string;
  readonly symbols: readonly MainlineProjectGraphSymbolInput[];
  readonly imports: readonly MainlineImportRecord[];
}

export interface MainlineProjectGraphBuilderDependencies {
  readonly importPathResolver?: MainlineImportPathResolver;
}

/**
 * MainlineProjectGraphBuilder 是新主干的项目依赖图底座。
 * 它消费 AST 层产出的 import records 和已扫描文件事实，产出稳定的文件边、符号声明边、外部依赖和循环信息。
 */
export class MainlineProjectGraphBuilder {
  readonly #importPathResolver: MainlineImportPathResolver;

  constructor(dependencies: MainlineProjectGraphBuilderDependencies = {}) {
    this.#importPathResolver = dependencies.importPathResolver ?? new MainlineImportPathResolver();
  }

  build(input: MainlineProjectGraphBuildInput): MainlineProjectGraph {
    const files = normalizeFiles(input.files);
    const knownFiles = normalizeKnownFiles(input.knownFiles, files);
    const nodes: MainlineProjectGraphNode[] = [];
    const edges: MainlineProjectGraphEdge[] = [];
    const externalDependencies: MainlineProjectGraphExternalDependency[] = [];
    const unresolvedDependencies: MainlineProjectGraphUnresolvedDependency[] = [];

    for (const file of files) {
      nodes.push({
        id: fileNodeId(file.path),
        kind: "file",
        path: file.path,
        ...(file.languageId === undefined ? {} : { languageId: file.languageId }),
      });

      for (const symbol of file.symbols) {
        const symbolId = symbolNodeId(file.path, symbol.name);
        nodes.push({
          id: symbolId,
          kind: "symbol",
          path: file.path,
          symbol: symbol.name,
          ...(symbol.kind ? { metadata: { kind: symbol.kind } } : {}),
        });
        edges.push({
          from: fileNodeId(file.path),
          to: symbolId,
          kind: "declares",
        });
      }

      // 图层只消费 AST/import parser 已经确认过的 import records；没有 records 时保守不补扫源码。
      const resolutions =
        file.imports.length > 0
          ? this.#importPathResolver.resolveImports({
              projectRoot: input.projectRoot ?? "/",
              knownFiles,
              importRecords: file.imports,
              fromPath: file.path,
              languageId: file.languageId ?? "unknown",
              ...(input.pathAliases === undefined ? {} : { pathAliases: input.pathAliases }),
            })
          : [];

      for (const resolution of resolutions) {
        const kind = graphEdgeKindForImportRecord(resolution.record);
        if (resolution.status === "resolved" && resolution.resolvedPath) {
          edges.push({
            from: fileNodeId(file.path),
            to: fileNodeId(resolution.resolvedPath),
            kind,
            specifier: resolution.importPath,
          });
          continue;
        }

        if (resolution.status === "unresolved") {
          unresolvedDependencies.push({
            fromPath: file.path,
            specifier: resolution.importPath,
            normalizedTarget: normalizeUnresolvedTarget(file.path, resolution.importPath),
            kind,
          });
          continue;
        }

        if (resolution.status === "external") {
          externalDependencies.push({
            fromPath: file.path,
            specifier: resolution.importPath,
            kind,
          });
        }
      }
    }

    const fileEdges = edges.filter((edge) => edge.to.startsWith("file:"));

    return {
      nodes: sortNodes(uniqueNodes(nodes)),
      edges: sortEdges(uniqueEdges(edges)),
      externalDependencies: sortExternalDependencies(
        uniqueExternalDependencies(externalDependencies),
      ),
      unresolvedDependencies: sortUnresolvedDependencies(
        uniqueUnresolvedDependencies(unresolvedDependencies),
      ),
      cycles: findFileCycles(fileEdges),
    };
  }
}

function normalizeFiles(files: readonly MainlineProjectGraphFileInput[]): NormalizedGraphFile[] {
  const byPath = new Map<string, NormalizedGraphFile>();
  for (const file of files) {
    const normalizedPath = normalizeMainlinePosixPath(file.path);
    if (!normalizedPath) {
      continue;
    }
    byPath.set(normalizedPath, {
      path: normalizedPath,
      content: file.content,
      ...(file.languageId === undefined ? {} : { languageId: file.languageId }),
      symbols: file.symbols ?? [],
      imports: file.imports ?? [],
    });
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeKnownFiles(
  knownFiles: readonly string[] | undefined,
  files: readonly NormalizedGraphFile[],
): string[] {
  return uniqueMainlinePosixPaths([...(knownFiles ?? []), ...files.map((file) => file.path)]);
}

function graphEdgeKindForImportRecord(
  record: MainlineImportRecord,
): Exclude<MainlineProjectGraphEdgeKind, "declares"> {
  switch (record.kind) {
    case "export":
      return "exports";
    case "commonjs":
      return "requires";
    case "dynamic":
      return "dynamic-import";
    default:
      return "imports";
  }
}

function normalizeUnresolvedTarget(fromPath: string, specifier: string): string {
  if (isLocalSpecifier(specifier)) {
    return normalizeMainlinePosixPath(path.posix.join(path.posix.dirname(fromPath), specifier));
  }
  return normalizeMainlinePosixPath(specifier);
}

function isLocalSpecifier(specifier: string): boolean {
  return (
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/")
  );
}

function fileNodeId(filePath: string): string {
  return `file:${filePath}`;
}

function symbolNodeId(filePath: string, symbolName: string): string {
  return `symbol:${filePath}#${symbolName}`;
}

function uniqueNodes(nodes: readonly MainlineProjectGraphNode[]): MainlineProjectGraphNode[] {
  return [...new Map(nodes.map((node) => [node.id, node])).values()];
}

function uniqueEdges(edges: readonly MainlineProjectGraphEdge[]): MainlineProjectGraphEdge[] {
  return [
    ...new Map(
      edges.map((edge) => [
        `${edge.from}\u0000${edge.to}\u0000${edge.kind}\u0000${edge.specifier ?? ""}`,
        edge,
      ]),
    ).values(),
  ];
}

function uniqueExternalDependencies(
  dependencies: readonly MainlineProjectGraphExternalDependency[],
): MainlineProjectGraphExternalDependency[] {
  return [
    ...new Map(
      dependencies.map((dependency) => [
        `${dependency.fromPath}\u0000${dependency.specifier}\u0000${dependency.kind}`,
        dependency,
      ]),
    ).values(),
  ];
}

function uniqueUnresolvedDependencies(
  dependencies: readonly MainlineProjectGraphUnresolvedDependency[],
): MainlineProjectGraphUnresolvedDependency[] {
  return [
    ...new Map(
      dependencies.map((dependency) => [
        `${dependency.fromPath}\u0000${dependency.specifier}\u0000${dependency.kind}`,
        dependency,
      ]),
    ).values(),
  ];
}

function sortNodes(nodes: readonly MainlineProjectGraphNode[]): MainlineProjectGraphNode[] {
  return [...nodes].sort((left, right) => left.id.localeCompare(right.id));
}

function sortEdges(edges: readonly MainlineProjectGraphEdge[]): MainlineProjectGraphEdge[] {
  return [...edges].sort(
    (left, right) =>
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to) ||
      left.kind.localeCompare(right.kind) ||
      (left.specifier ?? "").localeCompare(right.specifier ?? ""),
  );
}

function sortExternalDependencies(
  dependencies: readonly MainlineProjectGraphExternalDependency[],
): MainlineProjectGraphExternalDependency[] {
  return [...dependencies].sort(
    (left, right) =>
      left.fromPath.localeCompare(right.fromPath) ||
      left.specifier.localeCompare(right.specifier) ||
      left.kind.localeCompare(right.kind),
  );
}

function sortUnresolvedDependencies(
  dependencies: readonly MainlineProjectGraphUnresolvedDependency[],
): MainlineProjectGraphUnresolvedDependency[] {
  return [...dependencies].sort(
    (left, right) =>
      left.fromPath.localeCompare(right.fromPath) ||
      left.normalizedTarget.localeCompare(right.normalizedTarget) ||
      left.kind.localeCompare(right.kind),
  );
}

function findFileCycles(edges: readonly MainlineProjectGraphEdge[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const from = edge.from.slice("file:".length);
    const to = edge.to.slice("file:".length);
    adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
  }
  for (const [from, targets] of adjacency) {
    adjacency.set(from, [...new Set(targets)].sort());
  }

  const cycles = new Map<string, string[]>();
  const visit = (node: string, stack: string[], active: Set<string>): void => {
    if (active.has(node)) {
      const cycle = stack.slice(stack.indexOf(node));
      const canonical = canonicalizeCycle(cycle);
      cycles.set(canonical.join("\u0000"), canonical);
      return;
    }

    active.add(node);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      visit(next, stack, active);
    }
    stack.pop();
    active.delete(node);
  };

  for (const node of [...adjacency.keys()].sort()) {
    visit(node, [], new Set());
  }

  return [...cycles.values()].sort((left, right) =>
    left.join("\u0000").localeCompare(right.join("\u0000")),
  );
}

function canonicalizeCycle(cycle: readonly string[]): string[] {
  if (cycle.length === 0) {
    return [];
  }

  const rotations = cycle.map((_, index) => [...cycle.slice(index), ...cycle.slice(0, index)]);
  return (
    rotations.sort((left, right) => left.join("\u0000").localeCompare(right.join("\u0000")))[0] ??
    []
  );
}
